import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { user } from "../src/database/auth-schema.generated.js";
import { conversations, messages } from "../src/database/conversation-schema.js";
import { type AppDatabase, createDatabase } from "../src/database/database.js";
import { generations } from "../src/database/generation-schema.js";
import { workspaceMemberships, workspaces } from "../src/database/identity-schema.js";
import { migrateDatabase } from "../src/database/migrate.js";
import {
  modelCatalog,
  openRouterPrivacyAttestations,
  workspaceCostPolicies,
} from "../src/database/model-policy-schema.js";
import { createGenerationService } from "../src/generations/service.js";
import {
  workspaceBudgetConsumptionUsd,
  workspaceBudgetPeriod,
} from "../src/model-policy/budget-period.js";
import { createBudgetService } from "../src/model-policy/budget-service.js";
import {
  buildSimulatedCatalogSnapshot,
  type CatalogModelSnapshot,
  initialTierModels,
  type ModelTier,
  modelTiers,
  verifyPrivacyAttestation,
} from "../src/model-policy/catalog.js";
import {
  createModelPolicyService,
  ModelPolicyConflictError,
  ModelPolicyUnavailableError,
} from "../src/model-policy/service.js";
import { costControlTuning } from "../src/model-policy/settings.js";

function realCatalog(validatedAt: Date): Readonly<Record<ModelTier, CatalogModelSnapshot>> {
  return Object.freeze(
    Object.fromEntries(
      modelTiers.map((tier) => [
        tier,
        Object.freeze({
          available: true,
          canonicalSlug: initialTierModels[tier],
          completionPricePerToken: "0.000002",
          contextLength: 128_000,
          displayName: `Model ${tier}`,
          inputModalities: Object.freeze(["text"]),
          maximumOutputTokens: 8_192,
          metadataSource: "openrouter",
          modelId: initialTierModels[tier],
          outputModalities: Object.freeze(["text"]),
          promptPricePerToken: "0.000001",
          requestPriceUsd: "0",
          supportedParameters: Object.freeze(["max_tokens", "reasoning"]),
          validatedAt,
        }),
      ]),
    ) as Record<ModelTier, CatalogModelSnapshot>,
  );
}

const limits = Object.freeze({ balanced: 2_000, fast: 1_000, pro: 4_000 });
function verifiedPrivacyAttestation(verifiedAt: Date) {
  return verifyPrivacyAttestation({
    attestationVersion: "openrouter-privacy-v1",
    broadcastEnabled: false,
    dataDiscountLoggingEnabled: false,
    inputOutputLoggingEnabled: false,
    verifiedAt,
  });
}

const privacyAttestation = verifiedPrivacyAttestation(new Date("2026-08-08T12:00:00.000Z"));
const modelPolicyTestNow = new Date("2026-08-08T12:10:00.000Z");

function fixedModelPolicyService(database: AppDatabase) {
  return createModelPolicyService(database, {
    now: () => new Date(modelPolicyTestNow.getTime()),
  });
}

describe.sequential("model policy and budget persistence", () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let database: AppDatabase;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:18.4-alpine")
      .withDatabase("capstone_model_policy")
      .withUsername("capstone")
      .withPassword("capstone-test-password")
      .start();
    await migrateDatabase(container.getConnectionUri());
    pool = new Pool({ connectionString: container.getConnectionUri() });
    database = createDatabase(pool);
  });

  beforeEach(async () => {
    await pool.query(
      'TRUNCATE TABLE "generations", "drafts", "messages", "conversations", "workspace_memberships", "employee_approvals", "user", "workspaces", "model_catalog" RESTART IDENTITY CASCADE',
    );
  });

  afterAll(async () => {
    await pool.end();
    await container.stop();
  });

  async function insertWorkspace(identity: string, timezone: string): Promise<string> {
    const rows = await database
      .insert(workspaces)
      .values({ displayName: identity, identity, timezone })
      .returning({ id: workspaces.id });
    const id = rows[0]?.id;
    if (id === undefined) {
      throw new Error("Workspace insert failed");
    }
    return id;
  }

  it("rejects a simulated policy when the runtime is configured for OpenRouter", async () => {
    await insertWorkspace("runtime-policy", "America/Guayaquil");
    const service = fixedModelPolicyService(database);
    const validatedAt = new Date("2026-08-08T12:00:00.000Z");
    await service.bootstrap({
      catalog: Object.freeze(
        Object.fromEntries(
          modelTiers.map((tier) => [
            tier,
            buildSimulatedCatalogSnapshot(initialTierModels[tier], limits[tier], validatedAt),
          ]),
        ) as Record<ModelTier, CatalogModelSnapshot>,
      ),
      employeeActiveGenerationLimit: 2,
      maximumOutputTokens: limits,
      mode: "simulated",
      monthlyBudgetUsd: "100",
      privacyAttestation: null,
      reservationMarginBasisPoints: 2_000,
      workspaceIdentity: "runtime-policy",
    });

    await expect(service.assertRuntimeMode("simulated")).resolves.toBeUndefined();
    await expect(service.assertRuntimeMode("openrouter")).rejects.toBeInstanceOf(
      ModelPolicyUnavailableError,
    );
  });

  async function insertExpiredReservedGeneration(input: {
    readonly budgetPeriodEnd?: Date;
    readonly budgetPeriodStart?: Date;
    readonly reservationExpiresAt: Date;
    readonly reservedCostUsd?: string;
    readonly startedAt: Date;
    readonly userId: string;
    readonly workspaceId: string;
  }): Promise<{ readonly conversationId: string; readonly generationId: string }> {
    const conversationRows = await database
      .insert(conversations)
      .values({ userId: input.userId, workspaceId: input.workspaceId })
      .returning({ id: conversations.id });
    const conversationId = conversationRows[0]?.id;
    if (conversationId === undefined) {
      throw new Error("Conversation insert failed");
    }
    const userMessageRows = await database
      .insert(messages)
      .values({
        content: [{ text: "Pregunta", type: "text" }],
        conversationId,
        parentMessageId: null,
        role: "user",
      })
      .returning({ id: messages.id });
    const assistantRows = await database
      .insert(messages)
      .values({
        content: [{ text: "", type: "text" }],
        conversationId,
        parentMessageId: userMessageRows[0]?.id,
        role: "assistant",
      })
      .returning({ id: messages.id });
    const assistantMessageId = assistantRows[0]?.id;
    if (assistantMessageId === undefined) {
      throw new Error("Assistant insert failed");
    }
    const generationRows = await database
      .insert(generations)
      .values({
        accountingStatus: "reserved",
        assistantMessageId,
        budgetPeriodEnd: input.budgetPeriodEnd ?? new Date("2026-09-01T05:00:00.000Z"),
        budgetPeriodStart: input.budgetPeriodStart ?? new Date("2026-08-01T05:00:00.000Z"),
        completionPriceCeilingPerToken: "0.000002",
        conversationId,
        createdAt: input.startedAt,
        effectiveParameters: { maxTokens: 2_000 },
        estimatedInputTokens: 1_000n,
        idempotencyKey: randomUUID(),
        maximumOutputTokens: 2_000,
        promptPriceCeilingPerToken: "0.000001",
        purpose: "chat",
        requestPriceCeilingUsd: "0",
        requestedModel: initialTierModels.balanced,
        requestedTier: "balanced",
        reservationExpiresAt: input.reservationExpiresAt,
        reservationMarginBasisPoints: 0,
        reservedCostUsd: input.reservedCostUsd ?? "0.005",
        resolvedModel: initialTierModels.balanced,
        startedAt: input.startedAt,
        status: "active",
        systemPromptVersion: "capstone-chat-v1",
        updatedAt: input.startedAt,
        userId: input.userId,
        workspaceId: input.workspaceId,
      })
      .returning({ id: generations.id });
    const generationId = generationRows[0]?.id;
    if (generationId === undefined) {
      throw new Error("Generation insert failed");
    }
    return { conversationId, generationId };
  }

  it("keeps raw catalog prices global while applying each workspace margin at resolution", async () => {
    const firstWorkspaceId = await insertWorkspace("first-policy", "America/Guayaquil");
    const secondWorkspaceId = await insertWorkspace("second-policy", "America/New_York");
    const service = fixedModelPolicyService(database);
    const catalog = realCatalog(new Date("2026-08-08T12:00:00.000Z"));
    const firstInput = {
      catalog,
      employeeActiveGenerationLimit: 2,
      maximumOutputTokens: limits,
      mode: "openrouter" as const,
      monthlyBudgetUsd: "100",
      privacyAttestation,
      reservationMarginBasisPoints: 1_000,
      workspaceIdentity: "first-policy",
    };
    await expect(service.bootstrap(firstInput)).resolves.toEqual({
      repeated: false,
      workspaceId: firstWorkspaceId,
    });
    await expect(service.bootstrap(firstInput)).resolves.toMatchObject({ repeated: true });
    await expect(
      service.bootstrap({
        ...firstInput,
        privacyAttestation: verifyPrivacyAttestation({
          attestationVersion: "openrouter-privacy-v1",
          broadcastEnabled: false,
          dataDiscountLoggingEnabled: false,
          inputOutputLoggingEnabled: false,
          verifiedAt: new Date("2026-08-08T12:00:01.000Z"),
        }),
      }),
    ).rejects.toBeInstanceOf(ModelPolicyConflictError);
    await service.bootstrap({
      ...firstInput,
      reservationMarginBasisPoints: 5_000,
      workspaceIdentity: "second-policy",
    });

    const rows = await database.select().from(modelCatalog);
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map(({ promptPricePerToken }) => promptPricePerToken))).toEqual(
      new Set(["0.000001000000000000000000"]),
    );
    await expect(
      service.resolveTier(database, firstWorkspaceId, "balanced", "openrouter"),
    ).resolves.toMatchObject({
      completionPriceCeilingPerToken: "0.0000022",
      promptPriceCeilingPerToken: "0.0000011",
      requestPriceCeilingUsd: "0",
    });
    await expect(
      service.resolveTier(database, secondWorkspaceId, "balanced", "openrouter"),
    ).resolves.toMatchObject({
      completionPriceCeilingPerToken: "0.000003",
      promptPriceCeilingPerToken: "0.0000015",
    });
    await expect(
      service.bootstrap({ ...firstInput, monthlyBudgetUsd: "101" }),
    ).rejects.toBeInstanceOf(ModelPolicyConflictError);
    await expect(service.readEmployeeTierPolicy(firstWorkspaceId, "openrouter")).resolves.toEqual({
      defaultTier: "balanced",
      tiers: [
        { available: true, enabled: true, tier: "fast" },
        { available: true, enabled: true, tier: "balanced" },
        { available: true, enabled: true, tier: "pro" },
      ],
    });
  });

  it("fails closed when privacy verification expires and accepts only a fresh renewal", async () => {
    await insertWorkspace("privacy-boundary", "America/Guayaquil");
    await insertWorkspace("privacy-stale-bootstrap", "America/Guayaquil");
    await insertWorkspace("privacy-future-bootstrap", "America/Guayaquil");
    const initialVerifiedAt = privacyAttestation.verifiedAt;
    let currentTime = new Date(
      initialVerifiedAt.getTime() + costControlTuning.privacyAttestationLifetimeMs,
    );
    const service = createModelPolicyService(database, {
      now: () => new Date(currentTime.getTime()),
    });
    const inputFor = (workspaceIdentity: string, verifiedAt: Date) => ({
      catalog: realCatalog(initialVerifiedAt),
      employeeActiveGenerationLimit: 2,
      maximumOutputTokens: limits,
      mode: "openrouter" as const,
      monthlyBudgetUsd: "100",
      privacyAttestation: verifiedPrivacyAttestation(verifiedAt),
      reservationMarginBasisPoints: 2_000,
      workspaceIdentity,
    });

    await expect(
      service.bootstrap({
        ...inputFor("privacy-stale-bootstrap", initialVerifiedAt),
        privacyAttestation: verifiedPrivacyAttestation(new Date(initialVerifiedAt.getTime() - 1)),
      }),
    ).rejects.toBeInstanceOf(ModelPolicyConflictError);
    await expect(
      service.bootstrap(inputFor("privacy-future-bootstrap", new Date(currentTime.getTime() + 1))),
    ).rejects.toBeInstanceOf(ModelPolicyConflictError);
    expect(await database.select().from(workspaceCostPolicies)).toEqual([]);

    const bootstrap = await service.bootstrap(inputFor("privacy-boundary", initialVerifiedAt));
    await expect(service.assertRuntimeMode("openrouter")).resolves.toBeUndefined();
    await expect(
      service.resolveTier(database, bootstrap.workspaceId, "balanced", "openrouter"),
    ).resolves.toMatchObject({ tier: "balanced" });
    await expect(
      service.readEmployeeTierPolicy(bootstrap.workspaceId, "openrouter"),
    ).resolves.toEqual({
      defaultTier: "balanced",
      tiers: [
        { available: true, enabled: true, tier: "fast" },
        { available: true, enabled: true, tier: "balanced" },
        { available: true, enabled: true, tier: "pro" },
      ],
    });

    currentTime = new Date(currentTime.getTime() + 1);
    await expect(service.assertRuntimeMode("openrouter")).rejects.toBeInstanceOf(
      ModelPolicyUnavailableError,
    );
    await expect(
      service.resolveTier(database, bootstrap.workspaceId, "balanced", "openrouter"),
    ).rejects.toBeInstanceOf(ModelPolicyUnavailableError);
    expect(
      (await service.readEmployeeTierPolicy(bootstrap.workspaceId, "openrouter")).tiers,
    ).toEqual([
      { available: false, enabled: true, tier: "fast" },
      { available: false, enabled: true, tier: "balanced" },
      { available: false, enabled: true, tier: "pro" },
    ]);

    await expect(
      service.attestPrivacy(
        "privacy-boundary",
        verifiedPrivacyAttestation(new Date(currentTime.getTime() + 1)),
      ),
    ).rejects.toBeInstanceOf(ModelPolicyConflictError);
    const renewedAttestation = verifiedPrivacyAttestation(new Date(currentTime.getTime() - 1_000));
    await expect(service.attestPrivacy("privacy-boundary", renewedAttestation)).resolves.toEqual({
      repeated: false,
      workspaceId: bootstrap.workspaceId,
    });
    await expect(
      service.attestPrivacy(
        "privacy-boundary",
        verifiedPrivacyAttestation(new Date(currentTime.getTime() - 2_000)),
      ),
    ).rejects.toBeInstanceOf(ModelPolicyConflictError);
    await expect(service.attestPrivacy("privacy-boundary", renewedAttestation)).resolves.toEqual({
      repeated: true,
      workspaceId: bootstrap.workspaceId,
    });
    expect(await database.select().from(openRouterPrivacyAttestations)).toEqual([
      expect.objectContaining({ verifiedAt: renewedAttestation.verifiedAt }),
    ]);
    await expect(service.assertRuntimeMode("openrouter")).resolves.toBeUndefined();
    await expect(
      service.resolveTier(database, bootstrap.workspaceId, "balanced", "openrouter"),
    ).resolves.toMatchObject({ tier: "balanced" });
  });

  it("marks an unapproved mapped tier unavailable and refuses to resolve it", async () => {
    const workspaceId = await insertWorkspace("revoked-catalog-approval", "America/Guayaquil");
    const service = fixedModelPolicyService(database);
    await service.bootstrap({
      catalog: realCatalog(new Date("2026-08-08T12:00:00.000Z")),
      employeeActiveGenerationLimit: 2,
      maximumOutputTokens: limits,
      mode: "openrouter",
      monthlyBudgetUsd: "100",
      privacyAttestation,
      reservationMarginBasisPoints: 2_000,
      workspaceIdentity: "revoked-catalog-approval",
    });
    await database
      .update(modelCatalog)
      .set({ approved: false })
      .where(eq(modelCatalog.openRouterModelId, initialTierModels.balanced));

    await expect(service.readEmployeeTierPolicy(workspaceId, "openrouter")).resolves.toEqual({
      defaultTier: "balanced",
      tiers: [
        { available: true, enabled: true, tier: "fast" },
        { available: false, enabled: true, tier: "balanced" },
        { available: true, enabled: true, tier: "pro" },
      ],
    });
    await expect(
      service.resolveTier(database, workspaceId, "balanced", "openrouter"),
    ).rejects.toBeInstanceOf(ModelPolicyUnavailableError);
  });

  it("derives workspace-local monthly boundaries across daylight-saving changes", async () => {
    const guayaquilId = await insertWorkspace("period-guayaquil", "America/Guayaquil");
    const newYorkId = await insertWorkspace("period-new-york", "America/New_York");
    const at = new Date("2026-03-20T12:00:00.000Z");
    const guayaquil = await workspaceBudgetPeriod(database, guayaquilId, at);
    const newYork = await workspaceBudgetPeriod(database, newYorkId, at);
    expect(guayaquil?.start.toISOString()).toBe("2026-03-01T05:00:00.000Z");
    expect(guayaquil?.end.toISOString()).toBe("2026-04-01T05:00:00.000Z");
    expect(newYork?.start.toISOString()).toBe("2026-03-01T05:00:00.000Z");
    expect(newYork?.end.toISOString()).toBe("2026-04-01T04:00:00.000Z");

    const userId = `period-user-${randomUUID()}`;
    await database.insert(user).values({
      email: "period@example.test",
      emailVerified: true,
      id: userId,
      name: "Period User",
    });
    await database.insert(workspaceMemberships).values({
      role: "member",
      status: "active",
      userId,
      workspaceId: guayaquilId,
    });
    await insertExpiredReservedGeneration({
      budgetPeriodEnd: new Date("2026-08-01T05:00:00.000Z"),
      budgetPeriodStart: new Date("2026-07-01T05:00:00.000Z"),
      reservationExpiresAt: new Date("2026-07-15T12:05:00.000Z"),
      reservedCostUsd: "0.007",
      startedAt: new Date("2026-07-15T12:00:00.000Z"),
      userId,
      workspaceId: guayaquilId,
    });
    await insertExpiredReservedGeneration({
      budgetPeriodEnd: new Date("2026-09-01T05:00:00.000Z"),
      budgetPeriodStart: new Date("2026-08-01T05:00:00.000Z"),
      reservationExpiresAt: new Date("2026-08-15T12:05:00.000Z"),
      reservedCostUsd: "0.011",
      startedAt: new Date("2026-08-15T12:00:00.000Z"),
      userId,
      workspaceId: guayaquilId,
    });
    const august = await workspaceBudgetPeriod(
      database,
      guayaquilId,
      new Date("2026-08-20T12:00:00.000Z"),
    );
    if (august === null) {
      throw new Error("August budget period was not resolved");
    }
    await expect(workspaceBudgetConsumptionUsd(database, guayaquilId, august)).resolves.toBe(
      "0.011",
    );
  });

  it("retains late provider metadata for cancelled reservations until settlement", async () => {
    const workspaceId = await insertWorkspace("late-cancellation-metadata", "America/Guayaquil");
    const userId = `user-${randomUUID()}`;
    await database.insert(user).values({
      email: "late-metadata@example.test",
      emailVerified: true,
      id: userId,
      name: "Late Metadata User",
    });
    await database.insert(workspaceMemberships).values({
      role: "member",
      status: "active",
      userId,
      workspaceId,
    });
    const startedAt = new Date("2026-08-08T12:00:00.000Z");
    const completedAt = new Date("2026-08-08T12:01:00.000Z");
    const { generationId } = await insertExpiredReservedGeneration({
      reservationExpiresAt: new Date("2026-08-08T12:05:00.000Z"),
      startedAt,
      userId,
      workspaceId,
    });
    await database
      .update(generations)
      .set({
        completedAt,
        status: "cancelled",
        terminalReason: "cancelled",
        updatedAt: completedAt,
      })
      .where(eq(generations.id, generationId));
    const service = createGenerationService(database);
    const metadata = {
      provider: "provider-after-cancellation",
      providerGenerationId: "generation-after-cancellation",
      resolvedModel: "resolved/model-after-cancellation",
    } as const;

    await expect(service.recordProviderMetadata(generationId, metadata)).resolves.toBe(true);
    expect(
      (await database.select().from(generations).where(eq(generations.id, generationId)))[0],
    ).toMatchObject({
      accountingStatus: "reserved",
      openRouterGenerationId: metadata.providerGenerationId,
      provider: metadata.provider,
      resolvedModel: metadata.resolvedModel,
      status: "cancelled",
    });

    await expect(
      createBudgetService(database).reconcileExpiredOnce(new Date("2026-08-08T12:10:00.000Z")),
    ).resolves.toEqual({ inspected: 1, settled: 1, terminalized: 0 });
    await expect(
      service.recordProviderMetadata(generationId, {
        providerGenerationId: "must-not-replace-settled-accounting",
      }),
    ).resolves.toBe(false);
    expect(
      (await database.select().from(generations).where(eq(generations.id, generationId)))[0],
    ).toMatchObject({
      accountingStatus: "estimated",
      openRouterGenerationId: metadata.providerGenerationId,
      status: "cancelled",
    });
  });

  it("reserves exactly, settles authoritative cost, and reconciles expiry without lock inversion", async () => {
    const workspaceId = await insertWorkspace("budget-lifecycle", "America/Guayaquil");
    const userId = `user-${randomUUID()}`;
    await database.insert(user).values({
      email: "budget@example.test",
      emailVerified: true,
      id: userId,
      name: "Budget User",
    });
    await database.insert(workspaceMemberships).values({
      role: "member",
      status: "active",
      userId,
      workspaceId,
    });
    const policyService = fixedModelPolicyService(database);
    await policyService.bootstrap({
      catalog: realCatalog(new Date("2026-08-08T12:00:00.000Z")),
      employeeActiveGenerationLimit: 2,
      maximumOutputTokens: limits,
      mode: "openrouter",
      monthlyBudgetUsd: "100",
      privacyAttestation,
      reservationMarginBasisPoints: 0,
      workspaceIdentity: "budget-lifecycle",
    });

    const conversationRows = await database
      .insert(conversations)
      .values({ userId, workspaceId })
      .returning({ id: conversations.id });
    const conversationId = conversationRows[0]?.id;
    if (conversationId === undefined) {
      throw new Error("Conversation insert failed");
    }
    const userMessageRows = await database
      .insert(messages)
      .values({
        content: [{ text: "Pregunta", type: "text" }],
        conversationId,
        parentMessageId: null,
        role: "user",
      })
      .returning({ id: messages.id });
    const assistantRows = await database
      .insert(messages)
      .values({
        content: [{ text: "", type: "text" }],
        conversationId,
        parentMessageId: userMessageRows[0]?.id,
        role: "assistant",
      })
      .returning({ id: messages.id });
    const assistantMessageId = assistantRows[0]?.id;
    if (assistantMessageId === undefined) {
      throw new Error("Assistant insert failed");
    }

    const budget = createBudgetService(database);
    const startedAt = new Date();
    const generationId = await database.transaction(async (transaction) => {
      const admission = await budget.lockAdmission(transaction, workspaceId, userId, startedAt);
      const policy = await policyService.resolveTier(
        transaction,
        workspaceId,
        "balanced",
        "openrouter",
      );
      const reservation = budget.reserveResolvedTier(admission, policy, 1_000n, startedAt);
      expect(reservation.reservedCostUsd).toBe("0.005");
      const inserted = await transaction
        .insert(generations)
        .values({
          assistantMessageId,
          budgetPeriodEnd: reservation.budgetPeriodEnd,
          budgetPeriodStart: reservation.budgetPeriodStart,
          completionPriceCeilingPerToken: reservation.completionPriceCeilingPerToken,
          conversationId,
          createdAt: startedAt,
          effectiveParameters: { maxTokens: 2_000 },
          estimatedInputTokens: reservation.estimatedInputTokens,
          idempotencyKey: randomUUID(),
          maximumOutputTokens: reservation.maximumOutputTokens,
          promptPriceCeilingPerToken: reservation.promptPriceCeilingPerToken,
          purpose: "chat",
          requestPriceCeilingUsd: reservation.requestPriceCeilingUsd,
          requestedModel: initialTierModels.balanced,
          requestedTier: "balanced",
          reservationExpiresAt: reservation.reservationExpiresAt,
          reservationMarginBasisPoints: reservation.reservationMarginBasisPoints,
          reservedCostUsd: reservation.reservedCostUsd,
          resolvedModel: initialTierModels.balanced,
          startedAt,
          status: "active",
          systemPromptVersion: "capstone-chat-v1",
          updatedAt: startedAt,
          userId,
          workspaceId,
          accountingStatus: "reserved",
        })
        .returning({ id: generations.id });
      const id = inserted[0]?.id;
      if (id === undefined) {
        throw new Error("Generation insert failed");
      }
      return id;
    });

    await database
      .update(generations)
      .set({ openRouterGenerationId: "generation-provider-id", provider: "provider-a" })
      .where(eq(generations.id, generationId));
    await expect(
      database.transaction((transaction) =>
        budget.lockAdmission(transaction, workspaceId, userId, startedAt),
      ),
    ).resolves.toMatchObject({ consumedUsd: "0.005" });
    await expect(
      budget.settleAuthoritativeUsage(generationId, {
        completionTokens: 50,
        costUsd: "0.0042",
        promptTokens: 900,
      }),
    ).resolves.toBe(true);
    expect(
      (await database.select().from(generations).where(eq(generations.id, generationId)))[0],
    ).toMatchObject({
      accountingStatus: "actual",
      costBasis: "actual",
      costUsd: "0.004200000000000000",
      openRouterGenerationId: "generation-provider-id",
      provider: "provider-a",
    });
    await expect(
      database.transaction((transaction) =>
        budget.lockAdmission(transaction, workspaceId, userId, startedAt),
      ),
    ).resolves.toMatchObject({ consumedUsd: "0.0042" });

    await database
      .update(generations)
      .set({
        accountingSettledAt: null,
        accountingStatus: "reserved",
        completionTokens: null,
        costBasis: null,
        costUsd: null,
        promptTokens: null,
      })
      .where(eq(generations.id, generationId));
    await expect(
      budget.settleAuthoritativeUsage(generationId, {
        completionTokens: 55,
        costUsd: "0.006",
        promptTokens: 950,
      }),
    ).resolves.toBe(true);
    await expect(
      database.transaction((transaction) =>
        budget.lockAdmission(transaction, workspaceId, userId, startedAt),
      ),
    ).resolves.toMatchObject({ consumedUsd: "0.006" });
    await database
      .update(generations)
      .set({
        accountingSettledAt: null,
        accountingStatus: "reserved",
        completionTokens: null,
        costBasis: null,
        costUsd: null,
        promptTokens: null,
      })
      .where(eq(generations.id, generationId));
    await expect(
      budget.reconcileExpiredOnce(new Date(startedAt.getTime() + 6 * 60 * 1_000)),
    ).resolves.toEqual({ inspected: 1, settled: 1, terminalized: 1 });
    expect(
      (await database.select().from(generations).where(eq(generations.id, generationId)))[0],
    ).toMatchObject({
      accountingStatus: "estimated",
      costBasis: "estimated",
      costUsd: "0.005000000000000000",
      errorCode: "STREAM_INTERRUPTED",
      status: "incomplete",
    });
  });

  it("lets concurrent reconcilers advance to disjoint batches and settle each row once", async () => {
    const workspaceId = await insertWorkspace("concurrent-reconciliation", "America/Guayaquil");
    const userId = `user-${randomUUID()}`;
    await database.insert(user).values({
      email: "reconciliation@example.test",
      emailVerified: true,
      id: userId,
      name: "Reconciliation User",
    });
    await database.insert(workspaceMemberships).values({
      role: "member",
      status: "active",
      userId,
      workspaceId,
    });

    const startedAt = new Date("2026-08-08T12:00:00.000Z");
    const fixtures = [];
    for (let index = 0; index < 6; index += 1) {
      fixtures.push(
        await insertExpiredReservedGeneration({
          reservationExpiresAt: new Date(startedAt.getTime() + 5 * 60 * 1_000 + index),
          startedAt,
          userId,
          workspaceId,
        }),
      );
    }

    const lockClient = await pool.connect();
    await lockClient.query("BEGIN");
    await lockClient.query(
      `SELECT id
         FROM conversations
        WHERE id = ANY($1::uuid[])
        ORDER BY id
        FOR UPDATE`,
      [fixtures.slice(0, 2).map(({ conversationId }) => conversationId)],
    );
    const firstSettledAt = new Date("2026-08-08T12:10:00.000Z");
    const secondSettledAt = new Date("2026-08-08T12:10:01.000Z");
    const budget = createBudgetService(database);
    const concurrentResults = await (async () => {
      try {
        return await Promise.all([
          budget.reconcileExpiredOnce(firstSettledAt, 2),
          budget.reconcileExpiredOnce(secondSettledAt, 2),
        ]);
      } finally {
        await lockClient.query("ROLLBACK");
        lockClient.release();
      }
    })();

    expect(concurrentResults.map(({ settled }) => settled).sort()).toEqual([2, 2]);
    expect(concurrentResults.map(({ terminalized }) => terminalized).sort()).toEqual([2, 2]);
    const afterConcurrentPasses = await database.select().from(generations);
    expect(
      afterConcurrentPasses.filter(({ accountingStatus }) => accountingStatus === "estimated"),
    ).toHaveLength(4);
    expect(
      afterConcurrentPasses.filter(
        ({ accountingSettledAt }) => accountingSettledAt?.getTime() === firstSettledAt.getTime(),
      ),
    ).toHaveLength(2);
    expect(
      afterConcurrentPasses.filter(
        ({ accountingSettledAt }) => accountingSettledAt?.getTime() === secondSettledAt.getTime(),
      ),
    ).toHaveLength(2);
    expect(
      afterConcurrentPasses.filter(({ accountingStatus }) => accountingStatus === "reserved"),
    ).toHaveLength(2);

    await expect(
      budget.reconcileExpiredOnce(new Date("2026-08-08T12:10:02.000Z"), 2),
    ).resolves.toMatchObject({ settled: 2, terminalized: 2 });
    await expect(
      budget.reconcileExpiredOnce(new Date("2026-08-08T12:10:03.000Z"), 2),
    ).resolves.toEqual({ inspected: 0, settled: 0, terminalized: 0 });
    expect(
      (await database.select().from(generations)).filter(
        ({ accountingStatus }) => accountingStatus === "estimated",
      ),
    ).toHaveLength(6);
  });
});

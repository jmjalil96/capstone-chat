import { randomUUID } from "node:crypto";
import type { AdminUpdateModelPolicyRequest } from "@capstone/protocol";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { and, eq } from "drizzle-orm";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createCursorCodec } from "../src/conversations/cursor.js";
import { user } from "../src/database/auth-schema.generated.js";
import { conversations, messages } from "../src/database/conversation-schema.js";
import { type AppDatabase, createDatabase } from "../src/database/database.js";
import { generations } from "../src/database/generation-schema.js";
import { workspaceMemberships, workspaces } from "../src/database/identity-schema.js";
import { migrateDatabase } from "../src/database/migrate.js";
import {
  modelCatalog,
  openRouterPrivacyAttestations,
  workspaceCatalogApprovals,
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
  CatalogRefreshActiveError,
  createModelPolicyService,
  ModelPolicyChangedError,
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
    cursorCodec: createCursorCodec(
      "model-policy-administration-test-secret-with-sufficient-length",
    ),
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

  function catalogFixture(
    modelId: string,
    source: "openrouter" | "simulated" = "openrouter",
  ): CatalogModelSnapshot {
    return Object.freeze({
      available: true,
      canonicalSlug: modelId,
      completionPricePerToken: source === "simulated" ? "0" : "0.000002",
      contextLength: 128_000,
      displayName: `Model ${modelId}`,
      inputModalities: Object.freeze(["text"]),
      maximumOutputTokens: 8_192,
      metadataSource: source,
      modelId,
      outputModalities: Object.freeze(["text"]),
      promptPricePerToken: source === "simulated" ? "0" : "0.000001",
      requestPriceUsd: "0",
      supportedParameters: Object.freeze(["max_tokens", "reasoning"]),
      validatedAt: new Date("2026-08-08T12:00:00.000Z"),
    });
  }

  async function insertApprovedCatalogFixtures(
    workspaceId: string,
    count: number,
  ): Promise<readonly { readonly id: string; readonly modelId: string }[]> {
    const createdAt = new Date("2026-08-08T12:00:00.000Z");
    const inserted = await database
      .insert(modelCatalog)
      .values(
        Array.from({ length: count }, (_, index) => {
          const snapshot = catalogFixture(`fixture/model-${index.toString().padStart(3, "0")}`);
          return {
            available: snapshot.available,
            canonicalSlug: snapshot.canonicalSlug,
            completionPricePerToken: snapshot.completionPricePerToken,
            contextLength: snapshot.contextLength,
            createdAt,
            displayName: snapshot.displayName,
            inputModalities: snapshot.inputModalities,
            maximumOutputTokens: snapshot.maximumOutputTokens,
            metadataSource: snapshot.metadataSource,
            openRouterModelId: snapshot.modelId,
            outputModalities: snapshot.outputModalities,
            promptPricePerToken: snapshot.promptPricePerToken,
            requestPriceUsd: snapshot.requestPriceUsd,
            supportedParameters: snapshot.supportedParameters,
            updatedAt: createdAt,
            validatedAt: snapshot.validatedAt,
          };
        }),
      )
      .returning({ id: modelCatalog.id, modelId: modelCatalog.openRouterModelId });
    await database
      .insert(workspaceCatalogApprovals)
      .values(inserted.map(({ id }) => ({ createdAt, modelCatalogId: id, workspaceId })));
    return inserted;
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
    const catalogRows = await database
      .select({ id: modelCatalog.id })
      .from(modelCatalog)
      .where(eq(modelCatalog.openRouterModelId, initialTierModels.balanced));
    const catalogId = catalogRows[0]?.id;
    if (catalogId === undefined) {
      throw new Error("Mapped catalog row is unavailable");
    }
    await database
      .delete(workspaceCatalogApprovals)
      .where(
        and(
          eq(workspaceCatalogApprovals.workspaceId, workspaceId),
          eq(workspaceCatalogApprovals.modelCatalogId, catalogId),
        ),
      );

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

  it("keeps catalog approval workspace-scoped and paginates the curated list", async () => {
    const firstWorkspaceId = await insertWorkspace("catalog-admin-first", "America/Guayaquil");
    const secondWorkspaceId = await insertWorkspace("catalog-admin-second", "America/Guayaquil");
    const service = fixedModelPolicyService(database);
    const approved = await service.approveCatalogSnapshot(
      firstWorkspaceId,
      "openrouter",
      catalogFixture("approved/exact-model"),
    );
    expect(approved).toMatchObject({
      available: true,
      modelId: "approved/exact-model",
    });
    await database
      .update(modelCatalog)
      .set({
        refreshAttemptedAt: new Date("2026-08-08T12:11:00.000Z"),
        updatedAt: new Date("2026-08-08T12:11:00.000Z"),
      })
      .where(eq(modelCatalog.id, approved.catalogId));
    const laterService = createModelPolicyService(database, {
      cursorCodec: createCursorCodec(
        "model-policy-administration-test-secret-with-sufficient-length",
      ),
      now: () => new Date("2026-08-08T12:20:00.000Z"),
    });
    await expect(
      laterService.approveCatalogSnapshot(firstWorkspaceId, "openrouter", {
        ...catalogFixture("approved/exact-model"),
        validatedAt: new Date("2026-08-08T12:19:00.000Z"),
      }),
    ).resolves.toMatchObject({ catalogId: approved.catalogId });
    await insertApprovedCatalogFixtures(firstWorkspaceId, 51);

    const firstPage = await service.listAdminCatalog(firstWorkspaceId);
    expect(firstPage.items).toHaveLength(50);
    expect(firstPage.nextCursor).not.toBeNull();
    expect(firstPage.items.map(({ modelId }) => modelId)).toEqual(
      [...firstPage.items.map(({ modelId }) => modelId)].sort(),
    );
    if (firstPage.nextCursor === null) {
      throw new Error("Expected a second catalog page");
    }
    const secondPage = await service.listAdminCatalog(firstWorkspaceId, firstPage.nextCursor);
    expect(secondPage.items).toHaveLength(2);
    expect(secondPage.nextCursor).toBeNull();
    await expect(service.listAdminCatalog(secondWorkspaceId)).resolves.toEqual({
      items: [],
      nextCursor: null,
    });
    await expect(
      service.listAdminCatalog(secondWorkspaceId, firstPage.nextCursor),
    ).rejects.toMatchObject({ code: "INVALID_CURSOR" });
  });

  it("claims manual refreshes in atomic workspace-bounded batches", async () => {
    const workspaceId = await insertWorkspace("catalog-refresh-admin", "America/Guayaquil");
    const rows = await insertApprovedCatalogFixtures(workspaceId, 51);
    const liveLease = rows.find(({ modelId }) => modelId === "fixture/model-010");
    if (liveLease === undefined) {
      throw new Error("Refresh lease fixture is unavailable");
    }
    const existingOwner = randomUUID();
    await database
      .update(modelCatalog)
      .set({
        refreshLeaseExpiresAt: new Date("2026-08-08T12:11:00.000Z"),
        refreshLeaseOwner: existingOwner,
      })
      .where(eq(modelCatalog.id, liveLease.id));
    const service = fixedModelPolicyService(database);

    await expect(
      service.claimAdminCatalogRefresh(workspaceId, "openrouter", randomUUID(), null),
    ).rejects.toBeInstanceOf(CatalogRefreshActiveError);
    expect(
      (await database.select().from(modelCatalog)).filter(
        ({ refreshLeaseOwner }) => refreshLeaseOwner !== null,
      ),
    ).toEqual([expect.objectContaining({ id: liveLease.id, refreshLeaseOwner: existingOwner })]);

    await database
      .update(modelCatalog)
      .set({ refreshLeaseExpiresAt: null, refreshLeaseOwner: null })
      .where(eq(modelCatalog.id, liveLease.id));
    const firstClaim = await service.claimAdminCatalogRefresh(
      workspaceId,
      "openrouter",
      randomUUID(),
      null,
    );
    expect(firstClaim.modelIds).toHaveLength(50);
    expect(firstClaim.nextCursor).not.toBeNull();
    await expect(service.releaseCatalogRefresh(firstClaim)).resolves.toBe(50);
    if (firstClaim.nextCursor === null) {
      throw new Error("Expected a second refresh page");
    }
    const secondClaim = await service.claimAdminCatalogRefresh(
      workspaceId,
      "openrouter",
      randomUUID(),
      firstClaim.nextCursor,
    );
    expect(secondClaim.modelIds).toHaveLength(1);
    expect(secondClaim.nextCursor).toBeNull();
    await expect(service.releaseCatalogRefresh(secondClaim)).resolves.toBe(1);
  });

  it("applies revisioned policy changes while tolerating unchanged unavailable mappings", async () => {
    const workspaceId = await insertWorkspace("policy-administration", "America/Guayaquil");
    const service = fixedModelPolicyService(database);
    await service.bootstrap({
      catalog: Object.freeze(
        Object.fromEntries(
          modelTiers.map((tier) => [
            tier,
            buildSimulatedCatalogSnapshot(
              initialTierModels[tier],
              limits[tier],
              modelPolicyTestNow,
            ),
          ]),
        ) as Record<ModelTier, CatalogModelSnapshot>,
      ),
      employeeActiveGenerationLimit: 2,
      maximumOutputTokens: limits,
      mode: "simulated",
      monthlyBudgetUsd: "100",
      privacyAttestation: null,
      reservationMarginBasisPoints: 2_000,
      workspaceIdentity: "policy-administration",
    });
    const initial = await service.readAdminPolicy(workspaceId, "simulated");
    expect(initial).toMatchObject({
      currency: "USD",
      defaultTier: "balanced",
      monthlyBudgetUsd: "100",
      revision: 1,
    });
    expect(initial.tiers.map(({ available, tier }) => ({ available, tier }))).toEqual([
      { available: true, tier: "fast" },
      { available: true, tier: "balanced" },
      { available: true, tier: "pro" },
    ]);

    await database
      .update(modelCatalog)
      .set({ available: false })
      .where(eq(modelCatalog.id, initial.tiers[1].catalogId));
    const changed = await service.replaceAdminPolicy(workspaceId, "simulated", {
      defaultTier: "fast",
      monthlyBudgetUsd: "101",
      observedRevision: initial.revision,
      tiers: [
        {
          catalogId: initial.tiers[0].catalogId,
          enabled: true,
          maximumOutputTokens: initial.tiers[0].maximumOutputTokens,
          tier: "fast",
        },
        {
          catalogId: initial.tiers[1].catalogId,
          enabled: true,
          maximumOutputTokens: initial.tiers[1].maximumOutputTokens,
          tier: "balanced",
        },
        {
          catalogId: initial.tiers[2].catalogId,
          enabled: false,
          maximumOutputTokens: initial.tiers[2].maximumOutputTokens,
          tier: "pro",
        },
      ],
    });
    expect(changed).toMatchObject({ defaultTier: "fast", revision: 2 });
    expect(changed.tiers[1]?.available).toBe(false);

    await expect(
      service.replaceAdminPolicy(workspaceId, "simulated", {
        defaultTier: "fast",
        monthlyBudgetUsd: "102",
        observedRevision: initial.revision,
        tiers: changed.tiers.map(({ catalogId, enabled, maximumOutputTokens, tier }) => ({
          catalogId,
          enabled,
          maximumOutputTokens,
          tier,
        })) as typeof initial.tiers,
      }),
    ).rejects.toBeInstanceOf(ModelPolicyChangedError);

    const decreased = await service.replaceAdminPolicy(workspaceId, "simulated", {
      defaultTier: "fast",
      monthlyBudgetUsd: "102",
      observedRevision: changed.revision,
      tiers: [
        {
          catalogId: changed.tiers[0].catalogId,
          enabled: true,
          maximumOutputTokens: changed.tiers[0].maximumOutputTokens,
          tier: "fast",
        },
        {
          catalogId: changed.tiers[1].catalogId,
          enabled: true,
          maximumOutputTokens: changed.tiers[1].maximumOutputTokens - 1,
          tier: "balanced",
        },
        {
          catalogId: changed.tiers[2].catalogId,
          enabled: false,
          maximumOutputTokens: changed.tiers[2].maximumOutputTokens,
          tier: "pro",
        },
      ],
    });
    expect(decreased).toMatchObject({ monthlyBudgetUsd: "102", revision: 3 });

    const unchangedTiers: AdminUpdateModelPolicyRequest["tiers"] = [
      {
        catalogId: decreased.tiers[0].catalogId,
        enabled: decreased.tiers[0].enabled,
        maximumOutputTokens: decreased.tiers[0].maximumOutputTokens,
        tier: "fast",
      },
      {
        catalogId: decreased.tiers[1].catalogId,
        enabled: decreased.tiers[1].enabled,
        maximumOutputTokens: decreased.tiers[1].maximumOutputTokens,
        tier: "balanced",
      },
      {
        catalogId: decreased.tiers[2].catalogId,
        enabled: decreased.tiers[2].enabled,
        maximumOutputTokens: decreased.tiers[2].maximumOutputTokens,
        tier: "pro",
      },
    ];
    await expect(
      service.replaceAdminPolicy(workspaceId, "simulated", {
        defaultTier: "balanced",
        monthlyBudgetUsd: decreased.monthlyBudgetUsd,
        observedRevision: decreased.revision,
        tiers: unchangedTiers,
      }),
    ).rejects.toBeInstanceOf(ModelPolicyConflictError);
    await expect(
      service.replaceAdminPolicy(workspaceId, "simulated", {
        defaultTier: decreased.defaultTier,
        monthlyBudgetUsd: decreased.monthlyBudgetUsd,
        observedRevision: decreased.revision,
        tiers: [
          unchangedTiers[0],
          {
            ...unchangedTiers[1],
            maximumOutputTokens: unchangedTiers[1].maximumOutputTokens + 1,
          },
          unchangedTiers[2],
        ],
      }),
    ).rejects.toBeInstanceOf(ModelPolicyConflictError);
    await database
      .update(modelCatalog)
      .set({ available: false })
      .where(eq(modelCatalog.id, unchangedTiers[2].catalogId));
    await expect(
      service.replaceAdminPolicy(workspaceId, "simulated", {
        defaultTier: decreased.defaultTier,
        monthlyBudgetUsd: decreased.monthlyBudgetUsd,
        observedRevision: decreased.revision,
        tiers: [unchangedTiers[0], unchangedTiers[1], { ...unchangedTiers[2], enabled: true }],
      }),
    ).rejects.toBeInstanceOf(ModelPolicyConflictError);
    await expect(
      service.replaceAdminPolicy(workspaceId, "simulated", {
        defaultTier: decreased.defaultTier,
        monthlyBudgetUsd: decreased.monthlyBudgetUsd,
        observedRevision: decreased.revision,
        tiers: [
          { ...unchangedTiers[0], catalogId: unchangedTiers[1].catalogId },
          unchangedTiers[1],
          unchangedTiers[2],
        ],
      }),
    ).rejects.toBeInstanceOf(ModelPolicyConflictError);
    await expect(service.readAdminPolicy(workspaceId, "simulated")).resolves.toMatchObject({
      revision: 3,
    });
  });

  it("rejects a hard-budget decrease below current reservations without a partial write", async () => {
    const workspaceId = await insertWorkspace("budget-administration", "America/Guayaquil");
    const userId = `budget-admin-user-${randomUUID()}`;
    await database.insert(user).values({
      email: "budget-admin@example.test",
      emailVerified: true,
      id: userId,
      name: "Budget Employee",
    });
    await database.insert(workspaceMemberships).values({
      role: "member",
      status: "active",
      userId,
      workspaceId,
    });
    const service = fixedModelPolicyService(database);
    await service.bootstrap({
      catalog: Object.freeze(
        Object.fromEntries(
          modelTiers.map((tier) => [
            tier,
            buildSimulatedCatalogSnapshot(
              initialTierModels[tier],
              limits[tier],
              modelPolicyTestNow,
            ),
          ]),
        ) as Record<ModelTier, CatalogModelSnapshot>,
      ),
      employeeActiveGenerationLimit: 2,
      maximumOutputTokens: limits,
      mode: "simulated",
      monthlyBudgetUsd: "100",
      privacyAttestation: null,
      reservationMarginBasisPoints: 2_000,
      workspaceIdentity: "budget-administration",
    });
    await insertExpiredReservedGeneration({
      reservationExpiresAt: new Date("2026-08-08T12:20:00.000Z"),
      reservedCostUsd: "10",
      startedAt: new Date("2026-08-08T12:00:00.000Z"),
      userId,
      workspaceId,
    });
    const policy = await service.readAdminPolicy(workspaceId, "simulated");
    const tiers: AdminUpdateModelPolicyRequest["tiers"] = [
      {
        catalogId: policy.tiers[0].catalogId,
        enabled: policy.tiers[0].enabled,
        maximumOutputTokens: policy.tiers[0].maximumOutputTokens,
        tier: "fast",
      },
      {
        catalogId: policy.tiers[1].catalogId,
        enabled: policy.tiers[1].enabled,
        maximumOutputTokens: policy.tiers[1].maximumOutputTokens,
        tier: "balanced",
      },
      {
        catalogId: policy.tiers[2].catalogId,
        enabled: policy.tiers[2].enabled,
        maximumOutputTokens: policy.tiers[2].maximumOutputTokens,
        tier: "pro",
      },
    ];
    await expect(
      service.replaceAdminPolicy(workspaceId, "simulated", {
        defaultTier: policy.defaultTier,
        monthlyBudgetUsd: "9.999999999999999999",
        observedRevision: policy.revision,
        tiers,
      }),
    ).rejects.toBeInstanceOf(ModelPolicyConflictError);
    await expect(service.readAdminPolicy(workspaceId, "simulated")).resolves.toMatchObject({
      monthlyBudgetUsd: "100",
      revision: 1,
    });
    await expect(
      service.replaceAdminPolicy(workspaceId, "simulated", {
        defaultTier: policy.defaultTier,
        monthlyBudgetUsd: "10",
        observedRevision: policy.revision,
        tiers,
      }),
    ).resolves.toMatchObject({ monthlyBudgetUsd: "10", revision: 2 });
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

  it("bounds current-period spend while retaining active chat concurrency across rollover", async () => {
    const workspaceId = await insertWorkspace("budget-period-admission", "America/Guayaquil");
    const userId = `user-${randomUUID()}`;
    await database.insert(user).values({
      email: "budget-period-admission@example.test",
      emailVerified: true,
      id: userId,
      name: "Budget Period User",
    });
    await database.insert(workspaceMemberships).values({
      role: "member",
      status: "active",
      userId,
      workspaceId,
    });
    const currentPeriod = {
      end: new Date("2026-09-01T05:00:00.000Z"),
      start: new Date("2026-08-01T05:00:00.000Z"),
    } as const;
    const previousPeriod = {
      end: currentPeriod.start,
      start: new Date("2026-07-01T05:00:00.000Z"),
    } as const;
    const currentStartedAt = new Date("2026-08-10T12:00:00.000Z");
    const previousStartedAt = new Date("2026-07-10T12:00:00.000Z");
    const currentCompletedAt = new Date("2026-08-10T12:00:01.000Z");
    const previousCompletedAt = new Date("2026-07-10T12:00:01.000Z");

    async function insertPeriodGeneration(input: {
      readonly accountingStatus: "actual" | "estimated" | "reserved" | null;
      readonly active?: boolean;
      readonly costUsd: string;
      readonly period: typeof currentPeriod;
      readonly startedAt: Date;
    }): Promise<string> {
      const { generationId } = await insertExpiredReservedGeneration({
        budgetPeriodEnd: input.period.end,
        budgetPeriodStart: input.period.start,
        reservationExpiresAt: new Date(input.startedAt.getTime() + 60_000),
        reservedCostUsd: input.costUsd,
        startedAt: input.startedAt,
        userId,
        workspaceId,
      });
      if (input.active === true) {
        return generationId;
      }
      const completedAt = input.period === currentPeriod ? currentCompletedAt : previousCompletedAt;
      if (input.accountingStatus === null) {
        await database
          .update(generations)
          .set({
            accountingStatus: null,
            budgetPeriodEnd: null,
            budgetPeriodStart: null,
            completedAt,
            completionPriceCeilingPerToken: null,
            costBasis: null,
            costUsd: null,
            estimatedInputTokens: null,
            maximumOutputTokens: null,
            promptPriceCeilingPerToken: null,
            purpose: "chat",
            requestPriceCeilingUsd: null,
            requestedModel: null,
            reservationExpiresAt: null,
            reservationMarginBasisPoints: null,
            reservedCostUsd: null,
            resolvedModel: null,
            status: "completed",
            terminalReason: "stop",
            updatedAt: completedAt,
          })
          .where(eq(generations.id, generationId));
        return generationId;
      }
      await database
        .update(generations)
        .set({
          accountingSettledAt: input.accountingStatus === "reserved" ? null : completedAt,
          accountingStatus: input.accountingStatus,
          completedAt,
          costBasis: input.accountingStatus === "reserved" ? null : input.accountingStatus,
          costUsd: input.accountingStatus === "reserved" ? null : input.costUsd,
          status: "completed",
          terminalReason: "stop",
          updatedAt: completedAt,
        })
        .where(eq(generations.id, generationId));
      return generationId;
    }

    await insertPeriodGeneration({
      accountingStatus: "reserved",
      active: true,
      costUsd: "99",
      period: previousPeriod,
      startedAt: previousStartedAt,
    });
    await insertPeriodGeneration({
      accountingStatus: "actual",
      costUsd: "98",
      period: previousPeriod,
      startedAt: previousStartedAt,
    });
    const currentReservedGenerationId = await insertPeriodGeneration({
      accountingStatus: "reserved",
      costUsd: "1",
      period: currentPeriod,
      startedAt: currentStartedAt,
    });
    await insertPeriodGeneration({
      accountingStatus: "actual",
      costUsd: "2",
      period: currentPeriod,
      startedAt: currentStartedAt,
    });
    await insertPeriodGeneration({
      accountingStatus: "estimated",
      costUsd: "3",
      period: currentPeriod,
      startedAt: currentStartedAt,
    });
    await insertPeriodGeneration({
      accountingStatus: null,
      costUsd: "97",
      period: currentPeriod,
      startedAt: currentStartedAt,
    });

    const budget = createBudgetService(database);
    await expect(
      database.transaction((transaction) =>
        budget.lockAdmission(
          transaction,
          workspaceId,
          userId,
          new Date("2026-08-20T12:00:00.000Z"),
        ),
      ),
    ).resolves.toMatchObject({ activeGenerationCount: 1, consumedUsd: "6" });

    const lockHolder = await pool.connect();
    let committed = false;
    try {
      await lockHolder.query("BEGIN");
      await lockHolder.query("SELECT id FROM workspaces WHERE id = $1 FOR UPDATE", [workspaceId]);
      await lockHolder.query(
        `
          UPDATE generations
          SET status = 'active', terminal_reason = NULL, completed_at = NULL,
            reserved_cost_usd = 4, updated_at = '2026-08-10T12:00:02.000Z'
          WHERE id = $1
        `,
        [currentReservedGenerationId],
      );
      let waiterSettled = false;
      const waitingAdmission = database
        .transaction((transaction) =>
          budget.lockAdmission(
            transaction,
            workspaceId,
            userId,
            new Date("2026-08-20T12:00:00.000Z"),
          ),
        )
        .finally(() => {
          waiterSettled = true;
        });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(waiterSettled).toBe(false);
      await lockHolder.query("COMMIT");
      committed = true;

      await expect(waitingAdmission).resolves.toMatchObject({
        activeGenerationCount: 2,
        consumedUsd: "9",
      });
    } finally {
      if (!committed) {
        await lockHolder.query("ROLLBACK");
      }
      lockHolder.release();
    }
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

    const recordReservationSettlement = vi.fn();
    const recordReconciliation = vi.fn();
    const budget = createBudgetService(database, {
      telemetry: {
        recordBudgetRejection: vi.fn(),
        recordReconciliation,
        recordReservationSettlement,
      },
    });
    const startedAt = new Date();
    const generationId = await database.transaction(async (transaction) => {
      const admission = await budget.lockAdmission(transaction, workspaceId, userId, startedAt);
      const policy = await policyService.resolveTier(
        transaction,
        workspaceId,
        "balanced",
        "openrouter",
      );
      const reservation = budget.reserveResolvedTier(admission, policy, 1_000n, startedAt, {
        enforceEmployeeLimit: true,
        purpose: "chat",
      });
      expect(reservation.reservedCostUsd).toBe("0.005");
      expect(reservation.reservationExpiresAt).toEqual(
        new Date(startedAt.getTime() + costControlTuning.reservationExpiryMs),
      );
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
      budget.reconcileExpiredOnce(
        new Date(startedAt.getTime() + costControlTuning.reservationExpiryMs),
      ),
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
    expect(recordReservationSettlement.mock.calls).toEqual([["actual"], ["actual"], ["expired"]]);
    expect(recordReconciliation).toHaveBeenCalledOnce();
    expect(recordReconciliation).toHaveBeenCalledWith({
      claimed: 1,
      errors: 0,
      oldestDueLagMs: 0,
      settled: 1,
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

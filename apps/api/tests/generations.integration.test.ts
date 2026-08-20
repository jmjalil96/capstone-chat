import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { and, eq } from "drizzle-orm";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type ApiApplication, createApplication } from "../src/app.js";
import type { Authentication } from "../src/auth/authentication.js";
import { loadConfig } from "../src/config.js";
import { createCursorCodec } from "../src/conversations/cursor.js";
import {
  type ConversationService,
  createConversationService,
} from "../src/conversations/service.js";
import { session as authenticationSessions, user } from "../src/database/auth-schema.generated.js";
import { conversations, drafts, messages } from "../src/database/conversation-schema.js";
import { type AppDatabase, createDatabase } from "../src/database/database.js";
import { generations } from "../src/database/generation-schema.js";
import { workspaceMemberships, workspaces } from "../src/database/identity-schema.js";
import { migrateDatabase } from "../src/database/migrate.js";
import {
  modelCatalog,
  workspaceCatalogApprovals,
  workspaceModelPolicies,
  workspaceModelPolicyRevisionTiers,
} from "../src/database/model-policy-schema.js";
import { ApplicationError } from "../src/errors.js";
import { createGenerationAdministrationService } from "../src/generations/administration.js";
import { lockDraftGenerationAdmission } from "../src/generations/admission.js";
import { preloadDraftContext } from "../src/generations/context-preload.js";
import { FakeModelGateway } from "../src/generations/fake-model-gateway.js";
import type { GenerationRequest, ModelGateway } from "../src/generations/model-gateway.js";
import { continueMessage, systemPrompt } from "../src/generations/prompt.js";
import { createGenerationService, type GenerationService } from "../src/generations/service.js";
import type { RequestActor } from "../src/identity/authorization.js";
import type { IdentityService } from "../src/identity/service.js";
import { createBudgetService } from "../src/model-policy/budget-service.js";
import {
  type CatalogModelSnapshot,
  initialTierModels,
  type ModelTier,
  modelTiers,
  verifyPrivacyAttestation,
} from "../src/model-policy/catalog.js";
import { createModelPolicyService } from "../src/model-policy/service.js";
import { testCatalogCapability } from "./support/generation.js";
import { bootstrapSimulatedModelPolicy } from "./support/model-policy.js";
import { bootstrapTestAssistantRules } from "./support/workspace-behavior.js";

function createActor(userId: string, workspaceId: string): RequestActor {
  const now = Date.now();
  return {
    employee: { email: "member@example.test", id: userId, name: "Persona sintética" },
    role: "member",
    session: {
      createdAt: new Date(now - 1_000),
      expiresAt: new Date(now + 24 * 60 * 60 * 1_000),
      id: `session-${userId}`,
    },
    workspace: { id: workspaceId, identity: "synthetic", name: "Synthetic" },
  };
}

async function expectCode(operation: Promise<unknown>, code: string): Promise<void> {
  try {
    await operation;
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(ApplicationError);
    expect(error).toMatchObject({ code });
    return;
  }
  throw new Error(`Expected ${code}`);
}

function openRouterCatalog(
  completionPricePerToken: string,
  validatedAt: Date,
): Readonly<Record<ModelTier, CatalogModelSnapshot>> {
  return Object.freeze(
    Object.fromEntries(
      modelTiers.map((tier) => [
        tier,
        Object.freeze({
          available: true,
          canonicalSlug: initialTierModels[tier],
          capability: testCatalogCapability,
          completionPricePerToken,
          contextLength: 1_000_000,
          displayName: `Synthetic ${tier}`,
          inputModalities: Object.freeze(["text"]),
          maximumOutputTokens: tier === "pro" ? 16_384 : 1,
          metadataSource: "openrouter",
          modelId: initialTierModels[tier],
          outputModalities: Object.freeze(["text"]),
          promptPricePerToken: "0",
          requestPriceUsd: "0",
          supportedParameters: Object.freeze(["max_tokens", "reasoning"]),
          validatedAt,
        }),
      ]),
    ) as Record<ModelTier, CatalogModelSnapshot>,
  );
}

describe.sequential("generation lifecycle integration", () => {
  let container: StartedPostgreSqlContainer;
  let databaseUrl: string;
  let pool: Pool;
  let database: AppDatabase;
  let workspaceIdentity: string;
  let actor: RequestActor;
  let conversationsService: ConversationService;
  let generationService: GenerationService;
  let application: ApiApplication | undefined;

  // These lifecycle tests exercise the terminal chat contract. When a completed initial answer
  // hands off to naming, settle that phase immediately without a title so assertions keep
  // describing the chat's own terminal row and single revision step.
  async function terminalizeSettled(
    generationId: string,
    input: Parameters<GenerationService["terminalize"]>[1],
  ): ReturnType<GenerationService["terminalize"]> {
    const result = await generationService.terminalize(generationId, input);
    if (!result.won || result.naming === undefined || result.conversationId === null) {
      return result;
    }
    const finalized = await generationService.finalizeNaming({
      conversationId: result.conversationId,
      outcome: { errorCode: "GENERATION_FAILED", kind: "failed" },
      parentGenerationId: generationId,
      titleGenerationId: result.naming.titleGenerationId,
    });
    const { naming: _naming, ...settled } = result;
    return { ...settled, revision: finalized.revision, status: "completed" };
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:18.4-alpine")
      .withDatabase("capstone_generations")
      .withUsername("capstone")
      .withPassword("capstone-test-password")
      .start();
    databaseUrl = container.getConnectionUri();
    await migrateDatabase(databaseUrl);
  });

  beforeEach(async () => {
    pool = new Pool({ connectionString: databaseUrl });
    database = createDatabase(pool);
    await pool.query(
      'TRUNCATE TABLE "generations", "drafts", "messages", "conversations", "workspace_memberships", "employee_approvals", "user", "workspaces", "model_catalog" RESTART IDENTITY CASCADE',
    );
    const workspaceId = randomUUID();
    workspaceIdentity = `workspace-${randomUUID()}`;
    const userId = `user-${randomUUID()}`;
    await database.insert(workspaces).values({
      displayName: "Synthetic",
      id: workspaceId,
      identity: workspaceIdentity,
    });
    await database.insert(user).values({
      email: "member@example.test",
      emailVerified: true,
      id: userId,
      name: "Member",
    });
    const sessionAt = new Date();
    await database.insert(authenticationSessions).values({
      createdAt: sessionAt,
      expiresAt: new Date(sessionAt.getTime() + 24 * 60 * 60 * 1_000),
      id: `session-${userId}`,
      token: `token-${userId}`,
      updatedAt: sessionAt,
      userId,
    });
    await database.insert(workspaceMemberships).values({
      role: "member",
      userId,
      workspaceId,
    });
    await bootstrapTestAssistantRules(database, workspaceId);
    await bootstrapSimulatedModelPolicy(createModelPolicyService(database), workspaceIdentity);
    actor = createActor(userId, workspaceId);
    conversationsService = createConversationService(
      database,
      createCursorCodec("generation-test-secret-longer-than-thirty-two-characters"),
    );
    generationService = createGenerationService(database);
  });

  afterEach(async () => {
    if (application !== undefined) {
      await application.shutdown();
      application = undefined;
    }
    await pool.end();
  });

  afterAll(async () => {
    await container.stop();
  });

  async function adoptedConversation(content: string) {
    const draft = await conversationsService.saveDraft(actor, { kind: "new" }, content, 0);
    const conversation = await conversationsService.create(actor, draft.revision);
    expect(
      await conversationsService.getDraft(actor, {
        conversationId: conversation.id,
        kind: "conversation",
      }),
    ).toMatchObject({ content, revision: draft.revision });
    return { conversation, draft };
  }

  it("rejects response admission after the resolved session is durably invalidated", async () => {
    const conversation = await conversationsService.create(actor);
    await database
      .delete(authenticationSessions)
      .where(eq(authenticationSessions.id, actor.session.id));

    await expectCode(
      generationService.startResponse(actor, conversation.id, randomUUID(), {
        content: [{ text: "No debe iniciar", type: "text" }],
        draftRevision: 0,
        modelTier: "balanced",
        observedRevision: conversation.revision,
        parentMessageId: null,
        source: "draft",
      }),
      "AUTHENTICATION_REQUIRED",
    );
    expect(await database.select().from(generations)).toHaveLength(0);
  });

  it("admits first, then lets the session-fenced sign-out cancel the new work", async () => {
    const conversation = await conversationsService.create(actor);
    const draft = await conversationsService.saveDraft(
      actor,
      { conversationId: conversation.id, kind: "conversation" },
      "Admisión ganadora",
      0,
    );
    const budget = createBudgetService(database);
    const admissionEntered = Promise.withResolvers<void>();
    const releaseAdmission = Promise.withResolvers<void>();
    const fencedService = createGenerationService(database, {
      budget: {
        ...budget,
        async lockAdmissionAuthority(...argumentsList) {
          admissionEntered.resolve();
          await releaseAdmission.promise;
          return budget.lockAdmissionAuthority(...argumentsList);
        },
      },
    });
    const startedPromise = fencedService.startResponse(actor, conversation.id, randomUUID(), {
      content: [{ text: "Admisión ganadora", type: "text" }],
      draftRevision: draft.revision,
      modelTier: "balanced",
      observedRevision: conversation.revision,
      parentMessageId: null,
      source: "draft",
    });
    await admissionEntered.promise;

    const administration = createGenerationAdministrationService(database, budget);
    const signOut = database.transaction(async (transaction) => {
      const locked = await transaction
        .select({ id: authenticationSessions.id })
        .from(authenticationSessions)
        .where(eq(authenticationSessions.id, actor.session.id))
        .limit(1)
        .for("update");
      expect(locked).toHaveLength(1);
      const settlement = await administration.settleEmployeeWorkInTransaction(
        transaction,
        null,
        actor.employee.id,
      );
      await transaction
        .delete(authenticationSessions)
        .where(eq(authenticationSessions.id, actor.session.id));
      return settlement;
    });

    releaseAdmission.resolve();
    const startedResponse = await startedPromise;
    const settlement = await signOut;

    expect(settlement.parentGenerationIds).toEqual([startedResponse.generationId]);
    await expect(fencedService.readState(startedResponse.generationId)).resolves.toMatchObject({
      revision: 2,
      status: "cancelled",
    });
  });

  it("rejects admission when the session-fenced sign-out commits first", async () => {
    const conversation = await conversationsService.create(actor);
    const draft = await conversationsService.saveDraft(
      actor,
      { conversationId: conversation.id, kind: "conversation" },
      "No debe atravesar el cierre",
      0,
    );
    const budget = createBudgetService(database);
    const administration = createGenerationAdministrationService(database, budget);
    const sessionLocked = Promise.withResolvers<void>();
    const releaseSignOut = Promise.withResolvers<void>();
    const signOut = database.transaction(async (transaction) => {
      const locked = await transaction
        .select({ id: authenticationSessions.id })
        .from(authenticationSessions)
        .where(eq(authenticationSessions.id, actor.session.id))
        .limit(1)
        .for("update");
      expect(locked).toHaveLength(1);
      sessionLocked.resolve();
      await releaseSignOut.promise;
      await administration.settleEmployeeWorkInTransaction(transaction, null, actor.employee.id);
      await transaction
        .delete(authenticationSessions)
        .where(eq(authenticationSessions.id, actor.session.id));
    });
    await sessionLocked.promise;

    const start = generationService.startResponse(actor, conversation.id, randomUUID(), {
      content: [{ text: "No debe atravesar el cierre", type: "text" }],
      draftRevision: draft.revision,
      modelTier: "balanced",
      observedRevision: conversation.revision,
      parentMessageId: null,
      source: "draft",
    });
    releaseSignOut.resolve();
    await signOut;

    await expectCode(start, "AUTHENTICATION_REQUIRED");
    expect(await database.select().from(generations)).toHaveLength(0);
  });

  it("cancels complete conversation batches beyond the 100-key boundary", async () => {
    const fixtures = Array.from({ length: 101 }, (_, index) => ({
      answerId: randomUUID(),
      conversationId: randomUUID(),
      generationId: randomUUID(),
      index,
      promptId: randomUUID(),
    }));
    await database.insert(conversations).values(
      fixtures.map(({ conversationId, index }) => ({
        id: conversationId,
        title: `Conversación ${index}`,
        userId: actor.employee.id,
        workspaceId: actor.workspace.id,
      })),
    );
    await database.insert(messages).values(
      fixtures.map(({ conversationId, index, promptId }) => ({
        content: [{ text: `Pregunta ${index}`, type: "text" }],
        conversationId,
        id: promptId,
        parentMessageId: null,
        role: "user" as const,
      })),
    );
    await database.insert(messages).values(
      fixtures.map(({ answerId, conversationId, promptId }) => ({
        content: [{ text: "", type: "text" }],
        conversationId,
        id: answerId,
        parentMessageId: promptId,
        role: "assistant" as const,
      })),
    );
    await database.insert(generations).values(
      fixtures.map(({ answerId, conversationId, generationId }) => ({
        assistantMessageId: answerId,
        conversationId,
        effectiveParameters: { context: { mode: "full" } },
        id: generationId,
        idempotencyKey: randomUUID(),
        behaviorContractVersion: 2,
        modelPolicyRevision: 1,
        purpose: "chat",
        requestedTier: "balanced",
        status: "active" as const,
        systemPromptVersion: "capstone-chat-base-v2",
        userId: actor.employee.id,
        workspaceId: actor.workspace.id,
        workspacePromptRevision: 1,
      })),
    );

    const cancelled = await createGenerationAdministrationService(
      database,
      createBudgetService(database),
    ).cancelEmployeeWork(actor.workspace.id, actor.employee.id);

    expect(new Set(cancelled)).toEqual(new Set(fixtures.map(({ generationId }) => generationId)));
    await expect(
      database
        .select({ status: generations.status })
        .from(generations)
        .where(eq(generations.userId, actor.employee.id)),
    ).resolves.toEqual(Array.from({ length: 101 }, () => ({ status: "cancelled" })));
    const revised = await database
      .select({
        automaticTitlePending: conversations.automaticTitlePending,
        revision: conversations.revision,
      })
      .from(conversations)
      .where(eq(conversations.userId, actor.employee.id));
    expect(revised).toHaveLength(101);
    expect(revised).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ automaticTitlePending: false, revision: 1 }),
      ]),
    );
    expect(revised.every((row) => row.revision === 1 && !row.automaticTitlePending)).toBe(true);
  });

  async function longConversationDraft() {
    const conversation = await conversationsService.create(actor);
    let parentMessageId: string | null = null;
    const padding = "x".repeat(780);
    for (let turn = 0; turn < 9; turn += 1) {
      const userMessage = await conversationsService.insertImmutableMessage(actor, {
        content: [{ text: `Pregunta histórica ${turn} ${padding}`, type: "text" }],
        conversationId: conversation.id,
        parentMessageId,
        role: "user",
      });
      const assistantMessage = await conversationsService.insertImmutableMessage(actor, {
        content: [{ text: `Respuesta histórica ${turn} ${padding}`, type: "text" }],
        conversationId: conversation.id,
        parentMessageId: userMessage.id,
        role: "assistant",
      });
      parentMessageId = assistantMessage.id;
    }
    await database
      .update(conversations)
      .set({ selectedLeafMessageId: parentMessageId })
      .where(eq(conversations.id, conversation.id));
    const draft = await conversationsService.saveDraft(
      actor,
      { conversationId: conversation.id, kind: "conversation" },
      "Pregunta nueva con historial extenso",
      0,
    );
    return { conversation, draft, parentMessageId };
  }

  async function setTierContextLength(tier: ModelTier, contextLength: number): Promise<void> {
    await database
      .update(modelCatalog)
      .set({ contextLength })
      .where(eq(modelCatalog.openRouterModelId, initialTierModels[tier]));
  }

  async function useOpenRouterPolicy(): Promise<void> {
    await pool.query(
      'TRUNCATE TABLE "workspace_model_policy_revisions", "model_catalog" RESTART IDENTITY CASCADE',
    );
    const policy = createModelPolicyService(database);
    const verifiedAt = new Date(Date.now() - 1_000);
    await policy.bootstrap({
      catalog: openRouterCatalog("1", verifiedAt),
      employeeActiveGenerationLimit: 1,
      maximumOutputTokens: { balanced: 1, fast: 1, pro: 16_384 },
      mode: "openrouter",
      monthlyBudgetUsd: "100",
      privacyAttestation: verifyPrivacyAttestation({
        attestationVersion: "openrouter-privacy-v1",
        broadcastEnabled: false,
        dataDiscountLoggingEnabled: false,
        inputOutputLoggingEnabled: false,
        verifiedAt,
      }),
      reservationMarginBasisPoints: 0,
      workspaceIdentity,
    });
    conversationsService = createConversationService(
      database,
      createCursorCodec("generation-test-secret-longer-than-thirty-two-characters"),
      "openrouter",
      policy,
    );
    generationService = createGenerationService(database, {
      mode: "openrouter",
      modelPolicy: policy,
    });
  }

  it("preloads an owned first-message draft as one empty context window", async () => {
    const { conversation } = await adoptedConversation("Primera pregunta");

    const preloaded = await preloadDraftContext(database, createModelPolicyService(database), {
      conversationId: conversation.id,
      mode: "simulated",
      observedRevision: conversation.revision,
      parentMessageId: null,
      tier: "balanced",
      userId: actor.employee.id,
      workspaceId: actor.workspace.id,
    });

    expect(preloaded).toMatchObject({
      endpointMessageId: null,
      revision: conversation.revision,
      window: {
        previousCompaction: null,
        recentTurns: [],
        sourceOverflow: false,
        sourceTurns: [],
      },
    });
  });

  it("preloads one complete owned turn without a separate conversation or policy read", async () => {
    const conversation = await conversationsService.create(actor);
    const userMessage = await conversationsService.insertImmutableMessage(actor, {
      content: [{ text: "Pregunta previa", type: "text" }],
      conversationId: conversation.id,
      parentMessageId: null,
      role: "user",
    });
    const assistantMessage = await conversationsService.insertImmutableMessage(actor, {
      content: [{ text: "Respuesta previa", type: "text" }],
      conversationId: conversation.id,
      parentMessageId: userMessage.id,
      role: "assistant",
    });
    await database
      .update(conversations)
      .set({ selectedLeafMessageId: assistantMessage.id })
      .where(eq(conversations.id, conversation.id));
    let statementCount = 0;
    let contextRowCount = 0;
    let policyRowCount = 0;
    const instrumentedDatabase = new Proxy(database, {
      get(target, property, receiver) {
        if (property !== "execute") {
          return Reflect.get(target, property, receiver);
        }
        return async (query: Parameters<typeof database.execute>[0]) => {
          statementCount += 1;
          const result = await database.execute(query);
          contextRowCount += result.rows.filter(
            (row) => (row as Record<string, unknown>).rowKind === "context",
          ).length;
          policyRowCount += result.rows.filter(
            (row) => (row as Record<string, unknown>).rowKind === "policy",
          ).length;
          return result;
        };
      },
    });

    const preloaded = await preloadDraftContext(
      instrumentedDatabase,
      createModelPolicyService(database),
      {
        conversationId: conversation.id,
        mode: "simulated",
        observedRevision: conversation.revision,
        parentMessageId: assistantMessage.id,
        tier: "balanced",
        userId: actor.employee.id,
        workspaceId: actor.workspace.id,
      },
    );

    expect({ contextRowCount, policyRowCount, statementCount }).toEqual({
      contextRowCount: 1,
      policyRowCount: 2,
      statementCount: 1,
    });
    expect(preloaded?.window).toMatchObject({
      previousCompaction: null,
      recentTurns: [
        {
          assistant: { id: assistantMessage.id, text: "Respuesta previa" },
          user: { id: userMessage.id, text: "Pregunta previa" },
        },
      ],
      sourceOverflow: false,
      sourceTurns: [],
    });
  });

  it("returns no speculative context across the conversation owner boundary", async () => {
    const { conversation, parentMessageId } = await longConversationDraft();

    await expect(
      preloadDraftContext(database, createModelPolicyService(database), {
        conversationId: conversation.id,
        mode: "simulated",
        observedRevision: conversation.revision,
        parentMessageId,
        tier: "balanced",
        userId: `other-${randomUUID()}`,
        workspaceId: actor.workspace.id,
      }),
    ).resolves.toBeNull();
  });

  it("preserves the conversation and draft when its mapped tier is no longer approved", async () => {
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
          eq(workspaceCatalogApprovals.workspaceId, actor.workspace.id),
          eq(workspaceCatalogApprovals.modelCatalogId, catalogId),
        ),
      );
    const policy = createModelPolicyService(database);
    await expect(policy.readEmployeeTierPolicy(actor.workspace.id, "simulated")).resolves.toEqual({
      defaultTier: "balanced",
      tiers: [
        { available: true, enabled: true, tier: "fast" },
        { available: false, enabled: true, tier: "balanced" },
        { available: true, enabled: true, tier: "pro" },
      ],
    });

    const { conversation, draft } = await adoptedConversation("No debe enviarse");
    await expectCode(
      generationService.startResponse(actor, conversation.id, randomUUID(), {
        content: [{ text: draft.content, type: "text" }],
        draftRevision: draft.revision,
        modelTier: "balanced",
        observedRevision: 0,
        parentMessageId: null,
        source: "draft",
      }),
      "TIER_UNAVAILABLE",
    );

    await expect(conversationsService.get(actor, conversation.id)).resolves.toMatchObject({
      conversation: { revision: 0 },
      messages: [],
    });
    await expect(
      conversationsService.getDraft(actor, {
        conversationId: conversation.id,
        kind: "conversation",
      }),
    ).resolves.toMatchObject({
      content: draft.content,
      revision: draft.revision,
      scope: { conversationId: conversation.id, kind: "conversation" },
    });
    await expect(database.select().from(generations)).resolves.toEqual([]);
  });

  it("uses authoritative policy committed after context preloading", async () => {
    const { conversation, draft } = await adoptedConversation("Política todavía vigente");
    const budget = createBudgetService(database);
    let announcePreloaded: () => void = () => undefined;
    const preloaded = new Promise<void>((resolve) => {
      announcePreloaded = resolve;
    });
    let releaseAuthority: () => void = () => undefined;
    const authorityRelease = new Promise<void>((resolve) => {
      releaseAuthority = resolve;
    });
    let announceAuthorityAttempt: () => void = () => undefined;
    const authorityAttempted = new Promise<void>((resolve) => {
      announceAuthorityAttempt = resolve;
    });
    const authoritativeService = createGenerationService(database, {
      budget: {
        ...budget,
        async lockAdmissionAuthority(...argumentsList) {
          announcePreloaded();
          await authorityRelease;
          announceAuthorityAttempt();
          return budget.lockAdmissionAuthority(...argumentsList);
        },
      },
    });
    const response = authoritativeService.startResponse(actor, conversation.id, randomUUID(), {
      content: [{ text: draft.content, type: "text" }],
      draftRevision: draft.revision,
      modelTier: "balanced",
      observedRevision: conversation.revision,
      parentMessageId: null,
      source: "draft",
    });
    await preloaded;

    await database.transaction(async (transaction) => {
      await transaction
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(eq(workspaces.id, actor.workspace.id))
        .for("update");
      await transaction
        .update(workspaceModelPolicies)
        .set({ enabled: false })
        .where(
          and(
            eq(workspaceModelPolicies.workspaceId, actor.workspace.id),
            eq(workspaceModelPolicies.tier, "balanced"),
          ),
        );
      releaseAuthority();
      await authorityAttempted;
    });

    await expectCode(response, "TIER_UNAVAILABLE");
    await expect(database.select().from(messages)).resolves.toEqual([]);
    await expect(database.select().from(generations)).resolves.toEqual([]);
    await expect(conversationsService.get(actor, conversation.id)).resolves.toMatchObject({
      conversation: { revision: conversation.revision },
    });
    await expect(
      conversationsService.getDraft(actor, {
        conversationId: conversation.id,
        kind: "conversation",
      }),
    ).resolves.toMatchObject({ content: draft.content, revision: draft.revision });
  });

  it("locks conversation and draft before waiting for policy", async () => {
    const { conversation, draft } = await adoptedConversation("Orden de bloqueo estable");
    const budget = createBudgetService(database);
    const modelPolicy = createModelPolicyService(database);
    const policyHolder = await pool.connect();
    let holderCommitted = false;
    try {
      await policyHolder.query("BEGIN");
      await policyHolder.query(
        `
          SELECT workspace_id
          FROM workspace_model_policies
          WHERE workspace_id = $1 AND tier = 'balanced'
          FOR UPDATE
        `,
        [actor.workspace.id],
      );

      let admissionSettled = false;
      const pendingAdmission = database
        .transaction(async (transaction) => {
          await budget.lockAdmissionAuthority(transaction, actor.workspace.id, actor.employee.id);
          return lockDraftGenerationAdmission(
            transaction,
            {
              at: new Date(),
              conversationId: conversation.id,
              draftContent: draft.content,
              draftRevision: draft.revision,
              idempotencyKey: randomUUID(),
              mode: "simulated",
              observedRevision: conversation.revision,
              parentMessageId: null,
              tier: "balanced",
              userId: actor.employee.id,
              workspaceId: actor.workspace.id,
            },
            modelPolicy,
          );
        })
        .finally(() => {
          admissionSettled = true;
        });

      await new Promise((resolve) => setTimeout(resolve, 75));
      expect(admissionSettled).toBe(false);
      await expect(
        pool.query("SELECT id FROM conversations WHERE id = $1 FOR UPDATE NOWAIT", [
          conversation.id,
        ]),
      ).rejects.toMatchObject({ code: "55P03" });
      await expect(
        pool.query(
          `
            SELECT id
            FROM drafts
            WHERE workspace_id = $1 AND user_id = $2 AND conversation_id = $3
            FOR UPDATE NOWAIT
          `,
          [actor.workspace.id, actor.employee.id, conversation.id],
        ),
      ).rejects.toMatchObject({ code: "55P03" });

      await policyHolder.query("COMMIT");
      holderCommitted = true;
      const pending = await pendingAdmission;
      expect(pending.conversation).toMatchObject({
        conversationId: conversation.id,
        draftContent: draft.content,
        draftRevision: draft.revision,
        idempotencyFound: false,
      });
      expect(pending.resolve().policies.chat.tier).toBe("balanced");
    } finally {
      if (!holderCommitted) {
        await policyHolder.query("ROLLBACK");
      }
      policyHolder.release();
    }
  });

  it("returns a stale-conversation error without waiting for model policy", async () => {
    const { conversation, draft } = await adoptedConversation("Error previo a la política");
    const policyHolder = await pool.connect();
    let responseCode: Promise<string> | undefined;
    let outcome: string | undefined;
    try {
      await policyHolder.query("BEGIN");
      await policyHolder.query(
        `
          SELECT workspace_id
          FROM workspace_model_policies
          WHERE workspace_id = $1 AND tier = 'balanced'
          FOR UPDATE
        `,
        [actor.workspace.id],
      );

      responseCode = generationService
        .startResponse(actor, conversation.id, randomUUID(), {
          content: [{ text: draft.content, type: "text" }],
          draftRevision: draft.revision,
          modelTier: "balanced",
          observedRevision: conversation.revision + 1,
          parentMessageId: null,
          source: "draft",
        })
        .then(
          () => "success",
          (error: unknown) => (error instanceof ApplicationError ? error.code : "unexpected"),
        );
      outcome = await Promise.race([
        responseCode,
        new Promise<string>((resolve) => setTimeout(() => resolve("policy-blocked"), 250)),
      ]);
    } finally {
      await policyHolder.query("ROLLBACK");
      policyHolder.release();
    }

    expect(outcome).toBe("CONVERSATION_CHANGED");
    await expect(responseCode).resolves.toBe("CONVERSATION_CHANGED");
  });

  it.each([
    { code: "CONVERSATION_CHANGED", target: "conversation" as const },
    { code: "DRAFT_CHANGED", target: "draft" as const },
  ])("rolls back every workflow row when the final $target CAS loses", async ({ code, target }) => {
    const { conversation, draft } = await adoptedConversation("No debe quedar parcialmente");
    const functionName = `suppress_generation_${target}_write`;
    const triggerName = `suppress_generation_${target}_write_trigger`;
    const tableName = target === "conversation" ? "conversations" : "drafts";
    const operation = target === "conversation" ? "UPDATE" : "DELETE";
    await pool.query(`
      CREATE FUNCTION ${functionName}() RETURNS trigger AS $$
      BEGIN
        RETURN NULL;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER ${triggerName}
      BEFORE ${operation} ON ${tableName}
      FOR EACH ROW EXECUTE FUNCTION ${functionName}();
    `);
    try {
      await expectCode(
        generationService.startResponse(actor, conversation.id, randomUUID(), {
          content: [{ text: draft.content, type: "text" }],
          draftRevision: draft.revision,
          modelTier: "balanced",
          observedRevision: conversation.revision,
          parentMessageId: null,
          source: "draft",
        }),
        code,
      );
    } finally {
      await pool.query(`
        DROP TRIGGER ${triggerName} ON ${tableName};
        DROP FUNCTION ${functionName}();
      `);
    }

    await expect(database.select().from(messages)).resolves.toEqual([]);
    await expect(database.select().from(generations)).resolves.toEqual([]);
    await expect(conversationsService.get(actor, conversation.id)).resolves.toMatchObject({
      conversation: { revision: conversation.revision },
    });
    await expect(
      conversationsService.getDraft(actor, {
        conversationId: conversation.id,
        kind: "conversation",
      }),
    ).resolves.toMatchObject({ content: draft.content, revision: draft.revision });
  });

  it("admits a preparing response through the valid internal Fast route when Fast is employee-disabled", async () => {
    await setTierContextLength("fast", 20_000);
    await database
      .update(workspaceModelPolicies)
      .set({ enabled: false })
      .where(
        and(
          eq(workspaceModelPolicies.workspaceId, actor.workspace.id),
          eq(workspaceModelPolicies.tier, "fast"),
        ),
      );
    await database
      .update(workspaceModelPolicyRevisionTiers)
      .set({ enabled: false })
      .where(
        and(
          eq(workspaceModelPolicyRevisionTiers.workspaceId, actor.workspace.id),
          eq(workspaceModelPolicyRevisionTiers.revision, 1),
          eq(workspaceModelPolicyRevisionTiers.tier, "fast"),
        ),
      );
    const { conversation, draft, parentMessageId } = await longConversationDraft();

    const started = await generationService.startResponse(actor, conversation.id, randomUUID(), {
      content: [{ text: draft.content, type: "text" }],
      draftRevision: draft.revision,
      modelTier: "balanced",
      observedRevision: 0,
      parentMessageId,
      source: "draft",
    });

    expect(started.contextWarning).toBeUndefined();
    expect(started.compaction).toMatchObject({
      fastPolicy: { contextLength: 20_000, tier: "fast" },
      plan: { mode: "pending" },
    });
    await expect(
      database
        .select({
          effectiveParameters: generations.effectiveParameters,
          status: generations.status,
        })
        .from(generations)
        .where(eq(generations.id, started.generationId)),
    ).resolves.toMatchObject([
      { effectiveParameters: { purpose: "chat", tier: "balanced" }, status: "preparing" },
    ]);
  });

  it("timestamps response-start telemetry before selected-context reconstruction", async () => {
    const { conversation, draft, parentMessageId } = await longConversationDraft();
    const blocker = await pool.connect();
    let released = false;
    try {
      await blocker.query("BEGIN");
      await blocker.query("LOCK TABLE messages IN ACCESS EXCLUSIVE MODE");
      const operation = generationService.startResponse(actor, conversation.id, randomUUID(), {
        content: [{ text: draft.content, type: "text" }],
        draftRevision: draft.revision,
        modelTier: "balanced",
        observedRevision: 0,
        parentMessageId,
        source: "draft",
      });
      await new Promise((resolve) => setTimeout(resolve, 75));
      await blocker.query("COMMIT");
      released = true;

      const response = await operation;
      expect(response.startedAt).toBeDefined();
      expect(response.startedAt?.getTime() ?? 0).toBeGreaterThanOrEqual(
        response.admittedAt.getTime() + 50,
      );
    } finally {
      if (!released) {
        await blocker.query("ROLLBACK");
      }
      blocker.release();
    }
  });

  it("marks admission fallback for an employee-visible warning when internal Fast is unavailable", async () => {
    await setTierContextLength("balanced", 24_000);
    const catalogRows = await database
      .select({ id: modelCatalog.id })
      .from(modelCatalog)
      .where(eq(modelCatalog.openRouterModelId, initialTierModels.fast));
    const fastCatalogId = catalogRows[0]?.id;
    if (fastCatalogId === undefined) {
      throw new Error("Fast catalog row is unavailable");
    }
    await database
      .delete(workspaceCatalogApprovals)
      .where(
        and(
          eq(workspaceCatalogApprovals.workspaceId, actor.workspace.id),
          eq(workspaceCatalogApprovals.modelCatalogId, fastCatalogId),
        ),
      );
    const { conversation, draft, parentMessageId } = await longConversationDraft();

    const started = await generationService.startResponse(actor, conversation.id, randomUUID(), {
      content: [{ text: draft.content, type: "text" }],
      draftRevision: draft.revision,
      modelTier: "balanced",
      observedRevision: 0,
      parentMessageId,
      source: "draft",
    });

    expect(started).toMatchObject({ contextWarning: true });
    expect(started.compaction).toBeUndefined();
    await expect(
      database
        .select({
          effectiveParameters: generations.effectiveParameters,
          status: generations.status,
        })
        .from(generations)
        .where(eq(generations.id, started.generationId)),
    ).resolves.toMatchObject([
      {
        effectiveParameters: { purpose: "chat", tier: "balanced" },
        status: "active",
      },
    ]);
  });

  it.each([
    {
      employeeActiveGenerationLimit: 2,
      expectedCode: "WORKSPACE_BUDGET_EXCEEDED",
      monthlyBudgetUsd: "1",
      scenario: "workspace budget",
    },
    {
      employeeActiveGenerationLimit: 1,
      expectedCode: "EMPLOYEE_GENERATION_LIMIT_REACHED",
      monthlyBudgetUsd: "100",
      scenario: "employee concurrency",
    },
  ])(
    "atomically admits one of two concurrent conversations at the $scenario boundary",
    async ({ employeeActiveGenerationLimit, expectedCode, monthlyBudgetUsd }) => {
      await pool.query(
        'TRUNCATE TABLE "workspace_model_policy_revisions", "model_catalog" RESTART IDENTITY CASCADE',
      );
      const policy = createModelPolicyService(database);
      const verifiedAt = new Date(Date.now() - 1_000);
      await policy.bootstrap({
        catalog: openRouterCatalog("1", verifiedAt),
        employeeActiveGenerationLimit,
        maximumOutputTokens: { balanced: 1, fast: 1, pro: 16_384 },
        mode: "openrouter",
        monthlyBudgetUsd,
        privacyAttestation: verifyPrivacyAttestation({
          attestationVersion: "openrouter-privacy-v1",
          broadcastEnabled: false,
          dataDiscountLoggingEnabled: false,
          inputOutputLoggingEnabled: false,
          verifiedAt,
        }),
        reservationMarginBasisPoints: 0,
        workspaceIdentity,
      });
      conversationsService = createConversationService(
        database,
        createCursorCodec("generation-test-secret-longer-than-thirty-two-characters"),
        "openrouter",
        policy,
      );
      generationService = createGenerationService(database, {
        mode: "openrouter",
        modelPolicy: policy,
      });
      const prepared = [
        await adoptedConversation("Primera reserva concurrente"),
        await adoptedConversation("Segunda reserva concurrente"),
      ];
      const results = await Promise.allSettled(
        prepared.map(({ conversation, draft }, index) =>
          generationService.startResponse(actor, conversation.id, randomUUID(), {
            content: [
              { text: `${index === 0 ? "Primera" : "Segunda"} reserva concurrente`, type: "text" },
            ],
            draftRevision: draft.revision,
            modelTier: "balanced",
            observedRevision: 0,
            parentMessageId: null,
            source: "draft",
          }),
        ),
      );
      const winnerIndex = results.findIndex((result) => result.status === "fulfilled");
      const loserIndex = results.findIndex((result) => result.status === "rejected");
      expect(winnerIndex).toBeGreaterThanOrEqual(0);
      expect(loserIndex).toBeGreaterThanOrEqual(0);
      expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
      const rejection = results[loserIndex];
      expect(rejection?.status).toBe("rejected");
      if (rejection?.status !== "rejected") {
        throw new Error("Concurrent admission did not produce one rejected request");
      }
      expect(rejection.reason).toMatchObject({ code: expectedCode });

      const loser = prepared[loserIndex];
      if (loser === undefined) {
        throw new Error("Concurrent admission loser fixture disappeared");
      }
      await expect(
        conversationsService.getDraft(actor, {
          conversationId: loser.conversation.id,
          kind: "conversation",
        }),
      ).resolves.toMatchObject({
        content: loser.draft.content,
        revision: loser.draft.revision,
        scope: { conversationId: loser.conversation.id, kind: "conversation" },
      });
      await expect(conversationsService.get(actor, loser.conversation.id)).resolves.toMatchObject({
        conversation: { revision: 0 },
        messages: [],
      });

      const stored = await database.select().from(generations);
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({
        accountingStatus: "reserved",
        effectiveParameters: {
          purpose: "chat",
          tier: "balanced",
          traceExcluded: true,
        },
        maximumOutputTokens: 1,
        requestedModel: initialTierModels.balanced,
        requestedTier: "balanced",
        reservedCostUsd: "1.000000000000000000",
      });
      const winner = results[winnerIndex];
      if (winner?.status !== "fulfilled") {
        throw new Error("Concurrent admission winner fixture disappeared");
      }
      expect(winner.value.request.route).toEqual({
        completionPriceCeilingUsdPerToken: "1",
        maximumOutputTokens: 1,
        promptPriceCeilingUsdPerToken: "0",
        requestPriceCeilingUsd: "0",
        requestedModel: initialTierModels.balanced,
      });
      const winnerFixture = prepared[winnerIndex];
      if (winnerFixture === undefined) {
        throw new Error("Concurrent admission winner conversation disappeared");
      }
      await expect(
        generationService.removeConversation(actor, winnerFixture.conversation.id, 1),
      ).resolves.toBe(winner.value.generationId);
      await expect(
        database.select().from(generations).where(eq(generations.id, winner.value.generationId)),
      ).resolves.toMatchObject([
        {
          accountingStatus: "reserved",
          assistantMessageId: null,
          budgetPeriodEnd: expect.any(Date),
          budgetPeriodStart: expect.any(Date),
          conversationId: null,
          requestedModel: initialTierModels.balanced,
          reservedCostUsd: "1.000000000000000000",
          status: "cancelled",
        },
      ]);
    },
  );

  it("settles a deterministic pre-provider failure at zero in the terminal transaction", async () => {
    await useOpenRouterPolicy();
    const { conversation, draft } = await adoptedConversation("Falla previa al proveedor");
    const started = await generationService.startResponse(actor, conversation.id, randomUUID(), {
      content: [{ text: draft.content, type: "text" }],
      draftRevision: draft.revision,
      modelTier: "balanced",
      observedRevision: 0,
      parentMessageId: null,
      source: "draft",
    });

    await expect(
      terminalizeSettled(started.generationId, {
        content: "",
        errorCode: "GENERATION_FAILED",
        firstTokenAt: null,
        reason: "error",
        settleDeterministicZero: true,
        status: "failed",
      }),
    ).resolves.toMatchObject({ status: "failed", won: true });

    await expect(
      database.select().from(generations).where(eq(generations.id, started.generationId)),
    ).resolves.toMatchObject([
      {
        accountingSettledAt: expect.any(Date),
        accountingStatus: "actual",
        completionTokens: 0n,
        costBasis: "actual",
        costUsd: "0.000000000000000000",
        errorCode: "GENERATION_FAILED",
        promptTokens: 0n,
        status: "failed",
      },
    ]);
  });

  it("persists authoritative provider metadata with terminal accounting", async () => {
    await useOpenRouterPolicy();
    const { conversation, draft } = await adoptedConversation("Respuesta con proveedor recuperado");
    const started = await generationService.startResponse(actor, conversation.id, randomUUID(), {
      content: [{ text: draft.content, type: "text" }],
      draftRevision: draft.revision,
      modelTier: "balanced",
      observedRevision: 0,
      parentMessageId: null,
      source: "draft",
    });

    await expect(
      terminalizeSettled(started.generationId, {
        accounting: {
          metadata: {
            costUsd: "0.000123",
            metadata: {
              provider: "provider-recovered",
              providerGenerationId: "provider-generation-recovered",
              resolvedModel: initialTierModels.balanced,
            },
          },
          usage: { inputTokens: 11, outputTokens: 1 },
        },
        content: "Respuesta con contabilidad completa",
        errorCode: null,
        firstTokenAt: new Date(),
        reason: "stop",
        status: "completed",
      }),
    ).resolves.toMatchObject({ status: "completed", won: true });

    await expect(
      database.select().from(generations).where(eq(generations.id, started.generationId)),
    ).resolves.toMatchObject([
      {
        accountingStatus: "actual",
        completionTokens: 1n,
        costBasis: "actual",
        costUsd: "0.000123000000000000",
        openRouterGenerationId: "provider-generation-recovered",
        promptTokens: 11n,
        provider: "provider-recovered",
        resolvedModel: initialTierModels.balanced,
        status: "completed",
      },
    ]);
  });

  it("adopts and consumes a confirmed draft, checkpoints, completes, and continues", async () => {
    const { conversation, draft } = await adoptedConversation("Primera pregunta");
    const started = await generationService.startResponse(actor, conversation.id, randomUUID(), {
      content: [{ text: "Primera pregunta", type: "text" }],
      draftRevision: draft.revision,
      modelTier: "balanced",
      observedRevision: 0,
      parentMessageId: null,
      source: "draft",
    });

    expect(started).toMatchObject({ conversationId: conversation.id, revision: 1 });
    expect(started.request).toMatchObject({
      effectiveParameters: { purpose: "chat", tier: "balanced" },
      history: [],
      message: { role: "user", text: "Primera pregunta" },
      modelTier: "balanced",
      purpose: "chat",
      systemPrompt: { version: "capstone-chat-base-v2" },
    });
    expect(
      await conversationsService.getDraft(actor, {
        conversationId: conversation.id,
        kind: "conversation",
      }),
    ).toMatchObject({ content: "", revision: 0 });
    const generation = (await database.select().from(generations))[0];
    expect(generation).toMatchObject({
      assistantMessageId: started.messageId,
      effectiveParameters: {},
      requestedTier: "balanced",
      status: "active",
      systemPromptVersion: "capstone-chat-base-v2",
      workspacePromptRevision: 1,
    });

    const firstTokenAt = new Date(Date.now() + 10);
    expect(await generationService.checkpoint(started.generationId, "Parcial", firstTokenAt)).toBe(
      true,
    );
    const terminal = await terminalizeSettled(started.generationId, {
      content: "Respuesta limitada",
      errorCode: null,
      firstTokenAt,
      reason: "length",
      status: "completed",
    });
    expect(terminal).toMatchObject({
      reason: "length",
      revision: 2,
      status: "completed",
      won: true,
    });
    expect(await generationService.checkpoint(started.generationId, "late", firstTokenAt)).toBe(
      false,
    );
    expect(
      await generationService.responseStates(actor, conversation.id, [started.messageId]),
    ).toEqual({
      conversationId: conversation.id,
      responses: [
        {
          errorCode: null,
          generationId: started.generationId,
          messageId: started.messageId,
          reason: "length",
          status: "completed",
        },
      ],
      revision: 2,
    });

    const nextDraft = await conversationsService.saveDraft(
      actor,
      { conversationId: conversation.id, kind: "conversation" },
      "Borrador separado",
      0,
    );
    const continued = await generationService.startResponse(actor, conversation.id, randomUUID(), {
      modelTier: "balanced",
      observedRevision: 2,
      parentMessageId: started.messageId,
      source: "continue",
    });
    expect(continued.request.message.text).toBe(continueMessage.text);
    expect(
      await conversationsService.getDraft(actor, {
        conversationId: conversation.id,
        kind: "conversation",
      }),
    ).toMatchObject(nextDraft);
    const visible = await conversationsService.get(actor, conversation.id);
    expect(visible.messages.map((message) => message.content[0]?.text)).toContain(
      continueMessage.text,
    );
  });

  it("creates additive edit and retry branches from authoritative prefixes", async () => {
    const { conversation, draft } = await adoptedConversation("Pregunta raíz original");
    const first = await generationService.startResponse(actor, conversation.id, randomUUID(), {
      content: [{ text: "Pregunta raíz original", type: "text" }],
      draftRevision: draft.revision,
      modelTier: "balanced",
      observedRevision: 0,
      parentMessageId: null,
      source: "draft",
    });
    await terminalizeSettled(first.generationId, {
      content: "Primera respuesta",
      errorCode: null,
      firstTokenAt: new Date(),
      reason: "stop",
      status: "completed",
    });

    const secondDraft = await conversationsService.saveDraft(
      actor,
      { conversationId: conversation.id, kind: "conversation" },
      "Segunda pregunta original",
      0,
    );
    const second = await generationService.startResponse(actor, conversation.id, randomUUID(), {
      content: [{ text: "Segunda pregunta original", type: "text" }],
      draftRevision: secondDraft.revision,
      modelTier: "balanced",
      observedRevision: 2,
      parentMessageId: first.messageId,
      source: "draft",
    });
    await terminalizeSettled(second.generationId, {
      content: "Segunda respuesta original",
      errorCode: null,
      firstTokenAt: new Date(),
      reason: "stop",
      status: "completed",
    });
    const preservedDraft = await conversationsService.saveDraft(
      actor,
      { conversationId: conversation.id, kind: "conversation" },
      "Borrador que no se consume",
      0,
    );
    const originalTitle = (await conversationsService.get(actor, conversation.id)).conversation
      .title;

    const edited = await generationService.startResponse(actor, conversation.id, randomUUID(), {
      content: [{ text: "Segunda pregunta editada", type: "text" }],
      modelTier: "balanced",
      observedRevision: 4,
      parentMessageId: first.messageId,
      source: "edit",
      targetMessageId: second.userMessageId,
    });
    expect(edited).toMatchObject({ revision: 5 });
    expect(edited.request).toMatchObject({
      history: [
        { role: "user", text: "Pregunta raíz original" },
        { role: "assistant", text: "Primera respuesta" },
      ],
      message: { role: "user", text: "Segunda pregunta editada" },
    });
    expect(edited.userMessageId).not.toBe(second.userMessageId);
    expect(
      await conversationsService.getDraft(actor, {
        conversationId: conversation.id,
        kind: "conversation",
      }),
    ).toMatchObject(preservedDraft);
    expect((await conversationsService.get(actor, conversation.id)).conversation.title).toBe(
      originalTitle,
    );
    await terminalizeSettled(edited.generationId, {
      content: "Segunda respuesta editada",
      errorCode: null,
      firstTokenAt: new Date(),
      reason: "stop",
      status: "completed",
    });

    const retried = await generationService.startResponse(actor, conversation.id, randomUUID(), {
      modelTier: "balanced",
      observedRevision: 6,
      parentMessageId: edited.userMessageId,
      source: "retry",
      targetMessageId: edited.messageId,
    });
    expect(retried).toMatchObject({ revision: 7, userMessageId: edited.userMessageId });
    expect(retried.messageId).not.toBe(edited.messageId);
    expect(retried.request).toMatchObject({
      history: [
        { role: "user", text: "Pregunta raíz original" },
        { role: "assistant", text: "Primera respuesta" },
      ],
      message: { role: "user", text: "Segunda pregunta editada" },
    });
    await terminalizeSettled(retried.generationId, {
      content: "Segunda respuesta reintentada",
      errorCode: null,
      firstTokenAt: new Date(),
      reason: "stop",
      status: "completed",
    });

    const rootEdit = await generationService.startResponse(actor, conversation.id, randomUUID(), {
      content: [{ text: "Pregunta raíz editada", type: "text" }],
      modelTier: "balanced",
      observedRevision: 8,
      parentMessageId: null,
      source: "edit",
      targetMessageId: first.userMessageId,
    });
    expect(rootEdit.request).toMatchObject({
      history: [],
      message: { role: "user", text: "Pregunta raíz editada" },
    });
    await terminalizeSettled(rootEdit.generationId, {
      content: "Primera respuesta editada",
      errorCode: null,
      firstTokenAt: new Date(),
      reason: "stop",
      status: "completed",
    });
    const firstAnswerRetry = await generationService.startResponse(
      actor,
      conversation.id,
      randomUUID(),
      {
        modelTier: "balanced",
        observedRevision: 10,
        parentMessageId: rootEdit.userMessageId,
        source: "retry",
        targetMessageId: rootEdit.messageId,
      },
    );
    expect(firstAnswerRetry.request).toMatchObject({
      history: [],
      message: { role: "user", text: "Pregunta raíz editada" },
    });
    expect(firstAnswerRetry.userMessageId).toBe(rootEdit.userMessageId);

    const storedMessages = await database
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversation.id));
    expect(storedMessages).toHaveLength(10);
    expect(storedMessages.some((message) => message.id === second.messageId)).toBe(true);
    expect(storedMessages.some((message) => message.id === edited.messageId)).toBe(true);
    expect(storedMessages.filter((message) => message.id === edited.userMessageId)).toHaveLength(1);
    expect((await conversationsService.get(actor, conversation.id)).conversation.title).toBe(
      originalTitle,
    );
  });

  it("rejects invalid edit and retry targets without mutating the tree or draft", async () => {
    const { conversation, draft } = await adoptedConversation("Pregunta original");
    const started = await generationService.startResponse(actor, conversation.id, randomUUID(), {
      content: [{ text: "Pregunta original", type: "text" }],
      draftRevision: draft.revision,
      modelTier: "balanced",
      observedRevision: 0,
      parentMessageId: null,
      source: "draft",
    });
    await terminalizeSettled(started.generationId, {
      content: "Respuesta original",
      errorCode: null,
      firstTokenAt: new Date(),
      reason: "stop",
      status: "completed",
    });
    const preservedDraft = await conversationsService.saveDraft(
      actor,
      { conversationId: conversation.id, kind: "conversation" },
      "Borrador preservado",
      0,
    );
    const alternateRootRows = await database
      .insert(messages)
      .values({
        content: [{ text: "Pregunta no seleccionada", type: "text" }],
        conversationId: conversation.id,
        parentMessageId: null,
        role: "user",
      })
      .returning();
    const alternateRoot = alternateRootRows[0];
    if (alternateRoot === undefined) throw new Error("Missing non-selected root fixture");
    const alternateAssistantRows = await database
      .insert(messages)
      .values({
        content: [{ text: "Respuesta no seleccionada", type: "text" }],
        conversationId: conversation.id,
        parentMessageId: alternateRoot.id,
        role: "assistant",
      })
      .returning();
    const alternateAssistant = alternateAssistantRows[0];
    if (alternateAssistant === undefined) throw new Error("Missing non-selected answer fixture");

    const foreignConversation = await conversationsService.create(actor);
    const foreignUser = await conversationsService.insertImmutableMessage(actor, {
      content: [{ text: "Pregunta de otra conversación", type: "text" }],
      conversationId: foreignConversation.id,
      parentMessageId: null,
      role: "user",
    });
    const foreignAssistant = await conversationsService.insertImmutableMessage(actor, {
      content: [{ text: "Respuesta de otra conversación", type: "text" }],
      conversationId: foreignConversation.id,
      parentMessageId: foreignUser.id,
      role: "assistant",
    });
    const messageCount = (
      await database.select().from(messages).where(eq(messages.conversationId, conversation.id))
    ).length;

    await expectCode(
      generationService.startResponse(actor, conversation.id, randomUUID(), {
        content: [{ text: "Pregunta original", type: "text" }],
        modelTier: "balanced",
        observedRevision: 2,
        parentMessageId: null,
        source: "edit",
        targetMessageId: started.userMessageId,
      }),
      "BAD_REQUEST",
    );
    await expectCode(
      generationService.startResponse(actor, conversation.id, randomUUID(), {
        content: [{ text: "Rol incorrecto", type: "text" }],
        modelTier: "balanced",
        observedRevision: 2,
        parentMessageId: started.userMessageId,
        source: "edit",
        targetMessageId: started.messageId,
      }),
      "BAD_REQUEST",
    );
    await expectCode(
      generationService.startResponse(actor, conversation.id, randomUUID(), {
        content: [{ text: "Padre incorrecto", type: "text" }],
        modelTier: "balanced",
        observedRevision: 2,
        parentMessageId: started.messageId,
        source: "edit",
        targetMessageId: started.userMessageId,
      }),
      "BAD_REQUEST",
    );
    await expectCode(
      generationService.startResponse(actor, conversation.id, randomUUID(), {
        modelTier: "balanced",
        observedRevision: 2,
        parentMessageId: started.userMessageId,
        source: "retry",
        targetMessageId: started.userMessageId,
      }),
      "BAD_REQUEST",
    );
    await expectCode(
      generationService.startResponse(actor, conversation.id, randomUUID(), {
        modelTier: "balanced",
        observedRevision: 2,
        parentMessageId: started.messageId,
        source: "retry",
        targetMessageId: started.messageId,
      }),
      "BAD_REQUEST",
    );
    for (const invalidTarget of [
      { assistant: alternateAssistant.id, user: alternateRoot.id },
      { assistant: foreignAssistant.id, user: foreignUser.id },
    ]) {
      await expectCode(
        generationService.startResponse(actor, conversation.id, randomUUID(), {
          content: [{ text: "Edición inválida", type: "text" }],
          modelTier: "balanced",
          observedRevision: 2,
          parentMessageId: null,
          source: "edit",
          targetMessageId: invalidTarget.user,
        }),
        "BAD_REQUEST",
      );
      await expectCode(
        generationService.startResponse(actor, conversation.id, randomUUID(), {
          modelTier: "balanced",
          observedRevision: 2,
          parentMessageId: invalidTarget.user,
          source: "retry",
          targetMessageId: invalidTarget.assistant,
        }),
        "BAD_REQUEST",
      );
    }
    await expectCode(
      generationService.startResponse(actor, conversation.id, randomUUID(), {
        content: [{ text: "   \n\t", type: "text" }],
        modelTier: "balanced",
        observedRevision: 2,
        parentMessageId: null,
        source: "edit",
        targetMessageId: started.userMessageId,
      }),
      "BAD_REQUEST",
    );
    await expectCode(
      generationService.startResponse(actor, conversation.id, randomUUID(), {
        content: [{ text: "ñ".repeat(16_385), type: "text" }],
        modelTier: "balanced",
        observedRevision: 2,
        parentMessageId: null,
        source: "edit",
        targetMessageId: started.userMessageId,
      }),
      "MESSAGE_TOO_LARGE",
    );
    await expectCode(
      generationService.startResponse(actor, conversation.id, randomUUID(), {
        modelTier: "balanced",
        observedRevision: 1,
        parentMessageId: started.userMessageId,
        source: "retry",
        targetMessageId: started.messageId,
      }),
      "CONVERSATION_CHANGED",
    );

    expect(
      await database.select().from(messages).where(eq(messages.conversationId, conversation.id)),
    ).toHaveLength(messageCount);
    expect(
      await conversationsService.getDraft(actor, {
        conversationId: conversation.id,
        kind: "conversation",
      }),
    ).toMatchObject(preservedDraft);

    const archived = await conversationsService.setArchived(actor, conversation.id, true, 2);
    for (const request of [
      {
        content: [{ text: "Edición archivada", type: "text" as const }],
        modelTier: "balanced" as const,
        observedRevision: archived.revision,
        parentMessageId: null,
        source: "edit" as const,
        targetMessageId: started.userMessageId,
      },
      {
        modelTier: "balanced" as const,
        observedRevision: archived.revision,
        parentMessageId: started.userMessageId,
        source: "retry" as const,
        targetMessageId: started.messageId,
      },
    ]) {
      await expectCode(
        generationService.startResponse(actor, conversation.id, randomUUID(), request),
        "CONVERSATION_ARCHIVED",
      );
    }
    const unarchived = await conversationsService.setArchived(
      actor,
      conversation.id,
      false,
      archived.revision,
    );

    const concurrentEdits = [
      {
        key: randomUUID(),
        request: {
          content: [{ text: "Edición concurrente uno", type: "text" as const }],
          modelTier: "balanced" as const,
          observedRevision: unarchived.revision,
          parentMessageId: null,
          source: "edit" as const,
          targetMessageId: started.userMessageId,
        },
      },
      {
        key: randomUUID(),
        request: {
          content: [{ text: "Edición concurrente dos", type: "text" as const }],
          modelTier: "balanced" as const,
          observedRevision: unarchived.revision,
          parentMessageId: null,
          source: "edit" as const,
          targetMessageId: started.userMessageId,
        },
      },
    ];
    const concurrentResults = await Promise.allSettled(
      concurrentEdits.map(({ key, request }) =>
        generationService.startResponse(actor, conversation.id, key, request),
      ),
    );
    expect(concurrentResults.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(concurrentResults.find((result) => result.status === "rejected")).toMatchObject({
      reason: { code: "GENERATION_ACTIVE" },
      status: "rejected",
    });
    const winnerIndex = concurrentResults.findIndex((result) => result.status === "fulfilled");
    const winner = concurrentEdits[winnerIndex];
    if (winner === undefined) throw new Error("Concurrent edit did not produce a winner");
    await expectCode(
      generationService.startResponse(actor, conversation.id, winner.key, winner.request),
      "GENERATION_ALREADY_EXISTS",
    );
    await expectCode(
      generationService.startResponse(actor, conversation.id, randomUUID(), {
        modelTier: "balanced",
        observedRevision: unarchived.revision + 1,
        parentMessageId: started.userMessageId,
        source: "retry",
        targetMessageId: started.messageId,
      }),
      "GENERATION_ACTIVE",
    );
    expect(
      await database.select().from(messages).where(eq(messages.conversationId, conversation.id)),
    ).toHaveLength(messageCount + 2);
    expect(
      await conversationsService.getDraft(actor, {
        conversationId: conversation.id,
        kind: "conversation",
      }),
    ).toMatchObject(preservedDraft);
  });

  it("orders idempotency ahead of active conflicts and cancels idempotently", async () => {
    const { conversation, draft } = await adoptedConversation("Pregunta segura");
    const idempotencyKey = randomUUID();
    const secondSessionAt = new Date();
    const secondSessionId = `session-${randomUUID()}`;
    await database.insert(authenticationSessions).values({
      createdAt: secondSessionAt,
      expiresAt: new Date(secondSessionAt.getTime() + 24 * 60 * 60 * 1_000),
      id: secondSessionId,
      token: `token-${randomUUID()}`,
      updatedAt: secondSessionAt,
      userId: actor.employee.id,
    });
    const actors = [
      actor,
      { ...actor, session: { ...actor.session, id: secondSessionId } },
    ] as const;
    const input = {
      content: [{ text: "Pregunta segura", type: "text" as const }],
      draftRevision: draft.revision,
      modelTier: "balanced" as const,
      observedRevision: 0,
      parentMessageId: null,
      source: "draft" as const,
    };
    const budget = createBudgetService(database);
    let arrivals = 0;
    let releaseBarrier: () => void = () => undefined;
    const barrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    const concurrentService = createGenerationService(database, {
      budget: {
        ...budget,
        async lockAdmissionAuthority(...argumentsList) {
          arrivals += 1;
          if (arrivals === 2) {
            releaseBarrier();
          }
          await barrier;
          return budget.lockAdmissionAuthority(...argumentsList);
        },
      },
    });
    const concurrent = await Promise.allSettled(
      actors.map((requestActor) =>
        concurrentService.startResponse(requestActor, conversation.id, idempotencyKey, input),
      ),
    );
    expect(arrivals).toBe(2);
    expect(concurrent.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(concurrent.find((result) => result.status === "rejected")).toMatchObject({
      reason: { code: "GENERATION_ALREADY_EXISTS" },
      status: "rejected",
    });
    const winner = concurrent.find((result) => result.status === "fulfilled");
    if (winner?.status !== "fulfilled") {
      throw new Error("Concurrent idempotent response did not produce a winner");
    }
    const started = winner.value;
    await expectCode(
      generationService.startResponse(actor, conversation.id, idempotencyKey, input),
      "GENERATION_ALREADY_EXISTS",
    );
    await expectCode(
      generationService.startResponse(actor, conversation.id, randomUUID(), {
        ...input,
        observedRevision: 1,
        parentMessageId: started.messageId,
      }),
      "GENERATION_ACTIVE",
    );
    await expectCode(
      conversationsService.selectLeaf(actor, conversation.id, started.userMessageId, 1),
      "GENERATION_ACTIVE",
    );
    const otherUserId = `user-${randomUUID()}`;
    await database.insert(user).values({
      email: "other-member@example.test",
      emailVerified: true,
      id: otherUserId,
      name: "Other member",
    });
    const otherActor = createActor(otherUserId, actor.workspace.id);
    await expectCode(
      generationService.cancel(otherActor, conversation.id, started.generationId),
      "NOT_FOUND",
    );
    await expectCode(
      generationService.responseStates(otherActor, conversation.id, [started.messageId]),
      "NOT_FOUND",
    );

    const cancellationFloor = new Date(Date.now() + 60_000);
    await database
      .update(generations)
      .set({
        createdAt: cancellationFloor,
        startedAt: cancellationFloor,
        updatedAt: cancellationFloor,
      })
      .where(eq(generations.id, started.generationId));
    expect(await generationService.cancel(actor, conversation.id, started.generationId)).toBe(true);
    expect(await generationService.cancel(actor, conversation.id, started.generationId)).toBe(
      false,
    );
    expect(await generationService.readState(started.generationId)).toMatchObject({
      reason: "cancelled",
      revision: 2,
      status: "cancelled",
    });
    const cancelled = (await database.select().from(generations))[0];
    expect(cancelled?.completedAt?.getTime()).toBeGreaterThanOrEqual(cancellationFloor.getTime());
    expect(cancelled?.updatedAt.getTime()).toBeGreaterThanOrEqual(cancellationFloor.getTime());
  });

  it("keeps the latest durable checkpoint when another replica cancels", async () => {
    const { conversation, draft } = await adoptedConversation("Pregunta entre réplicas");
    const started = await generationService.startResponse(actor, conversation.id, randomUUID(), {
      content: [{ text: "Pregunta entre réplicas", type: "text" }],
      draftRevision: draft.revision,
      modelTier: "balanced",
      observedRevision: 0,
      parentMessageId: null,
      source: "draft",
    });
    const firstTokenAt = new Date();
    expect(
      await generationService.checkpoint(
        started.generationId,
        "Último checkpoint durable",
        firstTokenAt,
      ),
    ).toBe(true);

    const replicaPool = new Pool({ connectionString: databaseUrl });
    const replica = createGenerationService(createDatabase(replicaPool));
    try {
      expect(await replica.cancel(actor, conversation.id, started.generationId)).toBe(true);
    } finally {
      await replicaPool.end();
    }

    const canonical = await conversationsService.get(actor, conversation.id);
    expect(canonical.messages.at(-1)?.content).toEqual([
      { text: "Último checkpoint durable", type: "text" },
    ]);
    expect(await generationService.readState(started.generationId)).toMatchObject({
      reason: "cancelled",
      revision: 2,
      status: "cancelled",
    });
    const stored = (await database.select().from(generations))[0];
    expect(stored?.firstTokenAt?.getTime()).toBeGreaterThanOrEqual(firstTokenAt.getTime());
    expect(
      await generationService.checkpoint(
        started.generationId,
        "Texto no durable de la otra réplica",
        new Date(),
      ),
    ).toBe(false);
    expect(
      await terminalizeSettled(started.generationId, {
        content: "Final tardío",
        errorCode: null,
        firstTokenAt: new Date(),
        reason: "stop",
        status: "completed",
      }),
    ).toMatchObject({ reason: "cancelled", status: "cancelled", won: false });
  });

  it("clamps gateway timestamps to authoritative database lifecycle floors", async () => {
    const { conversation, draft } = await adoptedConversation("Pregunta con reloj adelantado");
    const started = await generationService.startResponse(actor, conversation.id, randomUUID(), {
      content: [{ text: "Pregunta con reloj adelantado", type: "text" }],
      draftRevision: draft.revision,
      modelTier: "balanced",
      observedRevision: 0,
      parentMessageId: null,
      source: "draft",
    });
    const databaseFloor = new Date(Date.now() + 60_000);
    await database
      .update(generations)
      .set({ createdAt: databaseFloor, startedAt: databaseFloor, updatedAt: databaseFloor })
      .where(eq(generations.id, started.generationId));

    const terminal = await terminalizeSettled(started.generationId, {
      content: "Respuesta segura",
      errorCode: null,
      firstTokenAt: new Date(0),
      reason: "stop",
      status: "completed",
    });
    expect(terminal.won).toBe(true);
    const stored = (
      await database.select().from(generations).where(eq(generations.id, started.generationId))
    )[0];
    expect(stored?.firstTokenAt?.getTime()).toBeGreaterThanOrEqual(databaseFloor.getTime());
    expect(stored?.completedAt?.getTime()).toBeGreaterThanOrEqual(databaseFloor.getTime());
    expect(stored?.updatedAt.getTime()).toBeGreaterThanOrEqual(databaseFloor.getTime());
  });

  it("atomically cancels deletion and retains only non-content generation metadata", async () => {
    const { conversation, draft } = await adoptedConversation("Pregunta eliminable");
    const started = await generationService.startResponse(actor, conversation.id, randomUUID(), {
      content: [{ text: "Pregunta eliminable", type: "text" }],
      draftRevision: draft.revision,
      modelTier: "balanced",
      observedRevision: 0,
      parentMessageId: null,
      source: "draft",
    });
    const deletionFloor = new Date(Date.now() + 60_000);
    await database
      .update(generations)
      .set({ createdAt: deletionFloor, startedAt: deletionFloor, updatedAt: deletionFloor })
      .where(eq(generations.id, started.generationId));
    await generationService.checkpoint(
      started.generationId,
      "Contenido privado parcial",
      new Date(),
    );
    expect(await generationService.removeConversation(actor, conversation.id, 1)).toBe(
      started.generationId,
    );

    expect(await database.select().from(conversations)).toEqual([]);
    expect(await database.select().from(messages)).toEqual([]);
    expect(await database.select().from(drafts)).toEqual([]);
    const retainedGenerations = await database.select().from(generations);
    expect(retainedGenerations).toMatchObject([
      {
        assistantMessageId: null,
        conversationId: null,
        errorCode: null,
        status: "cancelled",
        terminalReason: "cancelled",
      },
    ]);
    expect(retainedGenerations[0]?.firstTokenAt?.getTime()).toBeGreaterThanOrEqual(
      deletionFloor.getTime(),
    );
    expect(retainedGenerations[0]?.completedAt?.getTime()).toBeGreaterThanOrEqual(
      deletionFloor.getTime(),
    );
  });

  it("does not create a conversation when draft adoption is stale or empty", async () => {
    const saved = await conversationsService.saveDraft(actor, { kind: "new" }, "Texto", 0);
    await expectCode(conversationsService.create(actor, saved.revision + 1), "DRAFT_CHANGED");
    expect(await database.select().from(conversations)).toEqual([]);
    await conversationsService.saveDraft(actor, { kind: "new" }, "   ", saved.revision);
    await expectCode(conversationsService.create(actor, saved.revision + 1), "BAD_REQUEST");
    expect(await database.select().from(conversations)).toEqual([]);
  });

  it("bounds authoritative context before persistence and preserves the draft", async () => {
    const conversation = await conversationsService.create(actor);
    const root = await conversationsService.insertImmutableMessage(actor, {
      content: [{ text: "context root", type: "text" }],
      conversationId: conversation.id,
      parentMessageId: null,
      role: "user",
    });
    const oversizedAssistant = await conversationsService.insertImmutableMessage(actor, {
      content: [{ text: "x".repeat(1_048_000), type: "text" }],
      conversationId: conversation.id,
      parentMessageId: root.id,
      role: "assistant",
    });
    await database
      .update(conversations)
      .set({ selectedLeafMessageId: oversizedAssistant.id })
      .where(eq(conversations.id, conversation.id));
    const draft = await conversationsService.saveDraft(
      actor,
      { conversationId: conversation.id, kind: "conversation" },
      "Nueva pregunta",
      0,
    );

    await expectCode(
      generationService.startResponse(actor, conversation.id, randomUUID(), {
        content: [{ text: "Nueva pregunta", type: "text" }],
        draftRevision: draft.revision + 1,
        modelTier: "balanced",
        observedRevision: 0,
        parentMessageId: oversizedAssistant.id,
        source: "draft",
      }),
      "DRAFT_CHANGED",
    );
    await expectCode(
      generationService.startResponse(actor, conversation.id, randomUUID(), {
        content: [{ text: "Nueva pregunta", type: "text" }],
        draftRevision: draft.revision,
        modelTier: "balanced",
        observedRevision: 0,
        parentMessageId: oversizedAssistant.id,
        source: "draft",
      }),
      "MESSAGE_TOO_LARGE",
    );
    expect(await database.select().from(generations)).toEqual([]);
    expect(await database.select().from(messages)).toHaveLength(2);
    expect(
      await conversationsService.getDraft(actor, {
        conversationId: conversation.id,
        kind: "conversation",
      }),
    ).toMatchObject(draft);
  });

  it("serializes concurrent sends as one start and one active conflict", async () => {
    const { conversation, draft } = await adoptedConversation("Pregunta concurrente");
    const input = {
      content: [{ text: "Pregunta concurrente", type: "text" as const }],
      draftRevision: draft.revision,
      modelTier: "balanced" as const,
      observedRevision: 0,
      parentMessageId: null,
      source: "draft" as const,
    };
    const results = await Promise.allSettled([
      generationService.startResponse(actor, conversation.id, randomUUID(), input),
      generationService.startResponse(actor, conversation.id, randomUUID(), input),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({
      reason: { code: "GENERATION_ACTIVE" },
      status: "rejected",
    });
  });

  it("resolves completion and deletion without a lock inversion", async () => {
    const { conversation, draft } = await adoptedConversation("Pregunta de carrera");
    const started = await generationService.startResponse(actor, conversation.id, randomUUID(), {
      content: [{ text: "Pregunta de carrera", type: "text" }],
      draftRevision: draft.revision,
      modelTier: "balanced",
      observedRevision: 0,
      parentMessageId: null,
      source: "draft",
    });
    const outcomes = await Promise.race([
      Promise.allSettled([
        terminalizeSettled(started.generationId, {
          content: "Respuesta de carrera",
          errorCode: null,
          firstTokenAt: new Date(),
          reason: "stop",
          status: "completed",
        }),
        generationService.removeConversation(actor, conversation.id, 1),
      ]),
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error("Generation deletion race timed out")), 2_000);
      }),
    ]);
    expect(outcomes).toHaveLength(2);
    const state = await generationService.readState(started.generationId);
    expect(state).toMatchObject({ status: expect.stringMatching(/^(cancelled|completed)$/u) });
    expect(
      await generationService.checkpoint(started.generationId, "resurrección tardía", new Date()),
    ).toBe(false);
    if (state?.conversationId === null) {
      expect(state).toMatchObject({ reason: "cancelled", status: "cancelled" });
      expect(await database.select().from(conversations)).toEqual([]);
      expect(await database.select().from(messages)).toEqual([]);
    } else {
      expect(state).toMatchObject({ reason: "stop", status: "completed" });
      expect(
        (await conversationsService.get(actor, conversation.id)).messages.at(-1)?.content,
      ).toEqual([{ text: "Respuesta de carrera", type: "text" }]);
    }
  });

  it("serializes completion and local cancellation through one terminal winner", async () => {
    const { conversation, draft } = await adoptedConversation("Pregunta cancelable en carrera");
    const started = await generationService.startResponse(actor, conversation.id, randomUUID(), {
      content: [{ text: "Pregunta cancelable en carrera", type: "text" }],
      draftRevision: draft.revision,
      modelTier: "balanced",
      observedRevision: 0,
      parentMessageId: null,
      source: "draft",
    });
    const firstTokenAt = new Date();
    const [completion, cancellation] = await Promise.all([
      terminalizeSettled(started.generationId, {
        content: "Respuesta completa ganadora",
        errorCode: null,
        firstTokenAt,
        reason: "stop",
        status: "completed",
      }),
      generationService.cancel(actor, conversation.id, started.generationId, () => ({
        content: "Parcial local visible",
        firstTokenAt,
      })),
    ]);
    expect(completion.won || cancellation).toBe(true);

    const state = await generationService.readState(started.generationId);
    const canonical = await conversationsService.get(actor, conversation.id);
    expect(state?.revision).toBe(2);
    if (completion.won && cancellation) {
      // Both may succeed only when Stop arrived during naming: it stops the title, never the
      // already completed answer.
      expect(state?.status).toBe("completed");
    }
    if (state?.status === "completed") {
      expect(state.reason).toBe("stop");
      expect(canonical.messages.at(-1)?.content).toEqual([
        { text: "Respuesta completa ganadora", type: "text" },
      ]);
    } else {
      expect(state).toMatchObject({ reason: "cancelled", status: "cancelled" });
      expect(canonical.messages.at(-1)?.content).toEqual([
        { text: "Parcial local visible", type: "text" },
      ]);
    }
    expect(
      await generationService.checkpoint(started.generationId, "checkpoint tardío", new Date()),
    ).toBe(false);
    expect(
      await terminalizeSettled(started.generationId, {
        content: "terminal tardío",
        errorCode: "GENERATION_FAILED",
        firstTokenAt: new Date(),
        reason: "error",
        status: "incomplete",
      }),
    ).toMatchObject({ status: state?.status, won: false });
    expect((await conversationsService.get(actor, conversation.id)).conversation.revision).toBe(2);
  });

  it("fences archive until terminalization and preserves the latest rename revision", async () => {
    const { conversation, draft } = await adoptedConversation("Pregunta con cambios estructurales");
    const started = await generationService.startResponse(actor, conversation.id, randomUUID(), {
      content: [{ text: "Pregunta con cambios estructurales", type: "text" }],
      draftRevision: draft.revision,
      modelTier: "balanced",
      observedRevision: 0,
      parentMessageId: null,
      source: "draft",
    });
    const renamed = await conversationsService.rename(
      actor,
      conversation.id,
      "Título durante generación",
      1,
    );
    expect(renamed.revision).toBe(2);
    await expectCode(
      conversationsService.setArchived(actor, conversation.id, true, 2),
      "GENERATION_ACTIVE",
    );

    const terminal = await terminalizeSettled(started.generationId, {
      content: "Respuesta después de cambios",
      errorCode: null,
      firstTokenAt: new Date(),
      reason: "stop",
      status: "completed",
    });
    expect(terminal).toMatchObject({ reason: "stop", revision: 3, status: "completed", won: true });
    const archived = await conversationsService.setArchived(actor, conversation.id, true, 3);
    expect(archived).toMatchObject({ isArchived: true, revision: 4 });
    expect((await conversationsService.get(actor, conversation.id)).conversation).toMatchObject({
      isArchived: true,
      revision: 4,
      title: "Título durante generación",
    });
  });

  it("returns response lifecycle and its structural revision from one coherent read", async () => {
    const { conversation, draft } = await adoptedConversation("Pregunta de estado");
    const started = await generationService.startResponse(actor, conversation.id, randomUUID(), {
      content: [{ text: "Pregunta de estado", type: "text" }],
      draftRevision: draft.revision,
      modelTier: "balanced",
      observedRevision: 0,
      parentMessageId: null,
      source: "draft",
    });
    const [state] = await Promise.all([
      generationService.responseStates(actor, conversation.id, [started.messageId]),
      terminalizeSettled(started.generationId, {
        content: "Respuesta final",
        errorCode: null,
        firstTokenAt: new Date(),
        reason: "stop",
        status: "completed",
      }),
    ]);
    const response = state.responses[0];
    expect(response).toBeDefined();
    if (response?.status === "active") {
      expect(state.revision).toBe(1);
    } else {
      expect(response?.status).toBe("completed");
      expect(state.revision).toBe(2);
    }
  });

  it("streams over a real listener with explicit headers and JSON-only preflight failures", async () => {
    const authentication = {
      auth: {
        api: {
          getSession: async () => ({
            headers: new Headers(),
            response: {
              session: {
                createdAt: actor.session.createdAt,
                expiresAt: actor.session.expiresAt,
                id: actor.session.id,
              },
              user: {
                email: actor.employee.email,
                emailVerified: true,
                id: actor.employee.id,
                name: actor.employee.name,
              },
            },
          }),
        },
        handler: async () => new Response(null, { status: 404 }),
      },
      revokeUserSessions: async () => undefined,
    } as unknown as Authentication;
    const identity = {
      findActiveMemberships: async () => [
        {
          role: actor.role,
          workspaceDisplayName: actor.workspace.name,
          workspaceId: actor.workspace.id,
          workspaceIdentity: actor.workspace.identity,
        },
      ],
    } as unknown as IdentityService;
    const logLines: string[] = [];
    const cancellableRequest = "Respuesta cancelable sin checkpoint";
    const cancellablePartial = "Parcial visible y todavía no checkpointed";
    let cancellableGatewaySignal: AbortSignal | undefined;
    const observedRequests: GenerationRequest[] = [];
    const ordinaryGateway = new FakeModelGateway([
      { event: { text: "Respuesta ", type: "content.delta" } },
      { event: { text: "simulada.", type: "content.delta" } },
      {
        event: {
          reason: "stop",
          type: "response.completed",
          usage: { inputTokens: 2, outputTokens: 2 },
        },
      },
    ]);
    const modelGateway: ModelGateway = {
      stream(request, signal) {
        observedRequests.push(request);
        if (request.message.text !== cancellableRequest) {
          return ordinaryGateway.stream(request, signal);
        }
        return (async function* () {
          cancellableGatewaySignal = signal;
          yield { text: cancellablePartial, type: "content.delta" } as const;
          signal.throwIfAborted();
          await new Promise<void>((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => reject(new DOMException("aborted", "AbortError")),
              { once: true },
            );
          });
        })();
      },
    };
    const listenerGenerations: GenerationService = {
      ...generationService,
      checkpoint: async () => false,
    };
    application = createApplication(
      loadConfig({
        DATABASE_URL: databaseUrl,
        LOG_LEVEL: "info",
        NODE_ENV: "test",
        PUBLIC_ORIGIN: "http://localhost:5173",
      }),
      {
        authentication,
        generations: listenerGenerations,
        identity,
        loggerStream: { write: (line) => logLines.push(line) },
        modelGateway,
        pool: new Pool({ connectionString: databaseUrl }),
        requestIdFactory: () => "stream-request-id",
      },
    );
    await application.server.listen({ host: "127.0.0.1", port: 0 });
    await application.lifecycle.initialize();
    const address = application.server.server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Real listener did not expose a TCP port");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const prepared = await adoptedConversation("contenido-sensible-de-prueba");
    const missingKey = await fetch(
      `${baseUrl}/api/conversations/${prepared.conversation.id}/responses`,
      {
        body: JSON.stringify({
          content: [{ text: "contenido-sensible-de-prueba", type: "text" }],
          draftRevision: prepared.draft.revision,
          modelTier: "balanced",
          observedRevision: 0,
          parentMessageId: null,
          source: "draft",
        }),
        headers: {
          accept: "application/x-ndjson",
          "content-type": "application/json",
          origin: "http://localhost:5173",
        },
        method: "POST",
      },
    );
    expect(missingKey.status).toBe(400);
    expect(await missingKey.json()).toMatchObject({ code: "IDEMPOTENCY_KEY_REQUIRED" });

    const malformedKey = await fetch(
      `${baseUrl}/api/conversations/${prepared.conversation.id}/responses`,
      {
        body: JSON.stringify({
          content: [{ text: "contenido-sensible-de-prueba", type: "text" }],
          draftRevision: prepared.draft.revision,
          modelTier: "balanced",
          observedRevision: 0,
          parentMessageId: null,
          source: "draft",
        }),
        headers: {
          accept: "application/x-ndjson",
          "content-type": "application/json",
          "idempotency-key": randomUUID().toUpperCase(),
          origin: "http://localhost:5173",
        },
        method: "POST",
      },
    );
    expect(malformedKey.status).toBe(400);
    expect(await malformedKey.json()).toMatchObject({ code: "IDEMPOTENCY_KEY_INVALID" });

    const streamed = await fetch(
      `${baseUrl}/api/conversations/${prepared.conversation.id}/responses`,
      {
        body: JSON.stringify({
          content: [{ text: "contenido-sensible-de-prueba", type: "text" }],
          draftRevision: prepared.draft.revision,
          modelTier: "balanced",
          observedRevision: 0,
          parentMessageId: null,
          source: "draft",
        }),
        headers: {
          accept: "application/x-ndjson",
          "content-type": "application/json",
          "idempotency-key": randomUUID(),
          origin: "http://localhost:5173",
        },
        method: "POST",
      },
    );
    expect(streamed.status).toBe(200);
    expect(streamed.headers.get("content-type")).toBe("application/x-ndjson");
    expect(streamed.headers.get("cache-control")).toBe("no-store, no-transform");
    expect(streamed.headers.get("x-content-type-options")).toBe("nosniff");
    expect(streamed.headers.get("x-request-id")).toBe("stream-request-id");
    const events = (await streamed.text())
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            messageId?: string;
            revision?: number;
            type: string;
            userMessageId?: string;
          },
      );
    expect(events.map((event) => event.type)).toEqual([
      "response.started",
      "content.delta",
      "content.delta",
      "conversation.naming",
      "response.completed",
    ]);
    const namedConversation = await conversationsService.get(actor, prepared.conversation.id);
    expect(namedConversation.messages.at(-1)?.content).toEqual([
      { text: "Respuesta simulada.", type: "text" },
    ]);
    expect(namedConversation.conversation.title).toBe("Conversación simulada");
    expect(events.at(-1)?.revision).toBe(namedConversation.conversation.revision);
    const capturedLogs = logLines.join("\n");
    expect(capturedLogs).not.toContain("contenido-sensible-de-prueba");
    expect(capturedLogs).not.toContain("Respuesta simulada");
    expect(capturedLogs).not.toContain(systemPrompt.text);
    expect(capturedLogs).not.toContain(continueMessage.text);
    expect(capturedLogs).not.toContain("content.delta");

    const originalStarted = events.find((event) => event.type === "response.started");
    if (
      originalStarted?.messageId === undefined ||
      originalStarted.userMessageId === undefined ||
      originalStarted.revision === undefined
    ) {
      throw new Error("Initial real HTTP stream did not expose canonical identifiers");
    }
    const editedResponse = await fetch(
      `${baseUrl}/api/conversations/${prepared.conversation.id}/responses`,
      {
        body: JSON.stringify({
          content: [{ text: "contenido editado por HTTP", type: "text" }],
          modelTier: "balanced",
          observedRevision: originalStarted.revision + 1,
          parentMessageId: null,
          source: "edit",
          targetMessageId: originalStarted.userMessageId,
        }),
        headers: {
          accept: "application/x-ndjson",
          "content-type": "application/json",
          "idempotency-key": randomUUID(),
          origin: "http://localhost:5173",
        },
        method: "POST",
      },
    );
    expect(editedResponse.status).toBe(200);
    const editedEvents = (await editedResponse.text())
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            messageId?: string;
            revision?: number;
            type: string;
            userMessageId?: string;
          },
      );
    expect(editedEvents.map((event) => event.type)).toEqual([
      "response.started",
      "content.delta",
      "content.delta",
      "response.completed",
    ]);
    const editedStarted = editedEvents.find((event) => event.type === "response.started");
    if (
      editedStarted?.messageId === undefined ||
      editedStarted.userMessageId === undefined ||
      editedStarted.revision === undefined
    ) {
      throw new Error("Edit real HTTP stream did not expose canonical identifiers");
    }
    expect(editedStarted.userMessageId).not.toBe(originalStarted.userMessageId);

    const retriedResponse = await fetch(
      `${baseUrl}/api/conversations/${prepared.conversation.id}/responses`,
      {
        body: JSON.stringify({
          modelTier: "balanced",
          observedRevision: editedStarted.revision + 1,
          parentMessageId: editedStarted.userMessageId,
          source: "retry",
          targetMessageId: editedStarted.messageId,
        }),
        headers: {
          accept: "application/x-ndjson",
          "content-type": "application/json",
          "idempotency-key": randomUUID(),
          origin: "http://localhost:5173",
        },
        method: "POST",
      },
    );
    expect(retriedResponse.status).toBe(200);
    const retriedEvents = (await retriedResponse.text())
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            type: string;
            userMessageId?: string;
          },
      );
    expect(retriedEvents.map((event) => event.type)).toEqual([
      "response.started",
      "content.delta",
      "content.delta",
      "response.completed",
    ]);
    expect(retriedEvents.find((event) => event.type === "response.started")).toMatchObject({
      userMessageId: editedStarted.userMessageId,
    });
    // The hidden title call follows the first answer; edits and retries never retitle.
    expect(observedRequests.map((request) => request.purpose)).toEqual([
      "chat",
      "title",
      "chat",
      "chat",
    ]);
    expect(observedRequests.filter((request) => request.purpose === "chat")).toMatchObject([
      { history: [], message: { text: "contenido-sensible-de-prueba" } },
      { history: [], message: { text: "contenido editado por HTTP" } },
      { history: [], message: { text: "contenido editado por HTTP" } },
    ]);
    expect(observedRequests[1]).toMatchObject({
      history: [
        { role: "user", text: "contenido-sensible-de-prueba" },
        { role: "assistant", text: "Respuesta simulada." },
      ],
      modelTier: "fast",
      purpose: "title",
    });

    const oversizedConversation = await conversationsService.create(actor);
    const messageTooLarge = await fetch(
      `${baseUrl}/api/conversations/${oversizedConversation.id}/responses`,
      {
        body: JSON.stringify({
          content: [{ text: "ñ".repeat(16_385), type: "text" }],
          draftRevision: 0,
          modelTier: "balanced",
          observedRevision: 0,
          parentMessageId: null,
          source: "draft",
        }),
        headers: {
          accept: "application/x-ndjson",
          "content-type": "application/json",
          "idempotency-key": randomUUID(),
          origin: "http://localhost:5173",
        },
        method: "POST",
      },
    );
    expect(messageTooLarge.status).toBe(413);
    expect(await messageTooLarge.json()).toMatchObject({ code: "MESSAGE_TOO_LARGE" });

    const cancellable = await adoptedConversation(cancellableRequest);
    const cancellableStream = await fetch(
      `${baseUrl}/api/conversations/${cancellable.conversation.id}/responses`,
      {
        body: JSON.stringify({
          content: [{ text: cancellableRequest, type: "text" }],
          draftRevision: cancellable.draft.revision,
          modelTier: "balanced",
          observedRevision: 0,
          parentMessageId: null,
          source: "draft",
        }),
        headers: {
          accept: "application/x-ndjson",
          "content-type": "application/json",
          "idempotency-key": randomUUID(),
          origin: "http://localhost:5173",
        },
        method: "POST",
      },
    );
    const cancellableReader = cancellableStream.body?.getReader();
    if (cancellableReader === undefined) {
      throw new Error("Cancellable stream did not expose a reader");
    }
    const cancellableDecoder = new TextDecoder();
    let cancellableBody = "";
    while (!cancellableBody.includes(cancellablePartial)) {
      const chunk = await cancellableReader.read();
      if (chunk.done) {
        throw new Error("Cancellable stream ended before its visible partial");
      }
      cancellableBody += cancellableDecoder.decode(chunk.value, { stream: true });
    }
    const cancellableStarted = cancellableBody
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            generationId?: string;
            messageId?: string;
            type: string;
          },
      )
      .find((event) => event.type === "response.started");
    if (!cancellableStarted?.generationId || !cancellableStarted.messageId) {
      throw new Error("Cancellable stream did not start canonically");
    }
    expect(
      (await conversationsService.get(actor, cancellable.conversation.id)).messages.at(-1)?.content,
    ).toEqual([{ text: "", type: "text" }]);
    expect(
      (
        await database
          .select({ firstTokenAt: generations.firstTokenAt })
          .from(generations)
          .where(eq(generations.id, cancellableStarted.generationId))
      )[0]?.firstTokenAt,
    ).toBeNull();
    const cancelledResponse = await fetch(
      `${baseUrl}/api/conversations/${cancellable.conversation.id}/responses/${cancellableStarted.generationId}/cancel`,
      {
        body: "{}",
        headers: {
          "content-type": "application/json",
          origin: "http://localhost:5173",
        },
        method: "POST",
      },
    );
    expect(cancelledResponse.status).toBe(204);
    expect(await cancelledResponse.text()).toBe("");
    while (true) {
      const chunk = await cancellableReader.read();
      if (chunk.done) {
        cancellableBody += cancellableDecoder.decode();
        break;
      }
      cancellableBody += cancellableDecoder.decode(chunk.value, { stream: true });
    }
    expect(
      cancellableBody
        .trim()
        .split("\n")
        .map((line) => (JSON.parse(line) as { type: string }).type),
    ).toEqual(["response.started", "content.delta", "response.cancelled"]);
    expect(cancellableGatewaySignal?.aborted).toBe(true);
    expect(
      (await conversationsService.get(actor, cancellable.conversation.id)).messages.at(-1)?.content,
    ).toEqual([{ text: cancellablePartial, type: "text" }]);
    expect(
      (
        await database
          .select({ firstTokenAt: generations.firstTokenAt, status: generations.status })
          .from(generations)
          .where(eq(generations.id, cancellableStarted.generationId))
      )[0],
    ).toMatchObject({ firstTokenAt: expect.any(Date), status: "cancelled" });

    const responseStates = await fetch(
      `${baseUrl}/api/conversations/${cancellable.conversation.id}/response-states`,
      {
        body: JSON.stringify({ messageIds: [cancellableStarted.messageId] }),
        headers: {
          "content-type": "application/json",
          origin: "http://localhost:5173",
        },
        method: "POST",
      },
    );
    expect(responseStates.status).toBe(200);
    expect(await responseStates.json()).toMatchObject({
      responses: [
        {
          generationId: cancellableStarted.generationId,
          messageId: cancellableStarted.messageId,
          reason: "cancelled",
          status: "cancelled",
        },
      ],
      revision: 2,
    });
  });
});

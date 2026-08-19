import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { and, eq } from "drizzle-orm";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createCursorCodec } from "../src/conversations/cursor.js";
import {
  type ConversationService,
  createConversationService,
} from "../src/conversations/service.js";
import { session as authenticationSessions, user } from "../src/database/auth-schema.generated.js";
import { conversations } from "../src/database/conversation-schema.js";
import { type AppDatabase, createDatabase } from "../src/database/database.js";
import { generations } from "../src/database/generation-schema.js";
import { workspaceMemberships, workspaces } from "../src/database/identity-schema.js";
import { migrateDatabase } from "../src/database/migrate.js";
import { createGenerationAdministrationService } from "../src/generations/administration.js";
import { FakeModelGateway } from "../src/generations/fake-model-gateway.js";
import { createGenerationService, type GenerationService } from "../src/generations/service.js";
import {
  buildTitleRequest,
  createTitleService,
  leadingExcerpt,
  normalizeGeneratedTitle,
  runTitleGeneration,
  titlePrompt,
  titleTuning,
} from "../src/generations/title-service.js";
import type { RequestActor } from "../src/identity/authorization.js";
import {
  createBudgetService,
  WorkspaceBudgetExceededError,
} from "../src/model-policy/budget-service.js";
import { createModelPolicyService } from "../src/model-policy/service.js";
import { bootstrapSimulatedModelPolicy } from "./support/model-policy.js";

async function waitForCondition(
  check: () => Promise<boolean>,
  failureMessage: string,
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(failureMessage);
}

function createActor(sessionId: string, userId: string, workspaceId: string): RequestActor {
  return {
    employee: { email: "member@example.test", id: userId, name: "Persona sintética" },
    role: "member",
    session: {
      createdAt: new Date("2026-08-15T12:00:00.000Z"),
      expiresAt: new Date("2026-08-22T12:00:00.000Z"),
      id: sessionId,
    },
    workspace: { id: workspaceId, identity: "synthetic", name: "Synthetic" },
  };
}

describe("title normalization", () => {
  it("normalizes model output into a bounded one-line title", () => {
    expect(normalizeGeneratedTitle('  "Plan  de\nlanzamiento."  ')).toBe("Plan de lanzamiento");
    expect(normalizeGeneratedTitle("Plan\r\nde lanzamiento")).toBe("Plan de lanzamiento");
    expect(normalizeGeneratedTitle("Plan\rde lanzamiento")).toBe("Plan de lanzamiento");
    expect(normalizeGeneratedTitle("«Presupuesto trimestral»")).toBe("Presupuesto trimestral");
    expect(normalizeGeneratedTitle("   ")).toBeNull();
    expect(normalizeGeneratedTitle("")).toBeNull();
    for (const control of ["\u000b", "\u000c", "\u0085"]) {
      expect(normalizeGeneratedTitle(`Plan${control}privado`)).toBeNull();
    }
    expect(normalizeGeneratedTitle("\ud800")).toBeNull();
    expect(normalizeGeneratedTitle("é".repeat(100))).toBe("é".repeat(72));
  });

  it("builds UTF-8-safe excerpts and the fixed title request", () => {
    expect(leadingExcerpt("ññññ", 5)).toBe("ññ");
    const request = buildTitleRequest("¿Prima?", "La prima es…");
    expect(request).toMatchObject({
      history: [
        { role: "user", text: "¿Prima?" },
        { role: "assistant", text: "La prima es…" },
      ],
      modelTier: "fast",
      purpose: "title",
      systemPrompt: titlePrompt,
    });
  });

  it("runs the fake title call and rejects unusable outcomes", async () => {
    const request = { ...buildTitleRequest("p", "a") };
    await expect(
      runTitleGeneration(new FakeModelGateway(), request, new AbortController().signal),
    ).resolves.toMatchObject({ kind: "titled", title: "Conversación simulada" });
    const persistedObservations: unknown[] = [];
    const observed = await runTitleGeneration(
      new FakeModelGateway({
        title: [
          {
            event: {
              metadata: {
                provider: "provider-a",
                providerGenerationId: "title-generation-id",
                resolvedModel: "provider/title-model",
              },
              type: "generation.metadata",
            },
          },
          { event: { text: "Riesgos del proyecto", type: "content.delta" } },
          {
            event: {
              accounting: {
                costUsd: "0.001",
                metadata: { resolvedModel: "provider/resolved-title-model" },
              },
              reason: "stop",
              type: "response.completed",
              usage: { inputTokens: 10, outputTokens: 3 },
            },
          },
        ],
      }),
      request,
      new AbortController().signal,
      undefined,
      undefined,
      async (observation) => {
        persistedObservations.push(observation);
      },
    );
    expect(observed).toMatchObject({
      firstTokenAt: expect.any(Date),
      kind: "titled",
      metadata: {
        provider: "provider-a",
        providerGenerationId: "title-generation-id",
        resolvedModel: "provider/resolved-title-model",
      },
      title: "Riesgos del proyecto",
    });
    expect(persistedObservations).toEqual([
      {
        metadata: {
          provider: "provider-a",
          providerGenerationId: "title-generation-id",
          resolvedModel: "provider/title-model",
        },
      },
      { firstTokenAt: expect.any(Date) },
      { metadata: { resolvedModel: "provider/resolved-title-model" } },
    ]);
    await expect(
      runTitleGeneration(
        new FakeModelGateway({
          title: [
            { event: { text: "   ", type: "content.delta" } },
            {
              event: {
                reason: "stop",
                type: "response.completed",
                usage: { inputTokens: 1, outputTokens: 1 },
              },
            },
          ],
        }),
        request,
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ errorCode: "EMPTY_RESPONSE", kind: "failed" });
    await expect(
      runTitleGeneration(
        new FakeModelGateway({
          title: [
            {
              event: {
                reason: "refusal",
                type: "response.completed",
                usage: { inputTokens: 1, outputTokens: 0 },
              },
            },
          ],
        }),
        request,
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ kind: "provider-terminal", reason: "refusal" });
    await expect(
      runTitleGeneration(
        new FakeModelGateway({
          title: [{ event: { text: "x".repeat(600), type: "content.delta" } }],
        }),
        request,
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ errorCode: "GENERATION_FAILED", kind: "failed" });
    const aborted = new AbortController();
    aborted.abort();
    await expect(
      runTitleGeneration(new FakeModelGateway(), request, aborted.signal),
    ).resolves.toMatchObject({ kind: "cancelled" });
  });

  it("keeps a valid terminal title outcome when incremental observation writes fail", async () => {
    const persistObservation = vi.fn(async () => {
      throw new Error("synthetic observation write failure");
    });
    const outcome = await runTitleGeneration(
      new FakeModelGateway({
        title: [
          {
            event: {
              metadata: {
                provider: "provider-a",
                providerGenerationId: "title-generation-id",
                resolvedModel: "provider/title-model",
              },
              type: "generation.metadata",
            },
          },
          { event: { text: "Riesgos del proyecto", type: "content.delta" } },
          {
            event: {
              accounting: {
                cachedTokens: 1,
                costUsd: "0.001",
                metadata: { resolvedModel: "provider/resolved-title-model" },
                reasoningTokens: 0,
              },
              reason: "stop",
              type: "response.completed",
              usage: { inputTokens: 10, outputTokens: 3 },
            },
          },
        ],
      }),
      { ...buildTitleRequest("p", "a") },
      new AbortController().signal,
      undefined,
      undefined,
      persistObservation,
    );

    expect(persistObservation).toHaveBeenCalledTimes(3);
    expect(outcome).toMatchObject({
      accounting: {
        costUsd: "0.001",
        metadata: { resolvedModel: "provider/resolved-title-model" },
      },
      firstTokenAt: expect.any(Date),
      kind: "titled",
      metadata: {
        provider: "provider-a",
        providerGenerationId: "title-generation-id",
        resolvedModel: "provider/resolved-title-model",
      },
      title: "Riesgos del proyecto",
      usage: { inputTokens: 10, outputTokens: 3 },
    });
  });
});

describe.sequential("automatic title lifecycle", () => {
  let container: StartedPostgreSqlContainer;
  let databaseUrl: string;
  let pool: Pool;
  let database: AppDatabase;
  let actor: RequestActor;
  let conversationsService: ConversationService;
  let generationService: GenerationService;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:18.4-alpine")
      .withDatabase("capstone_titles")
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
    const workspaceIdentity = `workspace-${randomUUID()}`;
    const userId = `user-${randomUUID()}`;
    const sessionId = `session-${randomUUID()}`;
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
      expiresAt: new Date(sessionAt.getTime() + 7 * 24 * 60 * 60 * 1_000),
      id: sessionId,
      token: `token-${randomUUID()}`,
      updatedAt: sessionAt,
      userId,
    });
    await database.insert(workspaceMemberships).values({ role: "member", userId, workspaceId });
    await bootstrapSimulatedModelPolicy(createModelPolicyService(database), workspaceIdentity);
    actor = createActor(sessionId, userId, workspaceId);
    conversationsService = createConversationService(
      database,
      createCursorCodec("title-test-secret-longer-than-thirty-two-characters"),
    );
    generationService = createGenerationService(database);
  });

  afterEach(async () => {
    await pool.end();
  });

  afterAll(async () => {
    await container.stop();
  });

  async function startFirstResponse(content: string, service = generationService) {
    const draft = await conversationsService.saveDraft(actor, { kind: "new" }, content, 0);
    const conversation = await conversationsService.create(actor, draft.revision);
    const started = await service.startResponse(actor, conversation.id, randomUUID(), {
      content: [{ text: content, type: "text" }],
      draftRevision: draft.revision,
      modelTier: "balanced",
      observedRevision: 0,
      parentMessageId: null,
      source: "draft",
    });
    return { conversation, started };
  }

  async function completeFirstResponse(
    content: string,
    answer = "Respuesta inicial completa.",
    service = generationService,
  ) {
    const { conversation, started } = await startFirstResponse(content, service);
    const terminal = await service.terminalize(started.generationId, {
      content: answer,
      errorCode: null,
      firstTokenAt: new Date(),
      reason: "stop",
      status: "completed",
    });
    return { conversation, started, terminal };
  }

  async function titleRow(conversationId: string) {
    const rows = await database
      .select()
      .from(generations)
      .where(and(eq(generations.conversationId, conversationId), eq(generations.purpose, "title")));
    return rows[0];
  }

  async function reserveTitleAccounting(
    conversationId: string,
    reservationExpiresAt: Date,
  ): Promise<void> {
    const title = await titleRow(conversationId);
    if (title === undefined) {
      throw new Error("Title fixture was not created");
    }
    await database
      .update(generations)
      .set({
        accountingStatus: "reserved",
        budgetPeriodEnd: new Date(title.startedAt.getTime() + 31 * 24 * 60 * 60 * 1_000),
        budgetPeriodStart: new Date(title.startedAt.getTime() - 24 * 60 * 60 * 1_000),
        completionPriceCeilingPerToken: "0.000002",
        estimatedInputTokens: 10n,
        maximumOutputTokens: 32,
        promptPriceCeilingPerToken: "0.000001",
        requestPriceCeilingUsd: "0",
        requestedModel: "requested/title-model",
        reservationExpiresAt,
        reservationMarginBasisPoints: 0,
        reservedCostUsd: "0.01",
        resolvedModel: "requested/title-model",
      })
      .where(eq(generations.id, title.id));
  }

  async function automaticTitlePending(conversationId: string): Promise<boolean | undefined> {
    return (
      await database
        .select({ pending: conversations.automaticTitlePending })
        .from(conversations)
        .where(eq(conversations.id, conversationId))
    )[0]?.pending;
  }

  async function automaticTitleCoordination(conversationId: string) {
    return (
      await database
        .select({
          pending: conversations.automaticTitlePending,
          settledRevision: conversations.automaticTitleSettledRevision,
          updatedAt: conversations.updatedAt,
        })
        .from(conversations)
        .where(eq(conversations.id, conversationId))
    )[0];
  }

  it("hands off the initial answer to naming and applies the generated title once", async () => {
    const { conversation, started, terminal } = await completeFirstResponse("Pregunta inicial");
    expect(terminal).toMatchObject({ revision: 1, status: "finalizing", won: true });
    expect(terminal.naming).toBeDefined();
    const pending = await titleRow(conversation.id);
    expect(pending).toMatchObject({ purpose: "title", requestedTier: "fast", status: "active" });
    // Public state remains active and the composer stays fenced during naming.
    await expect(
      generationService.responseStates(actor, conversation.id, [started.messageId]),
    ).resolves.toMatchObject({ responses: [{ errorCode: null, reason: null, status: "active" }] });
    await expect(
      generationService.startResponse(actor, conversation.id, randomUUID(), {
        content: [{ text: "otra", type: "text" }],
        draftRevision: 0,
        modelTier: "balanced",
        observedRevision: 1,
        parentMessageId: started.messageId,
        source: "draft",
      }),
    ).rejects.toMatchObject({ code: "GENERATION_ACTIVE" });

    const finalized = await generationService.finalizeNaming({
      conversationId: conversation.id,
      outcome: {
        kind: "titled",
        title: "Título generado",
        usage: { inputTokens: 5, outputTokens: 2 },
      },
      parentGenerationId: started.generationId,
      titleGenerationId: terminal.naming?.titleGenerationId ?? "",
    });
    expect(finalized).toEqual({ kind: "finalized", revision: 2, titleApplied: true });
    const named = await conversationsService.get(actor, conversation.id);
    expect(named.conversation).toMatchObject({ revision: 2, title: "Título generado" });
    await expect(titleRow(conversation.id)).resolves.toMatchObject({
      status: "completed",
      terminalReason: "stop",
    });
    await expect(generationService.readState(started.generationId)).resolves.toMatchObject({
      reason: "stop",
      revision: 2,
      status: "completed",
    });
    await expect(automaticTitleCoordination(conversation.id)).resolves.toMatchObject({
      pending: false,
      settledRevision: 2,
    });

    // A later completion of another turn never retitles.
    const secondDraft = await conversationsService.saveDraft(
      actor,
      { conversationId: conversation.id, kind: "conversation" },
      "Segunda",
      0,
    );
    const second = await generationService.startResponse(actor, conversation.id, randomUUID(), {
      content: [{ text: "Segunda", type: "text" }],
      draftRevision: secondDraft.revision,
      modelTier: "balanced",
      observedRevision: 2,
      parentMessageId: started.messageId,
      source: "draft",
    });
    const secondTerminal = await generationService.terminalize(second.generationId, {
      content: "Segunda respuesta",
      errorCode: null,
      firstTokenAt: new Date(),
      reason: "stop",
      status: "completed",
    });
    expect(secondTerminal).toMatchObject({ status: "completed", won: true });
    expect(secondTerminal.naming).toBeUndefined();
  });

  it("commits a completed answer when the optional title handoff fails", async () => {
    const budget = createBudgetService(database);
    const baseTitles = createTitleService({
      budget,
      database,
      mode: "simulated",
      modelPolicy: createModelPolicyService(database),
    });
    const beginNaming = vi.fn(async () => {
      throw new Error("synthetic title handoff failure");
    });
    const service = createGenerationService(database, {
      budget,
      titles: { ...baseTitles, beginNaming },
    });
    const { conversation, started } = await startFirstResponse("Pregunta con fallback", service);

    await expect(
      service.terminalize(started.generationId, {
        content: "Respuesta autoritativa.",
        errorCode: null,
        firstTokenAt: new Date(),
        reason: "stop",
        status: "completed",
      }),
    ).resolves.toMatchObject({ revision: 2, status: "completed", won: true });
    expect(beginNaming).toHaveBeenCalledOnce();
    await expect(service.readState(started.generationId)).resolves.toMatchObject({
      reason: "stop",
      revision: 2,
      status: "completed",
    });
    await expect(conversationsService.get(actor, conversation.id)).resolves.toMatchObject({
      conversation: { revision: 2, title: "Pregunta con fallback" },
      messages: expect.arrayContaining([
        expect.objectContaining({ content: [{ text: "Respuesta autoritativa.", type: "text" }] }),
      ]),
    });
    await expect(automaticTitlePending(conversation.id)).resolves.toBe(false);
    await expect(titleRow(conversation.id)).resolves.toBeUndefined();
  });

  it("completes the answer without naming when title admission authority is gone", async () => {
    const { conversation, started } = await startFirstResponse("Pregunta desactivada");
    const deactivatedAt = new Date();
    await database
      .update(workspaceMemberships)
      .set({ deactivatedAt, status: "deactivated", updatedAt: deactivatedAt })
      .where(
        and(
          eq(workspaceMemberships.workspaceId, actor.workspace.id),
          eq(workspaceMemberships.userId, actor.employee.id),
        ),
      );

    await expect(
      generationService.terminalize(started.generationId, {
        content: "Respuesta ya completada.",
        errorCode: null,
        firstTokenAt: new Date(),
        reason: "stop",
        status: "completed",
      }),
    ).resolves.toMatchObject({ revision: 2, status: "completed", won: true });
    await expect(titleRow(conversation.id)).resolves.toBeUndefined();
    await expect(automaticTitlePending(conversation.id)).resolves.toBe(false);
  });

  it("attributes a hidden title budget rejection to title telemetry", () => {
    const recordBudgetRejection = vi.fn();
    const budget = createBudgetService(database, {
      telemetry: {
        recordBudgetRejection,
        recordReconciliation: vi.fn(),
        recordReservationSettlement: vi.fn(),
      },
    });
    const at = new Date();
    expect(() =>
      budget.reserveResolvedTier(
        {
          activeGenerationCount: 0,
          consumedUsd: "0",
          period: {
            end: new Date(at.getTime() + 24 * 60 * 60 * 1_000),
            start: new Date(at.getTime() - 24 * 60 * 60 * 1_000),
          },
          userId: actor.employee.id,
          workspaceId: actor.workspace.id,
        },
        {
          completionPriceCeilingPerToken: "0.001",
          contextLength: 1_000,
          employeeActiveGenerationLimit: 2,
          maximumOutputTokens: 32,
          monthlyBudgetUsd: "0",
          promptPriceCeilingPerToken: "0.001",
          requestPriceCeilingUsd: "0",
          reservationMarginBasisPoints: 0,
          resolvedModel: "fixture/title-model",
          tier: "fast",
        },
        1n,
        at,
        { enforceEmployeeLimit: false, purpose: "title" },
      ),
    ).toThrow(WorkspaceBudgetExceededError);
    expect(recordBudgetRejection).toHaveBeenCalledOnce();
    expect(recordBudgetRejection).toHaveBeenCalledWith("fast", "title");
  });

  it("records measured title settlement duration", async () => {
    const recordSettlement = vi.fn();
    const budget = createBudgetService(database);
    const titles = createTitleService({
      budget,
      database,
      mode: "simulated",
      modelPolicy: createModelPolicyService(database),
      telemetry: {
        recordReservationSettlement: vi.fn(),
        recordSettlement,
      },
    });
    const service = createGenerationService(database, { budget, titles });
    const { conversation, started, terminal } = await completeFirstResponse(
      "Pregunta medida",
      "Respuesta medida.",
      service,
    );
    await service.finalizeNaming({
      conversationId: conversation.id,
      outcome: {
        kind: "titled",
        title: "Título medido",
        usage: { inputTokens: 5, outputTokens: 2 },
      },
      parentGenerationId: started.generationId,
      titleGenerationId: terminal.naming?.titleGenerationId ?? "",
    });

    expect(recordSettlement).toHaveBeenCalledOnce();
    const titleSettlement = recordSettlement.mock.calls[0];
    expect(titleSettlement?.slice(0, 3)).toEqual(["fast", "title", "completed"]);
    expect(titleSettlement?.[3]).toEqual(expect.any(Number));
    expect(titleSettlement?.[3]).toBeGreaterThan(0);
  });

  it("keeps the fallback title when naming fails or produces no title", async () => {
    const { conversation, started, terminal } = await completeFirstResponse("Pregunta sin título");
    const finalized = await generationService.finalizeNaming({
      conversationId: conversation.id,
      outcome: { errorCode: "GENERATION_TIMEOUT", kind: "failed" },
      parentGenerationId: started.generationId,
      titleGenerationId: terminal.naming?.titleGenerationId ?? "",
    });
    expect(finalized).toEqual({ kind: "finalized", revision: 2, titleApplied: false });
    await expect(conversationsService.get(actor, conversation.id)).resolves.toMatchObject({
      conversation: { revision: 2, title: "Pregunta sin título" },
    });
    await expect(titleRow(conversation.id)).resolves.toMatchObject({
      errorCode: "GENERATION_TIMEOUT",
      status: "failed",
    });
  });

  it("persists title metadata, first-token timing, and authoritative accounting", async () => {
    const { conversation, started, terminal } = await completeFirstResponse("Pregunta contable");
    const pending = await titleRow(conversation.id);
    if (pending === undefined) {
      throw new Error("Title fixture was not created");
    }
    await reserveTitleAccounting(
      conversation.id,
      new Date(pending.startedAt.getTime() + 15 * 60 * 1_000),
    );
    const firstTokenAt = new Date(pending.startedAt.getTime() + 25);
    await expect(
      generationService.recordTitleObservation(pending.id, {
        firstTokenAt,
        metadata: {
          provider: "provider-a",
          providerGenerationId: "title-provider-generation-id",
        },
      }),
    ).resolves.toBe(true);
    await expect(titleRow(conversation.id)).resolves.toMatchObject({
      firstTokenAt,
      openRouterGenerationId: "title-provider-generation-id",
      provider: "provider-a",
    });

    await expect(
      generationService.finalizeNaming({
        conversationId: conversation.id,
        outcome: {
          accounting: {
            cachedTokens: 1,
            costUsd: "0.001",
            metadata: { resolvedModel: "provider/resolved-title-model" },
            reasoningTokens: 0,
          },
          kind: "titled",
          title: "Título con cuenta",
          usage: { inputTokens: 12, outputTokens: 3 },
        },
        parentGenerationId: started.generationId,
        titleGenerationId: terminal.naming?.titleGenerationId ?? "",
      }),
    ).resolves.toEqual({ kind: "finalized", revision: 2, titleApplied: true });
    await expect(titleRow(conversation.id)).resolves.toMatchObject({
      accountingStatus: "actual",
      cachedTokens: 1n,
      completionTokens: 3n,
      costBasis: "actual",
      costUsd: "0.001000000000000000",
      firstTokenAt,
      openRouterGenerationId: "title-provider-generation-id",
      promptTokens: 12n,
      provider: "provider-a",
      reasoningTokens: 0n,
      resolvedModel: "provider/resolved-title-model",
      status: "completed",
    });
  });

  it("rejects a generated title when durable finalization reaches its cutoff", async () => {
    const { conversation, started, terminal } = await completeFirstResponse("Pregunta tardía");
    const stale = new Date(Date.now() - 20_000);
    await database
      .update(generations)
      .set({
        completedAt: stale,
        createdAt: stale,
        firstTokenAt: stale,
        startedAt: stale,
        updatedAt: stale,
      })
      .where(eq(generations.id, started.generationId));

    await expect(
      generationService.finalizeNaming({
        conversationId: conversation.id,
        outcome: {
          kind: "titled",
          title: "Título demasiado tarde",
          usage: { inputTokens: 5, outputTokens: 3 },
        },
        parentGenerationId: started.generationId,
        titleGenerationId: terminal.naming?.titleGenerationId ?? "",
      }),
    ).resolves.toEqual({ kind: "finalized", revision: 2, titleApplied: false });
    await expect(conversationsService.get(actor, conversation.id)).resolves.toMatchObject({
      conversation: { revision: 2, title: "Pregunta tardía" },
    });
    await expect(titleRow(conversation.id)).resolves.toMatchObject({
      errorCode: "GENERATION_TIMEOUT",
      status: "failed",
    });
  });

  it("rejects a generated title when its row lock crosses the provider cutoff", async () => {
    const { conversation, started, terminal } = await completeFirstResponse(
      "Pregunta con bloqueo de título",
    );
    const titleGenerationId = terminal.naming?.titleGenerationId ?? "";
    const cutoffDelayMilliseconds = 120;
    const parentCompletedAt = new Date(
      Date.now() -
        titleTuning.deadlineMilliseconds +
        titleTuning.persistenceBudgetMilliseconds +
        cutoffDelayMilliseconds,
    );
    await database
      .update(generations)
      .set({
        completedAt: parentCompletedAt,
        createdAt: parentCompletedAt,
        firstTokenAt: parentCompletedAt,
        startedAt: parentCompletedAt,
        updatedAt: parentCompletedAt,
      })
      .where(eq(generations.id, started.generationId));

    const holder = await pool.connect();
    let holderCommitted = false;
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT id FROM generations WHERE id = $1 FOR UPDATE", [
        titleGenerationId,
      ]);
      const finalization = generationService.finalizeNaming({
        conversationId: conversation.id,
        outcome: {
          accounting: {
            cachedTokens: 0,
            costUsd: "0.001",
            metadata: { resolvedModel: "provider/title-model" },
            reasoningTokens: 0,
          },
          kind: "titled",
          title: "Título después del límite",
          usage: { inputTokens: 5, outputTokens: 3 },
        },
        parentGenerationId: started.generationId,
        titleGenerationId,
      });
      await new Promise((resolve) => setTimeout(resolve, cutoffDelayMilliseconds + 80));
      await holder.query("COMMIT");
      holderCommitted = true;

      await expect(finalization).resolves.toEqual({
        kind: "finalized",
        revision: 2,
        titleApplied: false,
      });
      await expect(conversationsService.get(actor, conversation.id)).resolves.toMatchObject({
        conversation: { revision: 2, title: "Pregunta con bloqueo de título" },
      });
      await expect(titleRow(conversation.id)).resolves.toMatchObject({
        errorCode: "GENERATION_TIMEOUT",
        status: "failed",
      });
    } finally {
      if (!holderCommitted) {
        await holder.query("ROLLBACK");
      }
      holder.release();
    }
  });

  it("bounds a stream-owned finalization transaction at the absolute persistence deadline", async () => {
    const { conversation, started, terminal } = await completeFirstResponse(
      "Pregunta con bloqueo tardío",
    );
    const holder = await pool.connect();
    let holderCommitted = false;
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT id FROM conversations WHERE id = $1 FOR UPDATE", [
        conversation.id,
      ]);
      const persistenceDeadlineAt = new Date(Date.now() + 100);
      const attemptedAt = performance.now();
      await expect(
        generationService.finalizeNaming({
          conversationId: conversation.id,
          outcome: { errorCode: "GENERATION_TIMEOUT", kind: "failed" },
          parentGenerationId: started.generationId,
          persistenceDeadlineAt,
          titleGenerationId: terminal.naming?.titleGenerationId ?? "",
        }),
      ).rejects.toBeDefined();
      expect(performance.now() - attemptedAt).toBeLessThan(1_000);
      await expect(generationService.readState(started.generationId)).resolves.toMatchObject({
        status: "finalizing",
      });

      await holder.query("COMMIT");
      holderCommitted = true;
      await expect(
        generationService.finalizeNaming({
          conversationId: conversation.id,
          outcome: { errorCode: "GENERATION_TIMEOUT", kind: "failed" },
          parentGenerationId: started.generationId,
          titleGenerationId: terminal.naming?.titleGenerationId ?? "",
        }),
      ).resolves.toEqual({ kind: "finalized", revision: 2, titleApplied: false });
    } finally {
      if (!holderCommitted) {
        await holder.query("ROLLBACK");
      }
      holder.release();
    }
  });

  it("lets a manual rename during naming win permanently", async () => {
    const { conversation, started, terminal } = await completeFirstResponse("Pregunta renombrada");
    const renamed = await conversationsService.rename(actor, conversation.id, "Mi título", 1);
    expect(renamed.revision).toBe(2);
    const finalized = await generationService.finalizeNaming({
      conversationId: conversation.id,
      outcome: {
        kind: "titled",
        title: "Título generado",
        usage: { inputTokens: 5, outputTokens: 2 },
      },
      parentGenerationId: started.generationId,
      titleGenerationId: terminal.naming?.titleGenerationId ?? "",
    });
    expect(finalized).toEqual({ kind: "finalized", revision: 3, titleApplied: false });
    await expect(conversationsService.get(actor, conversation.id)).resolves.toMatchObject({
      conversation: { revision: 3, title: "Mi título" },
    });
  });

  it("lets a queued manual rename win when naming finalization locks first", async () => {
    const { conversation, started, terminal } = await completeFirstResponse(
      "Pregunta con carrera de bloqueo",
    );
    const holder = await pool.connect();
    let holderCommitted = false;
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT id FROM conversations WHERE id = $1 FOR UPDATE", [
        conversation.id,
      ]);
      const finalization = generationService.finalizeNaming({
        conversationId: conversation.id,
        outcome: {
          kind: "titled",
          title: "Título generado primero",
          usage: { inputTokens: 5, outputTokens: 2 },
        },
        parentGenerationId: started.generationId,
        titleGenerationId: terminal.naming?.titleGenerationId ?? "",
      });
      await waitForCondition(async () => {
        const waiting = await pool.query<{ waiting: boolean }>(`
          SELECT EXISTS (
            SELECT 1
            FROM pg_stat_activity
            WHERE datname = current_database()
              AND pid <> pg_backend_pid()
              AND wait_event_type = 'Lock'
              AND query ILIKE '%conversations%for update%'
          ) AS waiting
        `);
        return waiting.rows[0]?.waiting === true;
      }, "Naming finalization did not wait for the conversation lock");
      const rename = conversationsService.rename(actor, conversation.id, "Mi título manual", 1);

      await holder.query("COMMIT");
      holderCommitted = true;
      const [finalized, renamed] = await Promise.all([finalization, rename]);

      expect(finalized).toEqual({ kind: "finalized", revision: 2, titleApplied: true });
      expect(renamed).toMatchObject({ revision: 3, title: "Mi título manual" });
      await expect(conversationsService.get(actor, conversation.id)).resolves.toMatchObject({
        conversation: { revision: 3, title: "Mi título manual" },
      });
      await expect(automaticTitleCoordination(conversation.id)).resolves.toMatchObject({
        pending: false,
        settledRevision: 2,
      });
      await expect(
        conversationsService.rename(actor, conversation.id, "Otro título obsoleto", 2),
      ).rejects.toMatchObject({ code: "CONVERSATION_CHANGED" });
    } finally {
      if (!holderCommitted) {
        await holder.query("ROLLBACK");
      }
      holder.release();
    }
  });

  it("records same-title rename intent without a revision change", async () => {
    const { conversation, started, terminal } = await completeFirstResponse("Título igual");
    const renamed = await conversationsService.rename(actor, conversation.id, "Título igual", 1);
    expect(renamed.revision).toBe(1);
    const finalized = await generationService.finalizeNaming({
      conversationId: conversation.id,
      outcome: {
        kind: "titled",
        title: "Título generado",
        usage: { inputTokens: 5, outputTokens: 2 },
      },
      parentGenerationId: started.generationId,
      titleGenerationId: terminal.naming?.titleGenerationId ?? "",
    });
    expect(finalized).toMatchObject({ kind: "finalized", titleApplied: false });
    await expect(conversationsService.get(actor, conversation.id)).resolves.toMatchObject({
      conversation: { title: "Título igual" },
    });
  });

  it("stops only the naming when Stop arrives during finalizing", async () => {
    const { conversation, started, terminal } = await completeFirstResponse("Pregunta detenida");
    await expect(
      generationService.cancel(actor, conversation.id, started.generationId),
    ).resolves.toBe(true);
    await expect(generationService.readState(started.generationId)).resolves.toMatchObject({
      reason: "stop",
      revision: 2,
      status: "completed",
    });
    await expect(titleRow(conversation.id)).resolves.toMatchObject({ status: "cancelled" });
    await expect(automaticTitleCoordination(conversation.id)).resolves.toMatchObject({
      pending: false,
      settledRevision: 2,
    });
    // The producer's late finalization only records outcome; it cannot retitle.
    const finalized = await generationService.finalizeNaming({
      conversationId: conversation.id,
      outcome: {
        kind: "titled",
        title: "Tarde",
        usage: { inputTokens: 1, outputTokens: 1 },
      },
      parentGenerationId: started.generationId,
      titleGenerationId: terminal.naming?.titleGenerationId ?? "",
    });
    expect(finalized).toEqual({ kind: "lost-cas", revision: 2, titleApplied: false });
    await expect(conversationsService.get(actor, conversation.id)).resolves.toMatchObject({
      conversation: { revision: 2, title: "Pregunta detenida" },
    });
    // A second Stop is a no-op on the completed parent.
    await expect(
      generationService.cancel(actor, conversation.id, started.generationId),
    ).resolves.toBe(false);
  });

  it("finalizes stale naming through reconciliation without a model call", async () => {
    const { conversation, started, terminal } = await completeFirstResponse("Pregunta atascada");
    await expect(generationService.reconcileStaleNaming()).resolves.toEqual({
      finalized: 0,
      inspected: 0,
    });
    const reconciliationAt = new Date();
    const stale = new Date(reconciliationAt.getTime() - 20_000);
    const newerConversationTimestamp = new Date(reconciliationAt.getTime() + 30_000);
    await database
      .update(generations)
      .set({
        completedAt: stale,
        createdAt: stale,
        firstTokenAt: stale,
        startedAt: stale,
        updatedAt: stale,
      })
      .where(eq(generations.id, started.generationId));
    await database
      .update(conversations)
      .set({ updatedAt: newerConversationTimestamp })
      .where(eq(conversations.id, conversation.id));
    await expect(generationService.reconcileStaleNaming(reconciliationAt)).resolves.toEqual({
      finalized: 1,
      inspected: 1,
    });
    await expect(generationService.readState(started.generationId)).resolves.toMatchObject({
      revision: 2,
      status: "completed",
    });
    await expect(titleRow(conversation.id)).resolves.toMatchObject({
      errorCode: "GENERATION_TIMEOUT",
      status: "failed",
    });
    await expect(automaticTitleCoordination(conversation.id)).resolves.toMatchObject({
      pending: false,
      settledRevision: 2,
      updatedAt: newerConversationTimestamp,
    });
    expect(terminal.naming).toBeDefined();
  });

  it("continues naming reconciliation after one candidate fails", async () => {
    const recordReconciliation = vi.fn();
    const budget = createBudgetService(database);
    const titles = createTitleService({
      budget,
      database,
      mode: "simulated",
      modelPolicy: createModelPolicyService(database),
      telemetry: {
        recordReconciliation,
        recordReservationSettlement: vi.fn(),
        recordSettlement: vi.fn(),
      },
    });
    const service = createGenerationService(database, { budget, titles });
    const poison = await completeFirstResponse(
      "Pregunta venenosa",
      "Respuesta inicial completa.",
      service,
    );
    const healthy = await completeFirstResponse(
      "Pregunta saludable",
      "Respuesta inicial completa.",
      service,
    );
    const at = new Date();
    const poisonStaleAt = new Date(at.getTime() - 20_000);
    const healthyStaleAt = new Date(at.getTime() - 19_000);
    await database
      .update(generations)
      .set({
        completedAt: poisonStaleAt,
        createdAt: poisonStaleAt,
        firstTokenAt: poisonStaleAt,
        startedAt: poisonStaleAt,
        updatedAt: poisonStaleAt,
      })
      .where(eq(generations.id, poison.started.generationId));
    await database
      .update(generations)
      .set({
        completedAt: healthyStaleAt,
        createdAt: healthyStaleAt,
        firstTokenAt: healthyStaleAt,
        startedAt: healthyStaleAt,
        updatedAt: healthyStaleAt,
      })
      .where(eq(generations.id, healthy.started.generationId));
    // Incrementing this valid stored value exceeds PostgreSQL's integer range, making only this
    // candidate un-settleable while leaving the following candidate healthy.
    await database
      .update(conversations)
      .set({ revision: 2_147_483_647 })
      .where(eq(conversations.id, poison.conversation.id));

    await expect(service.reconcileStaleNaming(at)).resolves.toEqual({
      finalized: 1,
      inspected: 2,
    });
    expect(recordReconciliation).toHaveBeenCalledOnce();
    expect(recordReconciliation).toHaveBeenCalledWith({
      claimed: 1,
      errors: 1,
      oldestDueLagMs: 0,
      settled: 0,
    });
    await expect(service.readState(poison.started.generationId)).resolves.toMatchObject({
      revision: 2_147_483_647,
      status: "finalizing",
    });
    await expect(titleRow(poison.conversation.id)).resolves.toMatchObject({ status: "active" });
    await expect(service.readState(healthy.started.generationId)).resolves.toMatchObject({
      revision: 2,
      status: "completed",
    });
    await expect(titleRow(healthy.conversation.id)).resolves.toMatchObject({
      errorCode: "GENERATION_TIMEOUT",
      status: "failed",
    });
  });

  it("lets naming reconciliation own an expired active title without a budget revision", async () => {
    const { conversation, started } = await completeFirstResponse("Pregunta con reserva vencida");
    const pending = await titleRow(conversation.id);
    if (pending === undefined) {
      throw new Error("Title fixture was not created");
    }
    const expiredAt = new Date(pending.startedAt.getTime() + 15 * 60 * 1_000);
    await reserveTitleAccounting(conversation.id, expiredAt);

    await expect(createBudgetService(database).reconcileExpiredOnce(expiredAt)).resolves.toEqual({
      inspected: 1,
      settled: 1,
      terminalized: 1,
    });
    await expect(titleRow(conversation.id)).resolves.toMatchObject({
      accountingStatus: "estimated",
      errorCode: "GENERATION_TIMEOUT",
      status: "failed",
    });
    await expect(conversationsService.get(actor, conversation.id)).resolves.toMatchObject({
      conversation: { revision: 1 },
    });

    await expect(generationService.reconcileStaleNaming(expiredAt)).resolves.toEqual({
      finalized: 1,
      inspected: 1,
    });
    await expect(generationService.readState(started.generationId)).resolves.toMatchObject({
      revision: 2,
      status: "completed",
    });
  });

  it("consumes the initial naming opportunity when an active chat reservation expires", async () => {
    const { conversation, started } = await startFirstResponse("Pregunta cuyo turno vence");
    const parentRows = await database
      .select()
      .from(generations)
      .where(eq(generations.id, started.generationId));
    const parent = parentRows[0];
    if (parent === undefined) {
      throw new Error("Chat fixture was not created");
    }
    const expiredAt = new Date(parent.startedAt.getTime() + 15 * 60 * 1_000);
    await database
      .update(generations)
      .set({
        accountingStatus: "reserved",
        budgetPeriodEnd: new Date(parent.startedAt.getTime() + 31 * 24 * 60 * 60 * 1_000),
        budgetPeriodStart: new Date(parent.startedAt.getTime() - 24 * 60 * 60 * 1_000),
        completionPriceCeilingPerToken: "0.000002",
        estimatedInputTokens: 10n,
        maximumOutputTokens: 32,
        promptPriceCeilingPerToken: "0.000001",
        requestPriceCeilingUsd: "0",
        requestedModel: "requested/chat-model",
        reservationExpiresAt: expiredAt,
        reservationMarginBasisPoints: 0,
        reservedCostUsd: "0.01",
        resolvedModel: "requested/chat-model",
      })
      .where(eq(generations.id, parent.id));

    await expect(createBudgetService(database).reconcileExpiredOnce(expiredAt)).resolves.toEqual({
      inspected: 1,
      settled: 1,
      terminalized: 1,
    });
    await expect(generationService.readState(parent.id)).resolves.toMatchObject({
      errorCode: "STREAM_INTERRUPTED",
      revision: 2,
      status: "incomplete",
    });
    await expect(automaticTitlePending(conversation.id)).resolves.toBe(false);
  });

  it("consumes the single naming opportunity on every ineligible initial outcome", async () => {
    const cancelled = await startFirstResponse("Pregunta cancelada");
    await expect(
      generationService.cancel(actor, cancelled.conversation.id, cancelled.started.generationId),
    ).resolves.toBe(true);
    await expect(titleRow(cancelled.conversation.id)).resolves.toBeUndefined();
    await expect(automaticTitlePending(cancelled.conversation.id)).resolves.toBe(false);

    const failed = await startFirstResponse("Pregunta fallida");
    await expect(
      generationService.terminalize(failed.started.generationId, {
        content: "",
        errorCode: "GENERATION_FAILED",
        firstTokenAt: null,
        reason: "error",
        status: "failed",
      }),
    ).resolves.toMatchObject({ status: "failed", won: true });
    await expect(titleRow(failed.conversation.id)).resolves.toBeUndefined();
    await expect(automaticTitlePending(failed.conversation.id)).resolves.toBe(false);

    for (const initial of [
      {
        answer: "Respuesta parcial",
        content: "Pregunta interrumpida",
        errorCode: "STREAM_INTERRUPTED" as const,
        reason: "error" as const,
        status: "incomplete" as const,
      },
      {
        answer: "No puedo responder.",
        content: "Pregunta rechazada",
        errorCode: null,
        reason: "refusal" as const,
        status: "completed" as const,
      },
      {
        answer: "Contenido filtrado.",
        content: "Pregunta filtrada",
        errorCode: null,
        reason: "content_filter" as const,
        status: "completed" as const,
      },
      {
        answer: "",
        content: "Pregunta vacía",
        errorCode: "EMPTY_RESPONSE" as const,
        reason: "error" as const,
        status: "failed" as const,
      },
    ]) {
      const response = await startFirstResponse(initial.content);
      const terminal = await generationService.terminalize(response.started.generationId, {
        content: initial.answer,
        errorCode: initial.errorCode,
        firstTokenAt: initial.answer.length === 0 ? null : new Date(),
        reason: initial.reason,
        status: initial.status,
      });
      expect(terminal).toMatchObject({ status: initial.status, won: true });
      expect(terminal.naming).toBeUndefined();
      await expect(titleRow(response.conversation.id)).resolves.toBeUndefined();
      await expect(automaticTitlePending(response.conversation.id)).resolves.toBe(false);
    }

    // A retry of that failed first answer is not the initial root answer.
    const failedDetail = await conversationsService.get(actor, failed.conversation.id);
    const retried = await generationService.startResponse(
      actor,
      failed.conversation.id,
      randomUUID(),
      {
        modelTier: "balanced",
        observedRevision: failedDetail.conversation.revision,
        parentMessageId: failed.started.userMessageId,
        source: "retry",
        targetMessageId: failed.started.messageId,
      },
    );
    await expect(
      generationService.terminalize(retried.generationId, {
        content: "Reintento",
        errorCode: null,
        firstTokenAt: new Date(),
        reason: "stop",
        status: "completed",
      }),
    ).resolves.toMatchObject({ status: "completed", won: true });
    await expect(titleRow(failed.conversation.id)).resolves.toBeUndefined();
  });

  it("settles authoritative title accounting after deletion clears its conversation link", async () => {
    const deleted = await completeFirstResponse("Pregunta eliminada con cuenta");
    const title = await titleRow(deleted.conversation.id);
    if (title === undefined) {
      throw new Error("Title fixture was not created");
    }
    await reserveTitleAccounting(
      deleted.conversation.id,
      new Date(title.startedAt.getTime() + 15 * 60 * 1_000),
    );
    const firstTokenAt = title.startedAt;

    await expect(
      generationService.removeConversation(actor, deleted.conversation.id, 1),
    ).resolves.toBe(deleted.started.generationId);
    await expect(
      database.select().from(generations).where(eq(generations.id, title.id)),
    ).resolves.toMatchObject([
      { accountingStatus: "reserved", conversationId: null, status: "cancelled" },
    ]);

    await expect(
      generationService.settleLateTitleAccounting(
        title.id,
        { inputTokens: 12, outputTokens: 3 },
        {
          cachedTokens: 1,
          costUsd: "0.001",
          metadata: { resolvedModel: "provider/resolved-title-model" },
          reasoningTokens: 0,
        },
        {
          firstTokenAt,
          metadata: {
            provider: "provider-a",
            providerGenerationId: "deleted-title-provider-generation-id",
          },
        },
      ),
    ).resolves.toBe(true);
    await expect(
      database.select().from(generations).where(eq(generations.id, title.id)),
    ).resolves.toMatchObject([
      {
        accountingStatus: "actual",
        cachedTokens: 1n,
        completionTokens: 3n,
        conversationId: null,
        costBasis: "actual",
        costUsd: "0.001000000000000000",
        firstTokenAt,
        openRouterGenerationId: "deleted-title-provider-generation-id",
        promptTokens: 12n,
        provider: "provider-a",
        reasoningTokens: 0n,
        resolvedModel: "provider/resolved-title-model",
        status: "cancelled",
      },
    ]);
  });

  it("settles the naming pair on deletion and employee-wide cancellation", async () => {
    const deleted = await completeFirstResponse("Pregunta eliminada");
    await expect(
      generationService.removeConversation(actor, deleted.conversation.id, 1),
    ).resolves.toBe(deleted.started.generationId);
    const retained = await database
      .select({ id: generations.id, purpose: generations.purpose, status: generations.status })
      .from(generations)
      .where(eq(generations.workspaceId, actor.workspace.id));
    expect(retained).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: deleted.started.generationId, status: "completed" }),
        expect.objectContaining({ purpose: "title", status: "cancelled" }),
      ]),
    );

    const stopped = await completeFirstResponse("Pregunta desactivada");
    const hiddenChildId = "00000000-0000-4000-8000-000000000001";
    const parentId = "ffffffff-ffff-4fff-bfff-ffffffffffff";
    const stoppedTitle = await titleRow(stopped.conversation.id);
    if (stoppedTitle === undefined) {
      throw new Error("Title fixture was not created");
    }
    await database
      .update(generations)
      .set({ id: hiddenChildId })
      .where(eq(generations.id, stoppedTitle.id));
    await database
      .update(generations)
      .set({ id: parentId })
      .where(eq(generations.id, stopped.started.generationId));
    const administration = createGenerationAdministrationService(
      database,
      createBudgetService(database),
    );
    const cancelledIds = await administration.cancelEmployeeWork(null, actor.employee.id);
    expect(cancelledIds).toEqual([parentId]);
    await expect(generationService.readState(parentId)).resolves.toMatchObject({
      revision: 2,
      status: "completed",
    });
    await expect(titleRow(stopped.conversation.id)).resolves.toMatchObject({
      status: "cancelled",
    });
    await expect(conversationsService.get(actor, stopped.conversation.id)).resolves.toMatchObject({
      conversation: { revision: 2 },
    });
    await expect(automaticTitlePending(stopped.conversation.id)).resolves.toBe(false);
    await expect(automaticTitleCoordination(stopped.conversation.id)).resolves.toMatchObject({
      settledRevision: 2,
    });
  });
});

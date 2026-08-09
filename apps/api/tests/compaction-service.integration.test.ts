import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { and, eq } from "drizzle-orm";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { user } from "../src/database/auth-schema.generated.js";
import { conversationCompactions } from "../src/database/compaction-schema.js";
import { conversations, messages } from "../src/database/conversation-schema.js";
import { type AppDatabase, createDatabase } from "../src/database/database.js";
import { generations } from "../src/database/generation-schema.js";
import { workspaceMemberships, workspaces } from "../src/database/identity-schema.js";
import { migrateDatabase } from "../src/database/migrate.js";
import { workspaceCostPolicies } from "../src/database/model-policy-schema.js";
import { createGenerationAdministrationService } from "../src/generations/administration.js";
import {
  compactionPrompt,
  serializeCompactionInput,
} from "../src/generations/compaction-prompt.js";
import {
  type CompactionExecutionInput,
  createCompactionService,
} from "../src/generations/compaction-service.js";
import type { PendingContextPlan } from "../src/generations/context-planner.js";
import { loadContextWindow } from "../src/generations/context-service.js";
import { type FakeGatewayStep, FakeModelGateway } from "../src/generations/fake-model-gateway.js";
import type {
  GatewayEvent,
  GenerationAccountingGateway,
  ModelGateway,
} from "../src/generations/model-gateway.js";
import { systemPrompt } from "../src/generations/prompt.js";
import { createBudgetService } from "../src/model-policy/budget-service.js";
import type { ModelPolicyMode, ResolvedTierPolicy } from "../src/model-policy/service.js";

const baselineRevision = 7;
const summary = "Resumen durable de las decisiones anteriores.";

interface Fixture {
  readonly assistantMessageId: string;
  readonly chatGenerationId: string;
  readonly context: CompactionExecutionInput;
  readonly conversationId: string;
  readonly sourceAssistantMessageId: string;
  readonly userId: string;
  readonly workspaceId: string;
}

type CompactionTelemetry = NonNullable<Parameters<typeof createCompactionService>[0]["telemetry"]>;

function policy(monthlyBudgetUsd = "100"): ResolvedTierPolicy {
  return Object.freeze({
    completionPriceCeilingPerToken: "0.000002",
    contextLength: 200_000,
    employeeActiveGenerationLimit: 4,
    maximumOutputTokens: 512,
    monthlyBudgetUsd,
    promptPriceCeilingPerToken: "0.000001",
    requestPriceCeilingUsd: "0",
    reservationMarginBasisPoints: 0,
    resolvedModel: "synthetic/fast",
    tier: "fast",
  });
}

function plan(
  sourceAssistantMessageId: string,
  strategy: "catch-up" | "normal" = "normal",
): PendingContextPlan {
  const latestMessage = "¿Cuál es el siguiente paso?";
  return Object.freeze({
    compaction: Object.freeze({
      estimatedInputTokens: 20n,
      maximumOutputTokens: 128,
      previousCompactionId: null,
      request: Object.freeze({
        history: Object.freeze([]),
        message: Object.freeze({
          role: "user" as const,
          text: serializeCompactionInput({
            messages: [
              { role: "user", text: "Necesitamos conservar esta decisión." },
              { role: "assistant", text: "La decisión queda registrada." },
            ],
            previousSummary: null,
          }),
        }),
        modelTier: "fast" as const,
        purpose: "compaction" as const,
        systemPrompt: compactionPrompt,
      }),
      sourceTurnCount: 1,
      throughMessageId: sourceAssistantMessageId,
    }),
    fallback: Object.freeze({
      estimatedInputTokens: 30n,
      request: Object.freeze({
        history: Object.freeze([]),
        message: Object.freeze({ role: "user" as const, text: latestMessage }),
        modelTier: "balanced" as const,
        purpose: "chat" as const,
        systemPrompt,
      }),
      retainedTurnCount: 0,
    }),
    maximumChatInputTokens: 100_000n,
    mode: "pending" as const,
    recentHistory: Object.freeze([]),
    strategy,
  });
}

function gatewayFromSteps(steps: readonly FakeGatewayStep[]): {
  readonly gateway: ModelGateway;
  readonly stream: ReturnType<typeof vi.fn<ModelGateway["stream"]>>;
} {
  const fake = new FakeModelGateway({ compaction: steps });
  const stream = vi.fn<ModelGateway["stream"]>((request, signal) => fake.stream(request, signal));
  return { gateway: { stream }, stream };
}

describe.sequential("compaction lifecycle", () => {
  let container: StartedPostgreSqlContainer;
  let database: AppDatabase;
  let pool: Pool;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:18.4-alpine")
      .withDatabase("capstone_compaction_service")
      .withUsername("capstone")
      .withPassword("capstone-test-password")
      .start();
    await migrateDatabase(container.getConnectionUri());
    pool = new Pool({ connectionString: container.getConnectionUri() });
    database = createDatabase(pool);
  });

  beforeEach(async () => {
    await pool.query(
      'TRUNCATE TABLE "generations", "messages", "conversations", "workspace_memberships", "user", "workspaces" RESTART IDENTITY CASCADE',
    );
  });

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  async function createFixture(input?: {
    readonly monthlyBudgetUsd?: string;
    readonly strategy?: "catch-up" | "normal";
  }): Promise<Fixture> {
    const now = new Date();
    const workspaceId = randomUUID();
    const userId = `compaction-${randomUUID()}`;
    const conversationId = randomUUID();
    await database.insert(workspaces).values({
      createdAt: now,
      displayName: "Compaction Workspace",
      id: workspaceId,
      identity: `compaction-${workspaceId}`,
      updatedAt: now,
    });
    await database.insert(user).values({
      createdAt: now,
      email: `${userId}@example.test`,
      emailVerified: true,
      id: userId,
      name: "Compaction Employee",
      updatedAt: now,
    });
    await database.insert(workspaceMemberships).values({
      activatedAt: now,
      createdAt: now,
      role: "member",
      status: "active",
      updatedAt: now,
      userId,
      workspaceId,
    });
    await database.insert(workspaceCostPolicies).values({
      createdAt: now,
      defaultTier: "balanced",
      employeeActiveGenerationLimit: 4,
      monthlyBudgetUsd: input?.monthlyBudgetUsd ?? "100",
      reservationMarginBasisPoints: 0,
      updatedAt: now,
      workspaceId,
    });
    await database.insert(conversations).values({
      createdAt: now,
      id: conversationId,
      preferredTier: "balanced",
      revision: baselineRevision,
      updatedAt: now,
      userId,
      workspaceId,
    });
    const sourceUserMessageId = randomUUID();
    const sourceAssistantMessageId = randomUUID();
    const latestUserMessageId = randomUUID();
    const assistantMessageId = randomUUID();
    await database.insert(messages).values([
      {
        content: [{ text: "Necesitamos conservar esta decisión.", type: "text" }],
        conversationId,
        createdAt: now,
        id: sourceUserMessageId,
        parentMessageId: null,
        role: "user",
      },
      {
        content: [{ text: "La decisión queda registrada.", type: "text" }],
        conversationId,
        createdAt: now,
        id: sourceAssistantMessageId,
        parentMessageId: sourceUserMessageId,
        role: "assistant",
      },
      {
        content: [{ text: "¿Cuál es el siguiente paso?", type: "text" }],
        conversationId,
        createdAt: now,
        id: latestUserMessageId,
        parentMessageId: sourceAssistantMessageId,
        role: "user",
      },
      {
        content: [{ text: "", type: "text" }],
        conversationId,
        createdAt: now,
        id: assistantMessageId,
        parentMessageId: latestUserMessageId,
        role: "assistant",
      },
    ]);
    await database
      .update(conversations)
      .set({ selectedLeafMessageId: assistantMessageId })
      .where(eq(conversations.id, conversationId));
    const generationRows = await database
      .insert(generations)
      .values({
        assistantMessageId,
        conversationId,
        createdAt: now,
        effectiveParameters: { context: { mode: "pending" } },
        idempotencyKey: randomUUID(),
        purpose: "chat",
        requestedTier: "balanced",
        startedAt: now,
        status: "preparing",
        systemPromptVersion: systemPrompt.version,
        updatedAt: now,
        userId,
        workspaceId,
      })
      .returning({ id: generations.id });
    const chatGenerationId = generationRows[0]?.id;
    if (chatGenerationId === undefined) {
      throw new Error("Preparing chat generation insert failed");
    }
    return {
      assistantMessageId,
      chatGenerationId,
      context: {
        chatGenerationId,
        conversationId,
        fastPolicy: policy(input?.monthlyBudgetUsd),
        plan: plan(sourceAssistantMessageId, input?.strategy),
        userId,
        workspaceId,
      },
      conversationId,
      sourceAssistantMessageId,
      userId,
      workspaceId,
    };
  }

  async function execute(
    fixture: Fixture,
    gateway: ModelGateway,
    mode: ModelPolicyMode = "simulated",
    signal: AbortSignal = new AbortController().signal,
  ) {
    return createCompactionService({
      budget: createBudgetService(database),
      database,
      gateway,
      mode,
    }).execute(fixture.context, signal);
  }

  async function lifecycleRows(fixture: Fixture) {
    const hiddenRows = await database
      .select()
      .from(generations)
      .where(
        and(
          eq(generations.conversationId, fixture.conversationId),
          eq(generations.purpose, "compaction"),
        ),
      );
    const chatRows = await database
      .select()
      .from(generations)
      .where(eq(generations.id, fixture.chatGenerationId));
    const conversationRows = await database
      .select()
      .from(conversations)
      .where(eq(conversations.id, fixture.conversationId));
    const compactionRows = await database
      .select()
      .from(conversationCompactions)
      .where(eq(conversationCompactions.conversationId, fixture.conversationId));
    return {
      chat: chatRows[0],
      compaction: compactionRows[0],
      conversation: conversationRows[0],
      hidden: hiddenRows[0],
      hiddenCount: hiddenRows.length,
    };
  }

  it("persists and reuses one successful fake compaction without changing the conversation revision", async () => {
    const fixture = await createFixture();
    const { gateway, stream } = gatewayFromSteps([
      { event: { text: summary, type: "content.delta" } },
      {
        event: {
          reason: "stop",
          type: "response.completed",
          usage: { inputTokens: 41, outputTokens: 9 },
        },
      },
    ]);

    const result = await execute(fixture, gateway);

    expect(result.kind).toBe("compacted");
    if (result.kind === "compacted") {
      expect(result.chat.request.derivedContext).toEqual({
        kind: "compaction-summary",
        summary,
      });
    }
    expect(stream).toHaveBeenCalledOnce();
    expect(stream.mock.calls[0]?.[0].purpose).toBe("compaction");
    const rows = await lifecycleRows(fixture);
    expect(rows.hiddenCount).toBe(1);
    expect(rows.hidden).toMatchObject({
      purpose: "compaction",
      status: "completed",
      terminalReason: "stop",
    });
    expect(rows.compaction).toMatchObject({
      sourceTokenCount: 41n,
      status: "completed",
      summary,
      summaryTokenCount: 9n,
      throughMessageId: fixture.sourceAssistantMessageId,
    });
    expect(rows.chat).toMatchObject({ status: "active" });
    expect(rows.conversation?.revision).toBe(baselineRevision);

    const context = await database.transaction((transaction) =>
      loadContextWindow(transaction, fixture.conversationId, fixture.assistantMessageId, 1_000_000),
    );
    expect(context.previousCompaction).toEqual({
      id: rows.compaction?.id,
      summary,
      throughMessageId: fixture.sourceAssistantMessageId,
    });
  });

  it("stores a catch-up summary for later while promoting the current chat with fallback context", async () => {
    const fixture = await createFixture({ strategy: "catch-up" });
    const { gateway, stream } = gatewayFromSteps([
      { event: { text: summary, type: "content.delta" } },
      {
        event: {
          reason: "stop",
          type: "response.completed",
          usage: { inputTokens: 30, outputTokens: 8 },
        },
      },
    ]);

    const result = await execute(fixture, gateway);

    expect(result).toMatchObject({ kind: "fallback" });
    expect(stream).toHaveBeenCalledOnce();
    const rows = await lifecycleRows(fixture);
    expect(rows.compaction).toMatchObject({ status: "completed", summary });
    expect(rows.chat).toMatchObject({ status: "active" });
    expect(rows.chat?.effectiveParameters).toMatchObject({
      context: { mode: "fallback", strategy: "catch-up" },
    });
    expect(rows.conversation?.revision).toBe(baselineRevision);
  });

  it("falls back without calling a provider when the hidden reservation exceeds budget", async () => {
    const fixture = await createFixture({ monthlyBudgetUsd: "0" });
    const { gateway, stream } = gatewayFromSteps([
      { event: { text: "This must not run", type: "content.delta" } },
    ]);

    const result = await execute(fixture, gateway);

    expect(result).toMatchObject({ kind: "fallback" });
    expect(stream).not.toHaveBeenCalled();
    const rows = await lifecycleRows(fixture);
    expect(rows.hiddenCount).toBe(0);
    expect(rows.compaction).toBeUndefined();
    expect(rows.chat).toMatchObject({ status: "active" });
    expect(rows.conversation?.revision).toBe(baselineRevision);
  });

  const terminalCases: readonly {
    readonly compactionStatus: "failed" | "incomplete";
    readonly errorCode: "EMPTY_RESPONSE" | "GENERATION_TIMEOUT" | null;
    readonly events: readonly GatewayEvent[];
    readonly generationStatus: "completed" | "failed" | "incomplete";
    readonly name: string;
    readonly terminalReason: "content_filter" | "error" | "length" | "refusal";
  }[] = [
    {
      compactionStatus: "incomplete",
      errorCode: null,
      events: [
        { text: "Resumen truncado", type: "content.delta" },
        {
          reason: "length",
          type: "response.completed",
          usage: { inputTokens: 20, outputTokens: 128 },
        },
      ],
      generationStatus: "completed",
      name: "length completion",
      terminalReason: "length",
    },
    {
      compactionStatus: "incomplete",
      errorCode: null,
      events: [
        {
          reason: "refusal",
          type: "response.completed",
          usage: { inputTokens: 20, outputTokens: 0 },
        },
      ],
      generationStatus: "completed",
      name: "refusal",
      terminalReason: "refusal",
    },
    {
      compactionStatus: "incomplete",
      errorCode: null,
      events: [
        {
          reason: "content_filter",
          type: "response.completed",
          usage: { inputTokens: 20, outputTokens: 0 },
        },
      ],
      generationStatus: "completed",
      name: "content filter",
      terminalReason: "content_filter",
    },
    {
      compactionStatus: "failed",
      errorCode: "EMPTY_RESPONSE",
      events: [
        {
          reason: "stop",
          type: "response.completed",
          usage: { inputTokens: 20, outputTokens: 0 },
        },
      ],
      generationStatus: "failed",
      name: "empty stop",
      terminalReason: "error",
    },
    {
      compactionStatus: "failed",
      errorCode: "GENERATION_TIMEOUT",
      events: [
        {
          accounting: { spendRisk: "unknown" },
          errorCode: "GENERATION_TIMEOUT",
          type: "response.failed",
        },
      ],
      generationStatus: "failed",
      name: "provider failure",
      terminalReason: "error",
    },
  ];

  it.each(terminalCases)(
    "falls back after $name without retrying or changing structural revision",
    async (terminalCase) => {
      const fixture = await createFixture();
      const { gateway, stream } = gatewayFromSteps(terminalCase.events.map((event) => ({ event })));

      const result = await execute(fixture, gateway);

      expect(result).toMatchObject({ kind: "fallback" });
      expect(stream).toHaveBeenCalledOnce();
      const rows = await lifecycleRows(fixture);
      expect(rows.hiddenCount).toBe(1);
      expect(rows.hidden).toMatchObject({
        errorCode: terminalCase.errorCode,
        status: terminalCase.generationStatus,
        terminalReason: terminalCase.terminalReason,
      });
      expect(rows.compaction).toMatchObject({ status: terminalCase.compactionStatus });
      expect(rows.chat).toMatchObject({ status: "active" });
      expect(rows.conversation?.revision).toBe(baselineRevision);
    },
  );

  it("settles authoritative OpenRouter accounting with the bounded compaction output cap", async () => {
    const fixture = await createFixture();
    const { gateway, stream } = gatewayFromSteps([
      { event: { text: summary, type: "content.delta" } },
      {
        event: {
          accounting: {
            cachedTokens: 3,
            costUsd: "0.000123",
            metadata: {
              provider: "Provider A",
              providerGenerationId: "openrouter-compaction-success",
              resolvedModel: "provider/fast-resolved",
            },
            reasoningTokens: 0,
          },
          reason: "stop",
          type: "response.completed",
          usage: { inputTokens: 41, outputTokens: 9 },
        },
      },
    ]);
    const timedGateway: ModelGateway = {
      async *stream(request, signal) {
        for await (const event of gateway.stream(request, signal)) {
          if (event.type === "response.headers") {
            yield { ...event, transportElapsedMilliseconds: 12 };
          } else if (event.type === "content.delta") {
            yield { ...event, transportElapsedMilliseconds: 34 };
          } else if (event.type === "response.completed" || event.type === "response.failed") {
            yield { ...event, transportElapsedMilliseconds: 56 };
          } else {
            yield event;
          }
        }
      },
    };

    const modelCall = {
      cancelRequested: vi.fn(),
      firstToken: vi.fn(),
      requestSent: vi.fn(),
      responseStarted: vi.fn(),
      settle: vi.fn(),
    };
    const telemetry = {
      changeActiveProviderCalls: vi.fn(),
      recordCompaction: vi.fn(),
      recordGeneration: vi.fn(),
      recordReservationSettlement: vi.fn(),
      recordSettlement: vi.fn(),
      startModelCall: vi.fn(() => modelCall),
    } satisfies CompactionTelemetry;
    const result = await createCompactionService({
      budget: createBudgetService(database),
      database,
      gateway: timedGateway,
      mode: "openrouter",
      telemetry,
    }).execute(fixture.context, new AbortController().signal);

    expect(result.kind).toBe("compacted");
    expect(stream).toHaveBeenCalledOnce();
    const request = stream.mock.calls[0]?.[0];
    expect(request?.route?.maximumOutputTokens).toBe(128);
    const rows = await lifecycleRows(fixture);
    expect(rows.hidden).toMatchObject({
      accountingStatus: "actual",
      cachedTokens: 3n,
      completionTokens: 9n,
      maximumOutputTokens: 128,
      openRouterGenerationId: "openrouter-compaction-success",
      promptTokens: 41n,
      provider: "Provider A",
      requestedModel: "synthetic/fast",
      resolvedModel: "provider/fast-resolved",
      status: "completed",
    });
    expect(Number(rows.hidden?.costUsd)).toBe(0.000123);
    expect(rows.compaction).toMatchObject({ status: "completed", summary });
    expect(rows.chat).toMatchObject({ status: "active" });
    expect(rows.conversation?.revision).toBe(baselineRevision);
    expect(telemetry.recordCompaction).toHaveBeenCalledWith("fast", "completed");
    expect(telemetry.recordGeneration).toHaveBeenCalledOnce();
    expect(telemetry.recordGeneration).toHaveBeenCalledWith(
      "fast",
      "compaction",
      "completed",
      expect.any(Number),
    );
    expect(telemetry.recordReservationSettlement).toHaveBeenCalledOnce();
    expect(telemetry.recordReservationSettlement).toHaveBeenCalledWith("actual");
    expect(telemetry.recordSettlement).toHaveBeenCalledOnce();
    expect(telemetry.recordSettlement).toHaveBeenCalledWith(
      "fast",
      "compaction",
      "completed",
      expect.any(Number),
    );
    expect(telemetry.changeActiveProviderCalls.mock.calls).toEqual([
      ["compaction", 1],
      ["compaction", -1],
    ]);
    expect(modelCall.responseStarted).toHaveBeenCalledWith(12);
    expect(modelCall.firstToken).toHaveBeenCalledWith(34);
    expect(modelCall.responseStarted.mock.invocationCallOrder[0]).toBeLessThan(
      modelCall.firstToken.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(modelCall.settle).toHaveBeenCalledOnce();
    expect(modelCall.settle).toHaveBeenCalledWith({
      cachedTokens: 3,
      completionTokens: 9,
      costUsd: "0.000123",
      outcome: "completed",
      promptTokens: 41,
      providerDurationMs: 56,
      reasoningTokens: 0,
    });
  });

  it("does not reuse a real completion when authoritative accounting is unavailable", async () => {
    const fixture = await createFixture();
    const { gateway, stream } = gatewayFromSteps([
      { event: { text: summary, type: "content.delta" } },
      {
        event: {
          accounting: {
            costUsd: "0.000123",
            metadata: { providerGenerationId: "openrouter-provider-missing" },
          },
          reason: "stop",
          type: "response.completed",
          usage: { inputTokens: 41, outputTokens: 9 },
        },
      },
    ]);

    const result = await execute(fixture, gateway, "openrouter");

    expect(result).toMatchObject({ kind: "fallback" });
    expect(stream).toHaveBeenCalledOnce();
    const rows = await lifecycleRows(fixture);
    expect(rows.hidden).toMatchObject({
      accountingStatus: "reserved",
      errorCode: "GENERATION_FAILED",
      status: "incomplete",
      terminalReason: "error",
    });
    expect(rows.compaction).toMatchObject({ status: "incomplete" });
    expect(rows.chat).toMatchObject({ status: "active" });
    expect(rows.conversation?.revision).toBe(baselineRevision);
  });

  it("settles deterministic zero for a real pre-provider failure without provider metadata", async () => {
    const fixture = await createFixture();
    const { gateway, stream } = gatewayFromSteps([
      {
        event: {
          accounting: { spendRisk: "none" },
          errorCode: "MODEL_UNAVAILABLE",
          type: "response.failed",
        },
      },
    ]);

    const result = await execute(fixture, gateway, "openrouter");

    expect(result).toMatchObject({ kind: "fallback" });
    expect(stream).toHaveBeenCalledOnce();
    const rows = await lifecycleRows(fixture);
    expect(rows.hidden).toMatchObject({
      accountingStatus: "actual",
      completionTokens: 0n,
      costBasis: "actual",
      errorCode: "MODEL_UNAVAILABLE",
      openRouterGenerationId: null,
      promptTokens: 0n,
      provider: null,
      status: "failed",
      terminalReason: "error",
    });
    expect(Number(rows.hidden?.costUsd)).toBe(0);
    expect(rows.compaction).toMatchObject({ status: "failed" });
    expect(rows.chat).toMatchObject({ status: "active" });
    expect(rows.conversation?.revision).toBe(baselineRevision);
  });

  it("aborts one hidden call, settles lookup accounting, and cancels the preparing chat", async () => {
    const fixture = await createFixture();
    const entered = Promise.withResolvers<void>();
    const stream = vi.fn<ModelGateway["stream"]>(async function* (_request, signal) {
      entered.resolve();
      yield {
        metadata: {
          providerGenerationId: "openrouter-compaction-cancelled",
          resolvedModel: "provider/fast-resolved",
        },
        type: "generation.metadata",
      };
      await new Promise<void>((_resolve, reject) => {
        const aborted = () => reject(new DOMException("Cancelled", "AbortError"));
        if (signal.aborted) {
          aborted();
          return;
        }
        signal.addEventListener("abort", aborted, { once: true });
      });
    });
    const lookupUsage = vi.fn<GenerationAccountingGateway["lookupUsage"]>(async () => ({
      accounting: {
        costUsd: "0.000010",
        metadata: {
          provider: "Provider A",
          providerGenerationId: "openrouter-compaction-cancelled",
          resolvedModel: "provider/fast-resolved",
        },
      },
      status: "found" as const,
      usage: { inputTokens: 17, outputTokens: 0 },
    }));
    const gateway: ModelGateway & GenerationAccountingGateway = { lookupUsage, stream };
    const abortController = new AbortController();

    const execution = execute(fixture, gateway, "openrouter", abortController.signal);
    await entered.promise;
    abortController.abort();
    const result = await execution;

    expect(result).toEqual({ kind: "cancelled" });
    expect(stream).toHaveBeenCalledOnce();
    expect(lookupUsage).toHaveBeenCalledOnce();
    expect(lookupUsage).toHaveBeenCalledWith(
      "openrouter-compaction-cancelled",
      expect.any(AbortSignal),
    );
    const rows = await lifecycleRows(fixture);
    expect(rows.hidden).toMatchObject({
      accountingStatus: "actual",
      completionTokens: 0n,
      costBasis: "actual",
      openRouterGenerationId: "openrouter-compaction-cancelled",
      promptTokens: 17n,
      provider: "Provider A",
      status: "cancelled",
      terminalReason: "cancelled",
    });
    expect(rows.compaction).toMatchObject({ status: "cancelled" });
    expect(rows.chat).toMatchObject({ status: "cancelled", terminalReason: "cancelled" });
    expect(rows.conversation?.revision).toBe(baselineRevision + 1);
  });

  it("settles delayed authoritative usage after durable deactivation wins terminalization", async () => {
    const fixture = await createFixture();
    const lookupStarted = Promise.withResolvers<void>();
    const delayedLookup =
      Promise.withResolvers<Awaited<ReturnType<GenerationAccountingGateway["lookupUsage"]>>>();
    const stream = vi.fn<ModelGateway["stream"]>(async function* () {
      yield {
        metadata: {
          providerGenerationId: "openrouter-compaction-deactivated",
          resolvedModel: "provider/fast-resolved",
        },
        type: "generation.metadata",
      };
      yield {
        accounting: {
          metadata: { providerGenerationId: "openrouter-compaction-deactivated" },
          spendRisk: "unknown",
        },
        errorCode: "GENERATION_FAILED",
        type: "response.failed",
      };
    });
    const lookupUsage = vi.fn<GenerationAccountingGateway["lookupUsage"]>(async () => {
      lookupStarted.resolve();
      return delayedLookup.promise;
    });
    const gateway: ModelGateway & GenerationAccountingGateway = { lookupUsage, stream };
    const execution = execute(fixture, gateway, "openrouter");
    await lookupStarted.promise;

    const budget = createBudgetService(database);
    const cancelledIds = await createGenerationAdministrationService(
      database,
      budget,
    ).cancelEmployeeWork(fixture.workspaceId, fixture.userId);
    const cancelledRows = await lifecycleRows(fixture);
    expect(cancelledIds).toHaveLength(2);
    expect(cancelledRows.hidden).toMatchObject({
      accountingStatus: "reserved",
      status: "cancelled",
      terminalReason: "cancelled",
    });
    expect(cancelledRows.compaction).toMatchObject({ status: "cancelled" });

    delayedLookup.resolve({
      accounting: {
        cachedTokens: 2,
        costUsd: "0.000031",
        metadata: {
          provider: "Provider A",
          providerGenerationId: "openrouter-compaction-deactivated",
          resolvedModel: "provider/fast-resolved",
        },
      },
      status: "found",
      usage: { inputTokens: 29, outputTokens: 4 },
    });
    const result = await execution;

    expect(result).toEqual({ kind: "cancelled" });
    expect(stream).toHaveBeenCalledOnce();
    expect(lookupUsage).toHaveBeenCalledOnce();
    const rows = await lifecycleRows(fixture);
    expect(rows.hidden).toMatchObject({
      accountingStatus: "actual",
      cachedTokens: 2n,
      completionTokens: 4n,
      costBasis: "actual",
      openRouterGenerationId: "openrouter-compaction-deactivated",
      promptTokens: 29n,
      provider: "Provider A",
      resolvedModel: "provider/fast-resolved",
      status: "cancelled",
      terminalReason: "cancelled",
    });
    expect(Number(rows.hidden?.costUsd)).toBe(0.000031);
    expect(rows.compaction).toMatchObject({ status: "cancelled" });
    expect(rows.chat).toMatchObject({ status: "cancelled", terminalReason: "cancelled" });
    expect(rows.conversation?.revision).toBe(baselineRevision + 1);
  });
});

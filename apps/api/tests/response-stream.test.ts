import Fastify, { type FastifyReply } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActiveStreamRegistry } from "../src/generations/active-streams.js";
import { FakeModelGateway } from "../src/generations/fake-model-gateway.js";
import type {
  GatewayProviderMetadata,
  GenerationAccountingGateway,
  ModelGateway,
} from "../src/generations/model-gateway.js";
import { systemPrompt } from "../src/generations/prompt.js";
import { createResponseStreamCoordinator } from "../src/generations/response-stream.js";
import type {
  DurableGenerationState,
  GenerationService,
  StartedResponse,
} from "../src/generations/service.js";
import { generationTuning } from "../src/generations/settings.js";
import { buildTitleRequest } from "../src/generations/title-service.js";
import { testEffectiveParameters } from "./support/generation.js";

const started: StartedResponse = {
  admittedAt: new Date(),
  conversationId: "00000000-0000-4000-8000-000000000001",
  generationId: "00000000-0000-4000-8000-000000000002",
  messageId: "00000000-0000-4000-8000-000000000003",
  request: {
    effectiveParameters: testEffectiveParameters(),
    history: [],
    message: { role: "user", text: "Synthetic request" },
    modelTier: "balanced",
    purpose: "chat",
    systemPrompt,
  },
  revision: 1,
  userMessageId: "00000000-0000-4000-8000-000000000004",
};

const routedStarted: StartedResponse = {
  ...started,
  request: {
    ...started.request,
    route: {
      completionPriceCeilingUsdPerToken: "0.000002",
      maximumOutputTokens: 1_024,
      promptPriceCeilingUsdPerToken: "0.000001",
      requestPriceCeilingUsd: "0",
      requestedModel: "synthetic/model",
    },
  },
};

const pendingStarted: StartedResponse = {
  ...started,
  compaction: {} as NonNullable<StartedResponse["compaction"]>,
};

const pendingRoutedStarted: StartedResponse = {
  ...routedStarted,
  compaction: {} as NonNullable<StartedResponse["compaction"]>,
};

type CompactionDependency = NonNullable<
  Parameters<typeof createResponseStreamCoordinator>[0]["compactions"]
>;
type ResponseStreamTelemetry = NonNullable<
  Parameters<typeof createResponseStreamCoordinator>[0]["telemetry"]
>;

interface MemoryGenerationService {
  service: GenerationService;
  content: string;
  failTerminalPersistence: boolean;
  firstTokenAt: Date | null;
  providerMetadata: GatewayProviderMetadata[];
  state: DurableGenerationState;
  terminalizeInputs: Parameters<GenerationService["terminalize"]>[1][];
}

function memoryGenerationService(
  status: DurableGenerationState["status"] = "active",
): MemoryGenerationService {
  const memory: MemoryGenerationService = {
    content: "",
    failTerminalPersistence: false,
    firstTokenAt: null,
    providerMetadata: [],
    service: undefined as unknown as GenerationService,
    state: {
      assistantMessageId: started.messageId,
      conversationId: started.conversationId,
      errorCode: null,
      reason: null,
      revision: 1,
      status,
    },
    terminalizeInputs: [],
  };
  memory.service = {
    checkpoint: async (_generationId: string, content: string, firstTokenAt: Date | null) => {
      if (memory.state.status !== "active") {
        return false;
      }
      memory.content = content;
      memory.firstTokenAt ??= firstTokenAt;
      return true;
    },
    recordProviderMetadata: async (_generationId: string, metadata: GatewayProviderMetadata) => {
      memory.providerMetadata.push(metadata);
      return true;
    },
    readState: async () => ({ ...memory.state }),
    settleAccounting: async () => false,
    terminalize: async (
      _generationId: string,
      input: Parameters<GenerationService["terminalize"]>[1],
    ) => {
      memory.terminalizeInputs.push(input);
      if (memory.failTerminalPersistence) {
        throw new Error("Synthetic terminal persistence failure");
      }
      if (memory.state.status !== "active") {
        return { ...memory.state, won: false };
      }
      memory.content = input.content;
      memory.firstTokenAt ??= input.firstTokenAt;
      memory.state = {
        assistantMessageId: started.messageId,
        conversationId: started.conversationId,
        errorCode: input.errorCode,
        reason: input.reason,
        revision: 2,
        status: input.status,
      };
      return { ...memory.state, won: true };
    },
  } as unknown as GenerationService;
  return memory;
}

const servers: ReturnType<typeof Fastify>[] = [];

async function streamUrl(
  gateway: ModelGateway,
  memory: MemoryGenerationService,
  registry = new ActiveStreamRegistry(),
  prepareReply?: (reply: FastifyReply) => void,
  response = started,
  compactions?: CompactionDependency,
  telemetry?: ResponseStreamTelemetry,
  heartbeatIntervalMilliseconds?: number,
): Promise<string> {
  const server = Fastify();
  servers.push(server);
  const coordinator = createResponseStreamCoordinator({
    ...(compactions === undefined ? {} : { compactions }),
    gateway,
    generations: memory.service,
    ...(heartbeatIntervalMilliseconds === undefined ? {} : { heartbeatIntervalMilliseconds }),
    registry,
    ...(telemetry === undefined ? {} : { telemetry }),
  });
  server.post("/stream", async (request, reply) => {
    prepareReply?.(reply);
    await coordinator.stream(response, request, reply);
  });
  await server.listen({ host: "127.0.0.1", port: 0 });
  const address = server.server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Synthetic stream listener did not expose a port");
  }
  return `http://127.0.0.1:${address.port}/stream`;
}

async function eventsFrom(response: Response): Promise<readonly Record<string, unknown>[]> {
  return (await response.text())
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function waitForState(
  memory: MemoryGenerationService,
  status: DurableGenerationState["status"],
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (memory.state.status === status) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Generation never reached ${status}`);
}

async function shutdownDuringCancellation(outcome: "commit" | "rollback") {
  const memory = memoryGenerationService();
  const registry = new ActiveStreamRegistry();
  const allowSecondDelta = Promise.withResolvers<void>();
  const secondDeltaYielded = Promise.withResolvers<void>();
  const gateway: ModelGateway = {
    async *stream() {
      yield { text: "Visible partial", type: "content.delta" };
      await allowSecondDelta.promise;
      secondDeltaYielded.resolve();
      yield { text: "Must not forward", type: "content.delta" };
    },
  };
  const response = await fetch(await streamUrl(gateway, memory, registry), { method: "POST" });
  const reader = response.body?.getReader();
  if (reader === undefined) {
    throw new Error("Streaming response did not expose a reader");
  }
  const decoder = new TextDecoder();
  let received = "";
  while (!received.includes("Visible partial")) {
    const chunk = await reader.read();
    if (chunk.done) {
      throw new Error("Stream ended before the visible partial");
    }
    received += decoder.decode(chunk.value, { stream: true });
  }

  const capture = registry.captureCancellation(started.generationId);
  if (capture === undefined) {
    throw new Error("Local stream did not expose its cancellation snapshot");
  }
  allowSecondDelta.resolve();
  await secondDeltaYielded.promise;
  registry.abortAll("shutdown");
  if (outcome === "commit") {
    memory.content = capture.snapshot.content;
    memory.firstTokenAt = capture.snapshot.firstTokenAt;
    memory.state = {
      ...memory.state,
      errorCode: null,
      reason: "cancelled",
      revision: 2,
      status: "cancelled",
    };
    capture.commit();
  } else {
    capture.release();
  }

  while (true) {
    const chunk = await reader.read();
    if (chunk.done) {
      received += decoder.decode();
      break;
    }
    received += decoder.decode(chunk.value, { stream: true });
  }
  const events = received
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  return { events, memory };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("response stream normalization", () => {
  it("does not call the provider when cancellation committed before stream registration", async () => {
    const memory = memoryGenerationService("cancelled");
    memory.state = {
      ...memory.state,
      reason: "cancelled",
      revision: 2,
      status: "cancelled",
    };
    const gatewayStream = vi.fn<ModelGateway["stream"]>(() => {
      throw new Error("Provider must not start after durable cancellation");
    });

    const events = await eventsFrom(
      await fetch(await streamUrl({ stream: gatewayStream }, memory), { method: "POST" }),
    );

    expect(events.map((event) => event.type)).toEqual(["response.started", "response.cancelled"]);
    expect(gatewayStream).not.toHaveBeenCalled();
  });

  it("tracks deferred title accounting after the response until the shutdown fence can release", async () => {
    const memory = memoryGenerationService();
    const registry = new ActiveStreamRegistry();
    const baseTerminalize = memory.service.terminalize.bind(memory.service);
    const titleStarted = Promise.withResolvers<void>();
    const releaseTitle = Promise.withResolvers<void>();
    const settlementStarted = Promise.withResolvers<void>();
    const releaseSettlement = Promise.withResolvers<void>();
    const observations: unknown[] = [];
    const finalizationInputs: Parameters<GenerationService["finalizeNaming"]>[0][] = [];
    const lateAccounting = {
      cachedTokens: 1,
      costUsd: "0.0004",
      metadata: {
        provider: "synthetic-provider",
        resolvedModel: "synthetic/title-model",
      },
      reasoningTokens: 0,
    } as const;
    const finalizeNaming = vi.fn<GenerationService["finalizeNaming"]>(async (input) => {
      finalizationInputs.push(input);
      if (memory.state.status === "finalizing") {
        memory.state = { ...memory.state, revision: 2, status: "completed" };
        return { kind: "finalized", revision: 2, titleApplied: false };
      }
      return { kind: "lost-cas", revision: memory.state.revision, titleApplied: false };
    });
    const settleLateTitleAccounting = vi.fn<GenerationService["settleLateTitleAccounting"]>(
      async () => {
        settlementStarted.resolve();
        await releaseSettlement.promise;
        return true;
      },
    );
    memory.service = {
      ...memory.service,
      finalizeNaming,
      recordTitleObservation: vi.fn(async (_generationId, observation) => {
        observations.push(observation);
        return true;
      }),
      settleLateTitleAccounting,
      terminalize: async (generationId, input) => {
        const result = await baseTerminalize(generationId, input);
        if (!result.won || result.status !== "completed") {
          return result;
        }
        memory.state = { ...memory.state, revision: 1, status: "finalizing" };
        const providerDeadlineAt = new Date(Date.now() + 50);
        return {
          ...result,
          naming: {
            deadlineAt: new Date(providerDeadlineAt.getTime() + 40),
            providerDeadlineAt,
            request: { ...buildTitleRequest("Pregunta", input.content) },
            titleGenerationId: "00000000-0000-4000-8000-000000000099",
          },
          revision: 1,
          status: "finalizing" as const,
        };
      },
    } as GenerationService;
    const gateway: ModelGateway = {
      async *stream(request) {
        if (request.purpose === "chat") {
          yield { text: "Respuesta útil", type: "content.delta" };
          yield {
            reason: "stop",
            type: "response.completed",
            usage: { inputTokens: 4, outputTokens: 2 },
          };
          return;
        }
        yield {
          metadata: { providerGenerationId: "late-title-provider-id" },
          type: "generation.metadata",
        };
        titleStarted.resolve();
        await releaseTitle.promise;
        yield { text: "Título tardío", type: "content.delta" };
        yield {
          accounting: lateAccounting,
          reason: "stop",
          type: "response.completed",
          usage: { inputTokens: 3, outputTokens: 2 },
        };
      },
    };

    const eventsPromise = fetch(await streamUrl(gateway, memory, registry), {
      method: "POST",
    }).then(eventsFrom);
    await titleStarted.promise;
    const events = await eventsPromise;

    expect(events.map((event) => event.type)).toEqual([
      "response.started",
      "content.delta",
      "conversation.naming",
      "response.completed",
    ]);
    expect(finalizationInputs[0]?.outcome).toMatchObject({
      errorCode: "GENERATION_TIMEOUT",
      kind: "failed",
    });
    expect(observations).toEqual([
      { metadata: { providerGenerationId: "late-title-provider-id" } },
    ]);
    expect(registry.size).toBe(1);
    registry.beginDraining();
    const shutdownFence = registry.waitForIdle(1_000);

    releaseTitle.resolve();
    await settlementStarted.promise;
    expect(finalizeNaming).toHaveBeenCalledTimes(2);
    expect(finalizationInputs[1]?.outcome).toMatchObject({
      firstTokenAt: expect.any(Date),
      kind: "titled",
      metadata: { providerGenerationId: "late-title-provider-id" },
      title: "Título tardío",
    });
    expect(settleLateTitleAccounting).toHaveBeenCalledOnce();
    expect(settleLateTitleAccounting).toHaveBeenCalledWith(
      "00000000-0000-4000-8000-000000000099",
      { inputTokens: 3, outputTokens: 2 },
      lateAccounting,
      {
        firstTokenAt: expect.any(Date),
        metadata: {
          provider: "synthetic-provider",
          providerGenerationId: "late-title-provider-id",
          resolvedModel: "synthetic/title-model",
        },
      },
    );
    expect(registry.size).toBe(1);
    await expect(registry.waitForIdle(1)).resolves.toBe(false);

    releaseSettlement.resolve();
    await expect(shutdownFence).resolves.toBe(true);
    expect(registry.size).toBe(0);
  });

  it("keeps an answer-durable finalizing parent out of failed workflow telemetry", async () => {
    const memory = memoryGenerationService();
    const baseTerminalize = memory.service.terminalize.bind(memory.service);
    const failedAccounting = {
      costUsd: "0.0002",
      metadata: {
        provider: "synthetic-provider",
        providerGenerationId: "failed-title-provider-id",
        resolvedModel: "synthetic/title-model",
      },
    } as const;
    const finalizeNaming = vi.fn<GenerationService["finalizeNaming"]>(async () => {
      throw new Error("Synthetic naming persistence failure");
    });
    const settleLateTitleAccounting = vi.fn<GenerationService["settleLateTitleAccounting"]>(
      async () => true,
    );
    memory.service = {
      ...memory.service,
      finalizeNaming,
      recordTitleObservation: vi.fn(async () => true),
      settleLateTitleAccounting,
      terminalize: async (generationId, input) => {
        const result = await baseTerminalize(generationId, input);
        if (!result.won || result.status !== "completed") {
          return result;
        }
        memory.state = { ...memory.state, revision: 1, status: "finalizing" };
        const providerDeadlineAt = new Date(Date.now() + 10);
        return {
          ...result,
          naming: {
            deadlineAt: new Date(providerDeadlineAt.getTime() + 10),
            providerDeadlineAt,
            request: { ...buildTitleRequest("Pregunta", input.content) },
            titleGenerationId: "00000000-0000-4000-8000-000000000098",
          },
          revision: 1,
          status: "finalizing" as const,
        };
      },
    } as GenerationService;
    const recordGeneration = vi.fn();
    const telemetry = {
      changeActiveEmployeeStreams: vi.fn(),
      changeActiveProviderCalls: vi.fn(),
      recordContextDecision: vi.fn(),
      recordGeneration,
      recordResponseStarted: vi.fn(),
      startModelCall: vi.fn(() => ({
        cancelRequested: vi.fn(),
        firstToken: vi.fn(),
        requestSent: vi.fn(),
        responseStarted: vi.fn(),
        settle: vi.fn(),
      })),
    } satisfies ResponseStreamTelemetry;
    const gateway: ModelGateway = {
      async *stream(request) {
        if (request.purpose === "chat") {
          yield { text: "Respuesta durable", type: "content.delta" };
          yield {
            reason: "stop",
            type: "response.completed",
            usage: { inputTokens: 4, outputTokens: 2 },
          };
          return;
        }
        yield {
          accounting: { actual: failedAccounting, spendRisk: "unknown" },
          errorCode: "GENERATION_FAILED",
          type: "response.failed",
          usage: { inputTokens: 2, outputTokens: 0 },
        };
      },
    };

    const events = await eventsFrom(
      await fetch(
        await streamUrl(gateway, memory, undefined, undefined, started, undefined, telemetry),
        {
          method: "POST",
        },
      ),
    );

    expect(events.map((event) => event.type)).toEqual([
      "response.started",
      "content.delta",
      "conversation.naming",
    ]);
    expect(memory.state.status).toBe("finalizing");
    expect(finalizeNaming).toHaveBeenCalledTimes(2);
    expect(settleLateTitleAccounting).toHaveBeenCalledOnce();
    expect(settleLateTitleAccounting).toHaveBeenCalledWith(
      "00000000-0000-4000-8000-000000000098",
      { inputTokens: 2, outputTokens: 0 },
      failedAccounting,
      {
        firstTokenAt: null,
        metadata: failedAccounting.metadata,
      },
    );
    expect(
      finalizeNaming.mock.calls.every(([input]) => input.persistenceDeadlineAt instanceof Date),
    ).toBe(true);
    expect(recordGeneration).toHaveBeenCalledWith(
      "balanced",
      "chat",
      "completed",
      expect.any(Number),
    );
  });

  it("stops awaiting a finalizer that cannot acquire a pool client at the persistence deadline", async () => {
    const memory = memoryGenerationService();
    const baseTerminalize = memory.service.terminalize.bind(memory.service);
    const blockedFinalization =
      Promise.withResolvers<Awaited<ReturnType<GenerationService["finalizeNaming"]>>>();
    const finalizeNaming = vi.fn<GenerationService["finalizeNaming"]>(
      () => blockedFinalization.promise,
    );
    memory.service = {
      ...memory.service,
      finalizeNaming,
      recordTitleObservation: vi.fn(async () => true),
      terminalize: async (generationId, input) => {
        const result = await baseTerminalize(generationId, input);
        if (!result.won || result.status !== "completed") {
          return result;
        }
        memory.state = { ...memory.state, revision: 1, status: "finalizing" };
        const providerDeadlineAt = new Date(Date.now() + 30);
        return {
          ...result,
          naming: {
            deadlineAt: new Date(providerDeadlineAt.getTime() + 30),
            providerDeadlineAt,
            request: { ...buildTitleRequest("Pregunta", input.content) },
            titleGenerationId: "00000000-0000-4000-8000-000000000097",
          },
          revision: 1,
          status: "finalizing" as const,
        };
      },
    } as GenerationService;
    const gateway: ModelGateway = {
      async *stream(request) {
        if (request.purpose === "chat") {
          yield { text: "Respuesta durable", type: "content.delta" };
          yield {
            reason: "stop",
            type: "response.completed",
            usage: { inputTokens: 4, outputTokens: 2 },
          };
          return;
        }
        yield { errorCode: "GENERATION_FAILED", type: "response.failed" };
      },
    };

    const startedAt = performance.now();
    const events = await eventsFrom(
      await fetch(await streamUrl(gateway, memory), { method: "POST" }),
    );

    expect(performance.now() - startedAt).toBeLessThan(500);
    expect(events.map((event) => event.type)).toEqual([
      "response.started",
      "content.delta",
      "conversation.naming",
    ]);
    expect(finalizeNaming).toHaveBeenCalledTimes(2);
    blockedFinalization.resolve({ kind: "lost-cas", revision: 1, titleApplied: false });
  });

  it("keeps a silent provider stream alive with content-free heartbeats", async () => {
    const memory = memoryGenerationService();
    let deltaAt = 0;
    const gateway: ModelGateway = {
      async *stream() {
        await new Promise((resolve) => setTimeout(resolve, 35));
        deltaAt = Date.now();
        yield { text: "Respuesta después del silencio", type: "content.delta" };
        yield {
          reason: "stop",
          type: "response.completed",
          usage: { inputTokens: 5, outputTokens: 4 },
        };
      },
    };

    const events = await eventsFrom(
      await fetch(
        await streamUrl(gateway, memory, undefined, undefined, started, undefined, undefined, 10),
        { method: "POST" },
      ),
    );

    const eventTypes = events.map((event) => event.type);
    expect(eventTypes[0]).toBe("response.started");
    expect(eventTypes).toContain("stream.heartbeat");
    expect(eventTypes.slice(-2)).toEqual(["content.delta", "response.completed"]);
    expect(events.filter((event) => event.type === "stream.heartbeat")).toEqual(
      expect.arrayContaining([{ type: "stream.heartbeat" }]),
    );
    expect(memory.content).toBe("Respuesta después del silencio");
    expect(memory.firstTokenAt?.getTime()).toBeGreaterThanOrEqual(deltaAt);
    expect(memory.state.status).toBe("completed");
  });

  it("warns before chat output when admission selected direct context fallback", async () => {
    const memory = memoryGenerationService();
    const events = await eventsFrom(
      await fetch(
        await streamUrl(
          new FakeModelGateway([
            { event: { text: "Respuesta acotada", type: "content.delta" } },
            {
              event: {
                reason: "stop",
                type: "response.completed",
                usage: { inputTokens: 12, outputTokens: 3 },
              },
            },
          ]),
          memory,
          undefined,
          undefined,
          { ...started, contextWarning: true },
        ),
        { method: "POST" },
      ),
    );

    expect(events.map((event) => event.type)).toEqual([
      "response.started",
      "context.warning",
      "content.delta",
      "response.completed",
    ]);
    expect(events[1]).toEqual({
      code: "CONTEXT_COMPACTION_FALLBACK",
      type: "context.warning",
    });
  });

  it.each([
    { kind: "compacted" as const, settledEvent: "context.compacted" },
    { kind: "fallback" as const, settledEvent: "context.warning" },
  ])(
    "orders $kind compaction before the one ordinary chat call",
    async ({ kind, settledEvent }) => {
      const memory = memoryGenerationService("preparing");
      const gatewayStream = vi.fn(async function* () {
        yield { text: "Respuesta compactada", type: "content.delta" } as const;
        yield {
          reason: "stop",
          type: "response.completed",
          usage: { inputTokens: 18, outputTokens: 4 },
        } as const;
      });
      const compactions = {
        cancel: vi.fn(async () => undefined),
        execute: vi.fn(async () => {
          memory.state = { ...memory.state, status: "active" };
          return { chat: { request: started.request }, kind };
        }),
      } as unknown as CompactionDependency;
      const events = await eventsFrom(
        await fetch(
          await streamUrl(
            { stream: gatewayStream },
            memory,
            undefined,
            undefined,
            pendingRoutedStarted,
            compactions,
          ),
          { method: "POST" },
        ),
      );

      expect(events.map((event) => event.type)).toEqual([
        "response.started",
        "context.compacting",
        settledEvent,
        "content.delta",
        "response.completed",
      ]);
      if (kind === "fallback") {
        expect(events[2]).toEqual({
          code: "CONTEXT_COMPACTION_FALLBACK",
          type: "context.warning",
        });
      }
      expect(compactions.execute).toHaveBeenCalledOnce();
      expect(gatewayStream).toHaveBeenCalledOnce();
    },
  );

  it("refreshes after an in-flight preparing snapshot before publishing compacted chat", async () => {
    const memory = memoryGenerationService("preparing");
    const stalePreparingRead = Promise.withResolvers<DurableGenerationState | null>();
    const compactionPromoted = Promise.withResolvers<void>();
    const stateReadStarted = Promise.withResolvers<void>();
    const originalReadState = memory.service.readState.bind(memory.service);
    let stateReads = 0;
    memory.service = {
      ...memory.service,
      readState: (generationId: string) => {
        stateReads += 1;
        if (stateReads === 2) {
          stateReadStarted.resolve();
          return stalePreparingRead.promise;
        }
        return originalReadState(generationId);
      },
    } as GenerationService;
    const gatewayStream = vi.fn(async function* () {
      yield { text: "Respuesta después de compactar", type: "content.delta" } as const;
      yield {
        reason: "stop",
        type: "response.completed",
        usage: { inputTokens: 18, outputTokens: 4 },
      } as const;
    });
    const compactions = {
      cancel: vi.fn(async () => undefined),
      execute: vi.fn(async () => {
        await stateReadStarted.promise;
        memory.state = { ...memory.state, status: "active" };
        compactionPromoted.resolve();
        return { chat: { request: started.request }, kind: "compacted" as const };
      }),
    } as unknown as CompactionDependency;
    const responsePromise = fetch(
      await streamUrl(
        { stream: gatewayStream },
        memory,
        undefined,
        undefined,
        pendingRoutedStarted,
        compactions,
      ),
      { method: "POST" },
    );

    await compactionPromoted.promise;
    stalePreparingRead.resolve({ ...memory.state, status: "preparing" });
    const events = await eventsFrom(await responsePromise);

    expect(events.map((event) => event.type)).toEqual([
      "response.started",
      "context.compacting",
      "context.compacted",
      "content.delta",
      "response.completed",
    ]);
    expect(stateReads).toBeGreaterThanOrEqual(2);
    expect(gatewayStream).toHaveBeenCalledOnce();
  });

  it("refreshes after an in-flight preparing snapshot when compaction returns cancelled", async () => {
    const memory = memoryGenerationService("preparing");
    const stalePreparingRead = Promise.withResolvers<DurableGenerationState | null>();
    const compactionCancelled = Promise.withResolvers<void>();
    const stateReadStarted = Promise.withResolvers<void>();
    const originalReadState = memory.service.readState.bind(memory.service);
    let stateReads = 0;
    memory.service = {
      ...memory.service,
      readState: (generationId: string) => {
        stateReads += 1;
        if (stateReads === 2) {
          stateReadStarted.resolve();
          return stalePreparingRead.promise;
        }
        return originalReadState(generationId);
      },
    } as GenerationService;
    const gatewayStream = vi.fn(() => {
      throw new Error("Chat must not start after compaction cancellation");
    });
    const compactions = {
      cancel: vi.fn(async () => undefined),
      execute: vi.fn(async () => {
        await stateReadStarted.promise;
        memory.state = {
          ...memory.state,
          reason: "cancelled",
          revision: 2,
          status: "cancelled",
        };
        compactionCancelled.resolve();
        return { kind: "cancelled" as const };
      }),
    } as unknown as CompactionDependency;
    const responsePromise = fetch(
      await streamUrl(
        { stream: gatewayStream },
        memory,
        undefined,
        undefined,
        pendingRoutedStarted,
        compactions,
      ),
      { method: "POST" },
    );

    await compactionCancelled.promise;
    stalePreparingRead.resolve({ ...memory.state, reason: null, revision: 1, status: "preparing" });
    const events = await eventsFrom(await responsePromise);

    expect(events.map((event) => event.type)).toEqual([
      "response.started",
      "context.compacting",
      "response.cancelled",
    ]);
    expect(stateReads).toBeGreaterThanOrEqual(2);
    expect(gatewayStream).not.toHaveBeenCalled();
  });

  it("recovers cancellation directly while compaction is pending without calling chat", async () => {
    const memory = memoryGenerationService("preparing");
    const compactionStarted = Promise.withResolvers<void>();
    const releaseCompaction = Promise.withResolvers<void>();
    const gatewayStream = vi.fn(() => {
      throw new Error("Chat must not start after compaction cancellation");
    });
    const compactions = {
      cancel: vi.fn(async () => undefined),
      execute: vi.fn(async () => {
        compactionStarted.resolve();
        await releaseCompaction.promise;
        return { kind: "cancelled" as const };
      }),
    } as unknown as CompactionDependency;
    const response = fetch(
      await streamUrl(
        { stream: gatewayStream },
        memory,
        undefined,
        undefined,
        pendingStarted,
        compactions,
      ),
      { method: "POST" },
    );
    await compactionStarted.promise;
    memory.state = {
      ...memory.state,
      errorCode: null,
      reason: "cancelled",
      revision: 2,
      status: "cancelled",
    };
    releaseCompaction.resolve();

    const events = await eventsFrom(await response);

    expect(events.map((event) => event.type)).toEqual([
      "response.started",
      "context.compacting",
      "response.cancelled",
    ]);
    expect(gatewayStream).not.toHaveBeenCalled();
  });

  it.each([
    {
      expectedCode: "GENERATION_FAILED",
      expectedPartial: false,
      expectedStatus: "failed",
      steps: [{ event: { errorCode: "GENERATION_FAILED", type: "response.failed" } }],
    },
    {
      expectedCode: "GENERATION_TIMEOUT",
      expectedPartial: false,
      expectedStatus: "failed",
      steps: [{ event: { errorCode: "GENERATION_TIMEOUT", type: "response.failed" } }],
    },
    {
      expectedCode: "MODEL_UNAVAILABLE",
      expectedPartial: true,
      expectedStatus: "incomplete",
      steps: [
        { event: { text: "Useful partial", type: "content.delta" } },
        { event: { errorCode: "MODEL_UNAVAILABLE", type: "response.failed" } },
      ],
    },
    {
      expectedCode: "EMPTY_RESPONSE",
      expectedPartial: false,
      expectedStatus: "failed",
      steps: [
        {
          event: {
            reason: "stop",
            type: "response.completed",
            usage: { inputTokens: 1, outputTokens: 0 },
          },
        },
      ],
    },
  ] as const)(
    "normalizes $expectedCode as $expectedStatus",
    async ({ expectedCode, expectedPartial, expectedStatus, steps }) => {
      const memory = memoryGenerationService();
      const url = await streamUrl(new FakeModelGateway(steps), memory);
      const events = await eventsFrom(await fetch(url, { method: "POST" }));
      expect(events.at(0)?.type).toBe("response.started");
      expect(events.at(-1)).toMatchObject({
        errorCode: expectedCode,
        partial: expectedPartial,
        type: "response.failed",
      });
      expect(memory.state).toMatchObject({ errorCode: expectedCode, status: expectedStatus });
    },
  );

  it.each(["stop", "length", "refusal", "content_filter"] as const)(
    "persists and emits the exact %s completion reason",
    async (reason) => {
      const memory = memoryGenerationService();
      const events = await eventsFrom(
        await fetch(
          await streamUrl(
            new FakeModelGateway([
              { event: { text: "Useful response", type: "content.delta" } },
              {
                event: {
                  reason,
                  type: "response.completed",
                  usage: { inputTokens: 2, outputTokens: 3 },
                },
              },
            ]),
            memory,
          ),
          { method: "POST" },
        ),
      );

      expect(events.at(-1)).toMatchObject({ reason, type: "response.completed" });
      expect(memory.content).toBe("Useful response");
      expect(memory.firstTokenAt).not.toBeNull();
      expect(memory.state).toMatchObject({ reason, status: "completed" });
    },
  );

  it("records one safe model and workflow lifecycle for a completed chat", async () => {
    const memory = memoryGenerationService();
    const admittedAt = new Date(Date.now() - 1_000);
    const coordinatorDelay = async (): Promise<void> => {
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    };
    const originalRecordProviderMetadata = memory.service.recordProviderMetadata.bind(
      memory.service,
    );
    const originalTerminalize = memory.service.terminalize.bind(memory.service);
    const lifecycle: string[] = [];
    memory.service = {
      ...memory.service,
      recordProviderMetadata: async (generationId, metadata) => {
        await coordinatorDelay();
        lifecycle.push("metadata.persisted");
        return originalRecordProviderMetadata(generationId, metadata);
      },
      terminalize: async (generationId, input) => {
        lifecycle.push("terminalization.started");
        await coordinatorDelay();
        return originalTerminalize(generationId, input);
      },
    } as GenerationService;
    const modelCall = {
      cancelRequested: vi.fn(),
      firstToken: vi.fn(),
      requestSent: vi.fn(),
      responseStarted: vi.fn(),
      settle: vi.fn(),
    };
    const telemetry = {
      changeActiveEmployeeStreams: vi.fn(),
      changeActiveProviderCalls: vi.fn((_purpose, change) => {
        if (change === -1) {
          lifecycle.push("provider.stopped");
        }
      }),
      recordContextDecision: vi.fn(),
      recordGeneration: vi.fn(),
      recordResponseStarted: vi.fn(),
      startModelCall: vi.fn(() => modelCall),
    } satisfies ResponseStreamTelemetry;
    const gateway: ModelGateway = {
      async *stream() {
        yield { transportElapsedMilliseconds: 12, type: "response.headers" };
        yield {
          metadata: { providerGenerationId: "synthetic-safe-generation" },
          type: "generation.metadata",
        };
        yield {
          text: "Safe response",
          transportElapsedMilliseconds: 34,
          type: "content.delta",
        };
        yield {
          accounting: {
            cachedTokens: 2,
            costUsd: "0.000123",
            metadata: {},
            reasoningTokens: 1,
          },
          reason: "stop",
          transportElapsedMilliseconds: 56,
          type: "response.completed",
          usage: { inputTokens: 11, outputTokens: 7 },
        };
      },
    };
    const events = await eventsFrom(
      await fetch(
        await streamUrl(
          gateway,
          memory,
          undefined,
          (reply) => {
            const originalWrite = reply.raw.write.bind(reply.raw);
            reply.raw.write = ((chunk: string | Uint8Array, encoding?: BufferEncoding) => {
              const accepted =
                encoding === undefined ? originalWrite(chunk) : originalWrite(chunk, encoding);
              if (
                accepted &&
                typeof chunk === "string" &&
                (chunk.includes('"type":"content.delta"') ||
                  chunk.includes('"type":"response.completed"'))
              ) {
                setTimeout(() => reply.raw.emit("drain"), 20);
                return false;
              }
              return accepted;
            }) as typeof reply.raw.write;
          },
          { ...routedStarted, admittedAt, startedAt: new Date() },
          undefined,
          telemetry,
        ),
        { method: "POST" },
      ),
    );

    expect(events.at(-1)?.type).toBe("response.completed");
    expect(JSON.stringify(events)).not.toContain("response.headers");
    expect(JSON.stringify(events)).not.toContain("transportElapsedMilliseconds");
    expect(telemetry.changeActiveEmployeeStreams.mock.calls).toEqual([
      ["balanced", 1],
      ["balanced", -1],
    ]);
    expect(telemetry.changeActiveProviderCalls.mock.calls).toEqual([
      ["chat", 1],
      ["chat", -1],
    ]);
    expect(telemetry.recordContextDecision).toHaveBeenCalledOnce();
    expect(telemetry.recordContextDecision).toHaveBeenCalledWith("balanced", "full");
    expect(telemetry.recordGeneration).toHaveBeenCalledOnce();
    expect(telemetry.recordGeneration).toHaveBeenCalledWith(
      "balanced",
      "chat",
      "completed",
      expect.any(Number),
    );
    expect(telemetry.recordResponseStarted).toHaveBeenCalledWith(
      "balanced",
      "chat",
      expect.any(Number),
    );
    expect(telemetry.recordResponseStarted.mock.calls[0]?.[2]).toBeGreaterThanOrEqual(900);
    expect(modelCall.requestSent).toHaveBeenCalledOnce();
    expect(modelCall.responseStarted).toHaveBeenCalledWith(12);
    expect(modelCall.firstToken).toHaveBeenCalledWith(34);
    expect(modelCall.responseStarted.mock.invocationCallOrder[0]).toBeLessThan(
      modelCall.firstToken.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(modelCall.settle).toHaveBeenCalledOnce();
    expect(modelCall.settle).toHaveBeenCalledWith({
      cachedTokens: 2,
      completionTokens: 7,
      costUsd: "0.000123",
      outcome: "completed",
      promptTokens: 11,
      providerDurationMs: 56,
      reasoningTokens: 1,
    });
    expect(lifecycle).toEqual([
      "metadata.persisted",
      "provider.stopped",
      "terminalization.started",
    ]);
  });

  it("passes recovered provider accounting into terminal persistence", async () => {
    const memory = memoryGenerationService();
    const events = await eventsFrom(
      await fetch(
        await streamUrl(
          new FakeModelGateway([
            { event: { text: "Provider-backed response", type: "content.delta" } },
            {
              event: {
                accounting: {
                  costUsd: "0.000123",
                  metadata: {
                    provider: "provider-recovered",
                    providerGenerationId: "provider-generation-recovered",
                    resolvedModel: "synthetic/resolved-model",
                  },
                },
                reason: "stop",
                type: "response.completed",
                usage: { inputTokens: 11, outputTokens: 7 },
              },
            },
          ]),
          memory,
          undefined,
          undefined,
          routedStarted,
        ),
        { method: "POST" },
      ),
    );

    expect(events.at(-1)).toMatchObject({ reason: "stop", type: "response.completed" });
    expect(memory.terminalizeInputs.at(-1)).toMatchObject({
      accounting: {
        metadata: {
          costUsd: "0.000123",
          metadata: {
            provider: "provider-recovered",
            providerGenerationId: "provider-generation-recovered",
            resolvedModel: "synthetic/resolved-model",
          },
        },
        usage: { inputTokens: 11, outputTokens: 7 },
      },
      reason: "stop",
      status: "completed",
    });
  });

  it("requests deterministic zero settlement for a proven no-spend provider failure", async () => {
    const memory = memoryGenerationService();
    const gateway: ModelGateway = {
      async *stream() {
        yield {
          accounting: { spendRisk: "none" },
          errorCode: "GENERATION_FAILED",
          providerErrorType: "authentication",
          type: "response.failed",
        };
      },
    };

    const events = await eventsFrom(
      await fetch(await streamUrl(gateway, memory, undefined, undefined, routedStarted), {
        method: "POST",
      }),
    );

    expect(events.at(-1)).toMatchObject({
      errorCode: "GENERATION_FAILED",
      type: "response.failed",
    });
    expect(memory.terminalizeInputs).toHaveLength(1);
    expect(memory.terminalizeInputs[0]).toMatchObject({
      settleDeterministicZero: true,
      status: "failed",
    });
  });

  it("ends without a false terminal event when terminal persistence fails", async () => {
    const memory = memoryGenerationService();
    memory.failTerminalPersistence = true;
    const url = await streamUrl(
      new FakeModelGateway([
        { event: { errorCode: "GENERATION_FAILED", type: "response.failed" } },
      ]),
      memory,
    );
    const events = await eventsFrom(await fetch(url, { method: "POST" }));
    expect(events.map((event) => event.type)).toEqual(["response.started"]);
    expect(memory.state.status).toBe("active");
  });

  it("rejects a PostgreSQL-incompatible NUL before forwarding or persisting it", async () => {
    const memory = memoryGenerationService();
    const url = await streamUrl(
      new FakeModelGateway([
        { event: { text: "Valid partial", type: "content.delta" } },
        { event: { text: "\u0000invalid", type: "content.delta" } },
      ]),
      memory,
    );
    const events = await eventsFrom(await fetch(url, { method: "POST" }));
    expect(events).toContainEqual({ text: "Valid partial", type: "content.delta" });
    expect(events).not.toContainEqual(expect.objectContaining({ text: "\u0000invalid" }));
    expect(events.at(-1)).toMatchObject({
      errorCode: "GENERATION_FAILED",
      partial: true,
      type: "response.failed",
    });
    expect(memory.content).toBe("Valid partial");
    expect(memory.state.status).toBe("incomplete");
  });

  it("makes a delta observable before delayed terminal completion", async () => {
    let releaseCompletion: (() => void) | undefined;
    const completionGate = new Promise<void>((resolve) => {
      releaseCompletion = resolve;
    });
    const gateway: ModelGateway = {
      async *stream() {
        yield { text: "Early delta", type: "content.delta" };
        await completionGate;
        yield {
          reason: "stop",
          type: "response.completed",
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    };
    const memory = memoryGenerationService();
    const response = await fetch(await streamUrl(gateway, memory), { method: "POST" });
    const reader = response.body?.getReader();
    if (reader === undefined) {
      throw new Error("Streaming response did not expose a reader");
    }
    const decoder = new TextDecoder();
    let received = "";
    while (!received.includes("content.delta")) {
      const chunk = await reader.read();
      if (chunk.done) {
        throw new Error("Stream ended before the early delta");
      }
      received += decoder.decode(chunk.value, { stream: true });
    }
    expect(received).toContain("Early delta");
    expect(received).not.toContain("response.completed");
    releaseCompletion?.();
    while (!(await reader.read()).done) {
      // Drain the connected response after releasing completion.
    }
    expect(memory.state.status).toBe("completed");
  });

  it("holds upstream pulls until a real HTTP response drains", async () => {
    let response: FastifyReply["raw"] | undefined;
    let drainCount = 0;
    let drainsBeforeSecondPull = 0;
    let bufferedBytesBeforeSecondPull = Number.POSITIVE_INFINITY;
    let gatewayPulls = 0;
    const gateway: ModelGateway = {
      async *stream() {
        gatewayPulls += 1;
        yield { text: "x".repeat(65_501), type: "content.delta" };
        drainsBeforeSecondPull = drainCount;
        bufferedBytesBeforeSecondPull = response?.writableLength ?? Number.POSITIVE_INFINITY;
        gatewayPulls += 1;
        yield {
          reason: "stop",
          type: "response.completed",
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    };
    const memory = memoryGenerationService();
    const url = await streamUrl(gateway, memory, new ActiveStreamRegistry(), (reply) => {
      response = reply.raw;
      response.on("drain", () => {
        drainCount += 1;
      });
    });

    const events = await eventsFrom(await fetch(url, { method: "POST" }));
    expect(events.map((event) => event.type)).toEqual([
      "response.started",
      "content.delta",
      "response.completed",
    ]);
    expect(drainCount).toBeGreaterThan(0);
    expect(drainsBeforeSecondPull).toBeGreaterThan(0);
    expect(bufferedBytesBeforeSecondPull).toBeLessThanOrEqual(response?.writableHighWaterMark ?? 0);
    expect(gatewayPulls).toBe(2);
    expect(memory.state.status).toBe("completed");
  });

  it("detaches a stalled maximum-line socket at the backpressure timeout without aborting the provider", async () => {
    const allowDelta = Promise.withResolvers<void>();
    const allowCompletion = Promise.withResolvers<void>();
    const maximumLineText = "x".repeat(65_501);
    expect(
      Buffer.byteLength(
        `${JSON.stringify({ text: maximumLineText, type: "content.delta" })}\n`,
        "utf8",
      ),
    ).toBe(generationTuning.maximumNdjsonLineBytes);
    let gatewayPulls = 0;
    let gatewaySignal: AbortSignal | undefined;
    let rawResponse: FastifyReply["raw"] | undefined;
    const gateway: ModelGateway = {
      async *stream(_request, signal) {
        gatewaySignal = signal;
        gatewayPulls += 1;
        await allowDelta.promise;
        yield { text: maximumLineText, type: "content.delta" };
        gatewayPulls += 1;
        await allowCompletion.promise;
        yield {
          reason: "stop",
          type: "response.completed",
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    };
    const memory = memoryGenerationService();
    const url = await streamUrl(gateway, memory, new ActiveStreamRegistry(), (reply) => {
      rawResponse = reply.raw;
    });
    const response = await fetch(url, { method: "POST" });
    const reader = response.body?.getReader();
    if (reader === undefined || rawResponse === undefined) {
      throw new Error("Real HTTP stream did not expose both endpoints");
    }
    const firstChunk = await reader.read();
    expect(new TextDecoder().decode(firstChunk.value)).toContain("response.started");
    expect(gatewayPulls).toBe(1);
    expect(rawResponse.socket?.destroyed).toBe(false);

    rawResponse.cork();
    vi.useFakeTimers();
    try {
      allowDelta.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(rawResponse.writableNeedDrain).toBe(true);
      const stalledBytes = rawResponse.writableLength;
      expect(stalledBytes).toBeGreaterThan(0);
      expect(stalledBytes).toBeLessThanOrEqual(generationTuning.maximumNdjsonLineBytes);

      await vi.advanceTimersByTimeAsync(generationTuning.backpressureTimeoutMilliseconds - 1);
      expect(gatewayPulls).toBe(1);
      expect(gatewaySignal?.aborted).toBe(false);
      expect(memory.state.status).toBe("active");
      expect(rawResponse.destroyed).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      for (let attempt = 0; attempt < 100 && gatewayPulls < 2; attempt += 1) {
        await Promise.resolve();
      }
    } finally {
      vi.useRealTimers();
    }

    // The stalled reader is disconnected explicitly while the provider keeps producing.
    expect(rawResponse.destroyed).toBe(true);
    expect(gatewayPulls).toBe(2);
    expect(gatewaySignal?.aborted).toBe(false);
    expect(memory.state.status).toBe("active");
    await reader.read().catch(() => undefined);

    allowCompletion.resolve();
    await waitForState(memory, "completed");
    expect(memory.content).toBe(maximumLineText);
    expect(memory.state).toMatchObject({ reason: "stop", status: "completed" });
  });

  it("keeps generating after an unexplained downstream disconnect and completes durably", async () => {
    const allowCompletion = Promise.withResolvers<void>();
    let gatewaySignal: AbortSignal | undefined;
    const gateway: ModelGateway = {
      async *stream(_request, signal) {
        gatewaySignal = signal;
        yield { text: "Durable partial", type: "content.delta" };
        await allowCompletion.promise;
        yield { text: " and the rest", type: "content.delta" };
        yield {
          reason: "stop",
          type: "response.completed",
          usage: { inputTokens: 1, outputTokens: 2 },
        };
      },
    };
    const memory = memoryGenerationService();
    const controller = new AbortController();
    const response = await fetch(await streamUrl(gateway, memory), {
      method: "POST",
      signal: controller.signal,
    });
    const reader = response.body?.getReader();
    if (reader === undefined) {
      throw new Error("Streaming response did not expose a reader");
    }
    const decoder = new TextDecoder();
    let received = "";
    while (!received.includes("content.delta")) {
      const chunk = await reader.read();
      if (chunk.done) {
        throw new Error("Stream ended before the partial delta");
      }
      received += decoder.decode(chunk.value, { stream: true });
    }
    controller.abort();
    await reader.read().catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(gatewaySignal?.aborted).toBe(false);
    expect(memory.state.status).toBe("active");

    allowCompletion.resolve();
    await waitForState(memory, "completed");
    expect(memory.content).toBe("Durable partial and the rest");
    expect(memory.state).toMatchObject({ errorCode: null, reason: "stop", status: "completed" });
  });

  it("suppresses the next delta after the bounded fence observes cross-replica cancellation", async () => {
    const memory = memoryGenerationService();
    let gatewaySignal: AbortSignal | undefined;
    const gateway: ModelGateway = {
      async *stream(_request, signal) {
        gatewaySignal = signal;
        yield { text: "First", type: "content.delta" };
        memory.state = {
          ...memory.state,
          errorCode: null,
          reason: "cancelled",
          revision: 2,
          status: "cancelled",
        };
        await new Promise((resolve) =>
          setTimeout(resolve, generationTuning.durableStatePollMilliseconds + 20),
        );
        yield { text: "Must not forward", type: "content.delta" };
      },
    };
    const events = await eventsFrom(
      await fetch(await streamUrl(gateway, memory), { method: "POST" }),
    );
    expect(events.map((event) => event.type)).toEqual([
      "response.started",
      "content.delta",
      "response.cancelled",
    ]);
    expect(events).not.toContainEqual(expect.objectContaining({ text: "Must not forward" }));
    expect(gatewaySignal?.aborted).toBe(true);
  });

  it("bounds durable reads by polling time instead of rapid provider event count", async () => {
    const memory = memoryGenerationService();
    const originalReadState = memory.service.readState.bind(memory.service);
    const readState = vi.fn((generationId: string) => originalReadState(generationId));
    memory.service = { ...memory.service, readState } as GenerationService;
    const gateway: ModelGateway = {
      async *stream() {
        for (let index = 0; index < 500; index += 1) {
          yield { text: "x", type: "content.delta" };
        }
        yield {
          reason: "stop",
          type: "response.completed",
          usage: { inputTokens: 20, outputTokens: 500 },
        };
      },
    };

    const startedAt = performance.now();
    const events = await eventsFrom(
      await fetch(await streamUrl(gateway, memory, undefined, undefined, routedStarted), {
        method: "POST",
      }),
    );
    const elapsedMilliseconds = performance.now() - startedAt;
    const maximumReads =
      Math.ceil(elapsedMilliseconds / generationTuning.durableStatePollMilliseconds) + 2;

    expect(events.filter((event) => event.type === "content.delta")).toHaveLength(500);
    expect(events.at(-1)).toMatchObject({ reason: "stop", type: "response.completed" });
    expect(readState.mock.calls.length).toBeLessThanOrEqual(maximumReads);
    expect(readState.mock.calls.length).toBeLessThan(500);
  });

  it("persists metadata that arrives after cancellation when usage lookup is unavailable", async () => {
    const memory = memoryGenerationService();
    const lookedUpGenerationIds: string[] = [];
    const metadata = {
      provider: "synthetic-provider",
      providerGenerationId: "provider-generation-late",
      resolvedModel: "synthetic/resolved-model",
    } as const;
    const gateway: ModelGateway & GenerationAccountingGateway = {
      async lookupUsage(providerGenerationId) {
        lookedUpGenerationIds.push(providerGenerationId);
        return { status: "unavailable" };
      },
      async *stream() {
        memory.state = {
          ...memory.state,
          errorCode: null,
          reason: "cancelled",
          revision: 2,
          status: "cancelled",
        };
        yield { metadata, type: "generation.metadata" };
      },
    };

    const events = await eventsFrom(
      await fetch(await streamUrl(gateway, memory), { method: "POST" }),
    );

    expect(events.map((event) => event.type)).toEqual(["response.started", "response.cancelled"]);
    expect(memory.providerMetadata).toEqual([metadata]);
    expect(lookedUpGenerationIds).toEqual([metadata.providerGenerationId]);
    expect(memory.state).toMatchObject({ reason: "cancelled", status: "cancelled" });
  });

  it("settles a completed provider event that arrives after durable cancellation exactly once", async () => {
    const memory = memoryGenerationService();
    const accounting = {
      costUsd: "0.000321",
      metadata: {
        provider: "synthetic-provider",
        providerGenerationId: "provider-generation-after-cancel",
        resolvedModel: "synthetic/resolved-model",
      },
    } as const;
    const settleAccounting = vi.fn(async () => true);
    memory.service = { ...memory.service, settleAccounting } as GenerationService;
    const gateway: ModelGateway = {
      async *stream() {
        yield { text: "Respuesta parcial", type: "content.delta" };
        memory.state = {
          ...memory.state,
          errorCode: null,
          reason: "cancelled",
          revision: 2,
          status: "cancelled",
        };
        yield {
          accounting,
          reason: "stop",
          type: "response.completed",
          usage: { inputTokens: 8, outputTokens: 5 },
        };
      },
    };

    const events = await eventsFrom(
      await fetch(await streamUrl(gateway, memory, undefined, undefined, routedStarted), {
        method: "POST",
      }),
    );

    expect(events.map((event) => event.type)).toEqual([
      "response.started",
      "content.delta",
      "response.cancelled",
    ]);
    expect(settleAccounting).toHaveBeenCalledOnce();
    expect(settleAccounting).toHaveBeenCalledWith(
      started.generationId,
      { inputTokens: 8, outputTokens: 5 },
      accounting,
    );
  });

  it("memoizes one unavailable coordinator lookup for a typed provider outcome", async () => {
    const memory = memoryGenerationService();
    const lookedUpGenerationIds: string[] = [];
    const metadata = { providerGenerationId: "provider-refusal-unavailable" } as const;
    const gateway: ModelGateway & GenerationAccountingGateway = {
      async lookupUsage(providerGenerationId) {
        lookedUpGenerationIds.push(providerGenerationId);
        return { status: "unavailable" };
      },
      async *stream() {
        yield { metadata, type: "generation.metadata" };
        yield {
          accounting: { metadata, spendRisk: "unknown" },
          errorCode: "GENERATION_FAILED",
          providerOutcome: "refusal",
          type: "response.failed",
        };
      },
    };

    const events = await eventsFrom(
      await fetch(await streamUrl(gateway, memory, undefined, undefined, routedStarted), {
        method: "POST",
      }),
    );

    expect(lookedUpGenerationIds).toEqual([metadata.providerGenerationId]);
    expect(events.at(-1)).toMatchObject({
      errorCode: "GENERATION_FAILED",
      type: "response.failed",
    });
    expect(memory.state.status).toBe("failed");
  });

  it("does not retry a usage lookup already exhausted by the provider adapter", async () => {
    const memory = memoryGenerationService();
    const lookupUsage = vi.fn(async () => ({ status: "unavailable" as const }));
    const metadata = { providerGenerationId: "provider-adapter-exhausted" } as const;
    const gateway: ModelGateway & GenerationAccountingGateway = {
      lookupUsage,
      async *stream() {
        yield { metadata, type: "generation.metadata" };
        yield {
          accounting: { metadata, spendRisk: "unknown" },
          errorCode: "GENERATION_FAILED",
          providerOutcome: "content_filter",
          type: "response.failed",
          usageLookupAttempted: true,
        };
      },
    };

    const events = await eventsFrom(
      await fetch(await streamUrl(gateway, memory, undefined, undefined, routedStarted), {
        method: "POST",
      }),
    );

    expect(lookupUsage).not.toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({
      errorCode: "GENERATION_FAILED",
      type: "response.failed",
    });
    expect(memory.state.status).toBe("failed");
  });

  it("polls durable state and aborts a stalled routed gateway after remote cancellation", async () => {
    const memory = memoryGenerationService();
    const originalReadState = memory.service.readState.bind(memory.service);
    let stateReads = 0;
    memory.service = {
      ...memory.service,
      readState: async (generationId: string) => {
        stateReads += 1;
        return originalReadState(generationId);
      },
    } as GenerationService;
    let gatewaySignal: AbortSignal | undefined;
    const gateway: ModelGateway = {
      async *stream(_request, signal) {
        gatewaySignal = signal;
        await new Promise<void>((_resolve, reject) => {
          const aborted = (): void => reject(new DOMException("aborted", "AbortError"));
          if (signal.aborted) {
            aborted();
            return;
          }
          signal.addEventListener("abort", aborted, { once: true });
        });
      },
    };
    const response = await fetch(
      await streamUrl(gateway, memory, new ActiveStreamRegistry(), undefined, routedStarted),
      { method: "POST" },
    );
    for (let attempt = 0; attempt < 100 && stateReads === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(stateReads).toBeGreaterThan(0);
    memory.state = {
      ...memory.state,
      errorCode: null,
      reason: "cancelled",
      revision: 2,
      status: "cancelled",
    };

    const events = await eventsFrom(response);

    expect(stateReads).toBeGreaterThanOrEqual(2);
    expect(gatewaySignal?.aborted).toBe(true);
    expect(events.map((event) => event.type)).toEqual(["response.started", "response.cancelled"]);
  });

  it("emits a durable remote failure while a routed gateway is stalled", async () => {
    const memory = memoryGenerationService();
    let stateReads = 0;
    const originalReadState = memory.service.readState.bind(memory.service);
    memory.service = {
      ...memory.service,
      readState: async (generationId: string) => {
        stateReads += 1;
        return originalReadState(generationId);
      },
    } as GenerationService;
    const gateway: ModelGateway = {
      async *stream(_request, signal) {
        await new Promise<void>((_resolve, reject) => {
          const aborted = (): void => reject(new DOMException("aborted", "AbortError"));
          if (signal.aborted) {
            aborted();
            return;
          }
          signal.addEventListener("abort", aborted, { once: true });
        });
      },
    };
    const response = await fetch(
      await streamUrl(gateway, memory, new ActiveStreamRegistry(), undefined, routedStarted),
      { method: "POST" },
    );
    for (let attempt = 0; attempt < 100 && stateReads === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    memory.state = {
      ...memory.state,
      errorCode: "GENERATION_FAILED",
      reason: "error",
      revision: 2,
      status: "failed",
    };

    const events = await eventsFrom(response);

    expect(events).toEqual([
      expect.objectContaining({ type: "response.started" }),
      expect.objectContaining({
        errorCode: "GENERATION_FAILED",
        partial: false,
        revision: 2,
        type: "response.failed",
      }),
    ]);
  });

  it("fences local cancellation and enqueues its backpressured terminal exactly once", async () => {
    const memory = memoryGenerationService();
    const registry = new ActiveStreamRegistry();
    let cancellationWrites = 0;
    let gatewaySignal: AbortSignal | undefined;
    const modelCall = {
      cancelRequested: vi.fn(),
      firstToken: vi.fn(),
      requestSent: vi.fn(),
      responseStarted: vi.fn(),
      settle: vi.fn(),
    };
    const telemetry = {
      changeActiveEmployeeStreams: vi.fn(),
      changeActiveProviderCalls: vi.fn(),
      recordContextDecision: vi.fn(),
      recordGeneration: vi.fn(),
      recordResponseStarted: vi.fn(),
      startModelCall: vi.fn(() => modelCall),
    } satisfies ResponseStreamTelemetry;
    const gateway: ModelGateway = {
      async *stream(_request, signal) {
        gatewaySignal = signal;
        yield { text: "Visible partial", type: "content.delta" };
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        });
      },
    };
    const url = await streamUrl(
      gateway,
      memory,
      registry,
      (reply) => {
        const originalWrite = reply.raw.write.bind(reply.raw);
        reply.raw.write = ((chunk: string | Uint8Array, encoding?: BufferEncoding) => {
          const accepted =
            encoding === undefined ? originalWrite(chunk) : originalWrite(chunk, encoding);
          if (typeof chunk === "string" && chunk.includes('"type":"response.cancelled"')) {
            cancellationWrites += 1;
            return false;
          }
          return accepted;
        }) as typeof reply.raw.write;
      },
      started,
      undefined,
      telemetry,
    );
    const response = await fetch(url, { method: "POST" });
    const reader = response.body?.getReader();
    if (reader === undefined) {
      throw new Error("Streaming response did not expose a reader");
    }
    const decoder = new TextDecoder();
    let received = "";
    while (!received.includes("Visible partial")) {
      const chunk = await reader.read();
      if (chunk.done) {
        throw new Error("Stream ended before the visible partial");
      }
      received += decoder.decode(chunk.value, { stream: true });
    }
    expect(memory.content).toBe("");

    const capture = registry.captureCancellation(started.generationId);
    if (capture === undefined) {
      throw new Error("Local stream did not expose its cancellation snapshot");
    }
    expect(capture.snapshot.content).toBe("Visible partial");
    expect(capture.snapshot.firstTokenAt).not.toBeNull();
    memory.content = capture.snapshot.content;
    memory.firstTokenAt = capture.snapshot.firstTokenAt;
    memory.state = {
      ...memory.state,
      errorCode: null,
      reason: "cancelled",
      revision: 2,
      status: "cancelled",
    };
    capture.commit();

    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        received += decoder.decode();
        break;
      }
      received += decoder.decode(chunk.value, { stream: true });
    }
    const events = received
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events.map((event) => event.type)).toEqual([
      "response.started",
      "content.delta",
      "response.cancelled",
    ]);
    expect(memory.content).toBe("Visible partial");
    expect(memory.firstTokenAt).not.toBeNull();
    expect(gatewaySignal?.aborted).toBe(true);
    expect(cancellationWrites).toBe(1);
    expect(modelCall.cancelRequested).toHaveBeenCalledOnce();
    expect(modelCall.settle).toHaveBeenCalledOnce();
    expect(modelCall.settle).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "cancelled" }),
    );
    expect(telemetry.changeActiveProviderCalls.mock.calls).toEqual([
      ["chat", 1],
      ["chat", -1],
    ]);
  });

  it("keeps a cancellation that commits while shutdown releases its local fence", async () => {
    const { events, memory } = await shutdownDuringCancellation("commit");

    expect(events.map((event) => event.type)).toEqual([
      "response.started",
      "content.delta",
      "response.cancelled",
    ]);
    expect(events).not.toContainEqual(expect.objectContaining({ text: "Must not forward" }));
    expect(memory.content).toBe("Visible partial");
    expect(memory.state).toMatchObject({ reason: "cancelled", status: "cancelled" });
  });

  it("records STREAM_INTERRUPTED when cancellation rolls back during shutdown", async () => {
    const { events, memory } = await shutdownDuringCancellation("rollback");

    expect(events.map((event) => event.type)).toEqual(["response.started", "content.delta"]);
    expect(events).not.toContainEqual(expect.objectContaining({ text: "Must not forward" }));
    expect(memory.content).toBe("Visible partial");
    expect(memory.state).toMatchObject({
      errorCode: "STREAM_INTERRUPTED",
      reason: "error",
      status: "incomplete",
    });
  });
});

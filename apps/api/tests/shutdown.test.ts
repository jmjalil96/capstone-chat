import { describe, expect, it, vi } from "vitest";
import { createApplication } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import type { DatabasePool } from "../src/database/pool.js";
import { ActiveStreamRegistry } from "../src/generations/active-streams.js";
import type { ModelGateway } from "../src/generations/model-gateway.js";
import { systemPrompt } from "../src/generations/prompt.js";
import type {
  DurableGenerationState,
  GenerationService,
  StartedResponse,
} from "../src/generations/service.js";
import { generationTuning } from "../src/generations/settings.js";
import type { CostControlMaintenance } from "../src/model-policy/maintenance.js";

const completingResponse: StartedResponse = {
  conversationId: "00000000-0000-4000-8000-000000000011",
  generationId: "00000000-0000-4000-8000-000000000012",
  messageId: "00000000-0000-4000-8000-000000000013",
  request: {
    history: [],
    message: { role: "user", text: "complete-during-drain" },
    modelTier: "balanced",
    purpose: "chat",
    systemPrompt,
  },
  revision: 1,
  userMessageId: "00000000-0000-4000-8000-000000000014",
};

const stalledResponse: StartedResponse = {
  conversationId: "00000000-0000-4000-8000-000000000021",
  generationId: "00000000-0000-4000-8000-000000000022",
  messageId: "00000000-0000-4000-8000-000000000023",
  request: {
    history: [],
    message: { role: "user", text: "stall-until-shutdown" },
    modelTier: "balanced",
    purpose: "chat",
    systemPrompt,
  },
  revision: 1,
  userMessageId: "00000000-0000-4000-8000-000000000024",
};

interface MutableGeneration {
  content: string;
  firstTokenAt: Date | null;
  state: DurableGenerationState;
}

async function streamEvents(response: Response): Promise<readonly Record<string, unknown>[]> {
  return (await response.text())
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("graceful shutdown", () => {
  it("stops HTTP and closes the database pool once", async () => {
    let maintenanceStopped = false;
    const maintenance: CostControlMaintenance = {
      runOnce: vi.fn(async () => ({ catalogRefresh: null, reconciliation: null })),
      start: vi.fn(),
      stop: vi.fn(async () => {
        maintenanceStopped = true;
      }),
    };
    const end = vi.fn(async () => {
      expect(maintenanceStopped).toBe(true);
    });
    const pool: DatabasePool = {
      end,
      query: vi.fn(async () => ({ rows: [{ result: 1 }] })),
    };
    const application = createApplication(loadConfig({ NODE_ENV: "test" }), {
      maintenance,
      pool,
    });

    await application.server.listen({ host: "127.0.0.1", port: 0 });
    await application.lifecycle.initialize();
    expect(application.server.server.listening).toBe(true);

    await Promise.all([application.shutdown(), application.shutdown()]);

    expect(application.server.server.listening).toBe(false);
    expect(application.lifecycle.phase).toBe("stopped");
    expect(maintenance.stop).toHaveBeenCalledTimes(1);
    expect(maintenanceStopped).toBe(true);
    expect(end).toHaveBeenCalledTimes(1);
  });

  it("drains one HTTP stream and interrupts another before closing its database pool", async () => {
    const completeDuringDrain = Promise.withResolvers<void>();
    const completingGatewayEntered = Promise.withResolvers<void>();
    const completingTerminalized = Promise.withResolvers<void>();
    const stalledGatewayBlocked = Promise.withResolvers<void>();
    const visiblePartial = "Respuesta parcial visible. ".repeat(48);
    let stalledSignal: AbortSignal | undefined;
    const memory = new Map<string, MutableGeneration>([
      [
        completingResponse.generationId,
        {
          content: "",
          firstTokenAt: null,
          state: {
            assistantMessageId: completingResponse.messageId,
            conversationId: completingResponse.conversationId,
            errorCode: null,
            reason: null,
            revision: completingResponse.revision,
            status: "active",
          },
        },
      ],
      [
        stalledResponse.generationId,
        {
          content: "",
          firstTokenAt: null,
          state: {
            assistantMessageId: stalledResponse.messageId,
            conversationId: stalledResponse.conversationId,
            errorCode: null,
            reason: null,
            revision: stalledResponse.revision,
            status: "active",
          },
        },
      ],
    ]);
    const requiredGeneration = (generationId: string): MutableGeneration => {
      const generation = memory.get(generationId);
      if (generation === undefined) {
        throw new Error("Unknown synthetic shutdown generation");
      }
      return generation;
    };
    const generations = {
      checkpoint: async (generationId: string, content: string, firstTokenAt: Date | null) => {
        const generation = requiredGeneration(generationId);
        if (generation.state.status !== "active") {
          return false;
        }
        generation.content = content;
        generation.firstTokenAt ??= firstTokenAt;
        return true;
      },
      readState: async (generationId: string) => ({
        ...requiredGeneration(generationId).state,
      }),
      terminalize: async (
        generationId: string,
        input: Parameters<GenerationService["terminalize"]>[1],
      ) => {
        const generation = requiredGeneration(generationId);
        if (generation.state.status !== "active") {
          return { ...generation.state, won: false };
        }
        generation.content = input.content;
        generation.firstTokenAt ??= input.firstTokenAt;
        generation.state = {
          assistantMessageId: generation.state.assistantMessageId,
          conversationId: generation.state.conversationId,
          errorCode: input.errorCode,
          reason: input.reason,
          revision: (generation.state.revision ?? 0) + 1,
          status: input.status,
        };
        if (generationId === completingResponse.generationId) {
          completingTerminalized.resolve();
        }
        return { ...generation.state, won: true };
      },
    } as unknown as GenerationService;
    const gateway: ModelGateway = {
      async *stream(request, signal) {
        if (request.message.text === completingResponse.request.message.text) {
          completingGatewayEntered.resolve();
          await completeDuringDrain.promise;
          signal.throwIfAborted();
          yield { text: "Respuesta completada durante el drenaje.", type: "content.delta" };
          yield {
            reason: "stop",
            type: "response.completed",
            usage: { inputTokens: 4, outputTokens: 5 },
          };
          return;
        }

        stalledSignal = signal;
        yield { text: visiblePartial, type: "content.delta" };
        stalledGatewayBlocked.resolve();
        signal.throwIfAborted();
        await new Promise<never>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new DOMException("Synthetic stalled stream aborted", "AbortError")),
            { once: true },
          );
        });
      },
    };
    const streamRegistry = new ActiveStreamRegistry();
    const end = vi.fn(async () => {
      expect(streamRegistry.size).toBe(0);
      expect(requiredGeneration(completingResponse.generationId).state.status).toBe("completed");
      expect(requiredGeneration(stalledResponse.generationId).state).toMatchObject({
        errorCode: "STREAM_INTERRUPTED",
        reason: "error",
        status: "incomplete",
      });
    });
    const pool: DatabasePool = {
      end,
      query: vi.fn(async () => ({ rows: [{ result: 1 }] })),
    };
    const application = createApplication(loadConfig({ NODE_ENV: "test" }), {
      generations,
      modelGateway: gateway,
      pool,
      streamRegistry,
    });
    application.server.get("/test/shutdown-stream/:kind", async (request, reply) => {
      const { kind } = request.params as { readonly kind: string };
      await application.responseStreams.stream(
        kind === "completing" ? completingResponse : stalledResponse,
        request,
        reply,
      );
    });
    await application.server.listen({ host: "127.0.0.1", port: 0 });
    await application.lifecycle.initialize();
    const address = application.server.server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Synthetic shutdown listener did not expose a port");
    }
    const baseUrl = `http://127.0.0.1:${address.port}/test/shutdown-stream`;
    const [completingHttpResponse, stalledHttpResponse] = await Promise.all([
      fetch(`${baseUrl}/completing`, { headers: { connection: "close" } }),
      fetch(`${baseUrl}/stalled`, { headers: { connection: "close" } }),
    ]);
    expect(completingHttpResponse.ok).toBe(true);
    expect(stalledHttpResponse.ok).toBe(true);
    await Promise.all([completingGatewayEntered.promise, stalledGatewayBlocked.promise]);
    expect(streamRegistry.size).toBe(2);
    const completingEventsPromise = streamEvents(completingHttpResponse);
    const stalledEventsPromise = streamEvents(stalledHttpResponse);

    vi.useFakeTimers();
    let shutdown: Promise<void>;
    try {
      shutdown = application.shutdown();
      expect(streamRegistry.isAccepting).toBe(false);
      completeDuringDrain.resolve();
      await completingTerminalized.promise;
      const completingEvents = await completingEventsPromise;
      expect(completingEvents.map((event) => event.type)).toEqual([
        "response.started",
        "content.delta",
        "response.completed",
      ]);
      expect(streamRegistry.size).toBe(1);

      await vi.advanceTimersByTimeAsync(generationTuning.gracefulDrainMilliseconds);
      expect(streamRegistry.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
    await shutdown;
    const stalledEvents = await stalledEventsPromise;
    expect(stalledEvents.map((event) => event.type)).toEqual(["response.started", "content.delta"]);

    const interrupted = requiredGeneration(stalledResponse.generationId);
    expect(stalledSignal?.aborted).toBe(true);
    expect(stalledSignal?.reason).toBe("shutdown");
    expect(interrupted.content).toBe(visiblePartial);
    expect(interrupted.firstTokenAt).toBeInstanceOf(Date);
    expect(interrupted.state).toMatchObject({
      errorCode: "STREAM_INTERRUPTED",
      reason: "error",
      revision: 2,
      status: "incomplete",
    });
    expect(end).toHaveBeenCalledOnce();
  });
});

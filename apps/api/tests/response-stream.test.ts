import Fastify, { type FastifyReply } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActiveStreamRegistry } from "../src/generations/active-streams.js";
import { FakeModelGateway } from "../src/generations/fake-model-gateway.js";
import type { ModelGateway } from "../src/generations/model-gateway.js";
import { systemPrompt } from "../src/generations/prompt.js";
import { createResponseStreamCoordinator } from "../src/generations/response-stream.js";
import type {
  DurableGenerationState,
  GenerationService,
  StartedResponse,
} from "../src/generations/service.js";
import { generationTuning } from "../src/generations/settings.js";

const started: StartedResponse = {
  conversationId: "00000000-0000-4000-8000-000000000001",
  generationId: "00000000-0000-4000-8000-000000000002",
  messageId: "00000000-0000-4000-8000-000000000003",
  request: {
    history: [],
    message: { role: "user", text: "Synthetic request" },
    modelTier: "balanced",
    systemPrompt,
  },
  revision: 1,
  userMessageId: "00000000-0000-4000-8000-000000000004",
};

interface MemoryGenerationService {
  service: GenerationService;
  content: string;
  failTerminalPersistence: boolean;
  firstTokenAt: Date | null;
  state: DurableGenerationState;
}

function memoryGenerationService(): MemoryGenerationService {
  const memory: MemoryGenerationService = {
    content: "",
    failTerminalPersistence: false,
    firstTokenAt: null,
    service: undefined as unknown as GenerationService,
    state: {
      assistantMessageId: started.messageId,
      conversationId: started.conversationId,
      errorCode: null,
      reason: null,
      revision: 1,
      status: "active",
    },
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
    readState: async () => ({ ...memory.state }),
    terminalize: async (
      _generationId: string,
      input: Parameters<GenerationService["terminalize"]>[1],
    ) => {
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
): Promise<string> {
  const server = Fastify();
  servers.push(server);
  const coordinator = createResponseStreamCoordinator({
    gateway,
    generations: memory.service,
    registry,
  });
  server.post("/stream", async (request, reply) => {
    prepareReply?.(reply);
    await coordinator.stream(started, request, reply);
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
  const secondStateRead = Promise.withResolvers<void>();
  const originalReadState = memory.service.readState.bind(memory.service);
  let stateReads = 0;
  memory.service = {
    ...memory.service,
    readState: async (generationId: string) => {
      stateReads += 1;
      if (stateReads === 2) {
        secondStateRead.resolve();
      }
      return originalReadState(generationId);
    },
  } as GenerationService;
  const gateway: ModelGateway = {
    async *stream() {
      yield { text: "Visible partial", type: "content.delta" };
      await allowSecondDelta.promise;
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
  await secondStateRead.promise;
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

  it("interrupts a real HTTP stream when maximum-line backpressure never drains", async () => {
    const allowDelta = Promise.withResolvers<void>();
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
      expect(rawResponse.writableLength).toBe(stalledBytes);

      await vi.advanceTimersByTimeAsync(1);
      for (
        let attempt = 0;
        attempt < 100 && (memory.state.status === "active" || gatewaySignal?.aborted !== true);
        attempt += 1
      ) {
        await Promise.resolve();
      }
    } finally {
      vi.useRealTimers();
    }

    expect(gatewayPulls).toBe(1);
    expect(gatewaySignal?.aborted).toBe(true);
    expect(memory.content).toBe(maximumLineText);
    expect(memory.state).toMatchObject({
      errorCode: "STREAM_INTERRUPTED",
      reason: "error",
      status: "incomplete",
    });
    while (!(await reader.read()).done) {
      // Drain the response after the coordinator releases the cork on end.
    }
  });

  it("marks an unexplained downstream disconnect incomplete", async () => {
    const gateway: ModelGateway = {
      async *stream(_request, signal) {
        yield { text: "Durable partial", type: "content.delta" };
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        });
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
    await waitForState(memory, "incomplete");
    expect(memory.state).toMatchObject({ errorCode: "STREAM_INTERRUPTED", reason: "error" });
    expect(memory.content).toBe("Durable partial");
  });

  it("aborts the gateway after observing cross-replica cancellation", async () => {
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

  it("fences local cancellation and enqueues its backpressured terminal exactly once", async () => {
    const memory = memoryGenerationService();
    const registry = new ActiveStreamRegistry();
    let cancellationWrites = 0;
    let gatewaySignal: AbortSignal | undefined;
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
    const url = await streamUrl(gateway, memory, registry, (reply) => {
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
    });
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

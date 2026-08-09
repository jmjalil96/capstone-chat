import { EventEmitter } from "node:events";
import type { FastifyReply } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApplication } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { ActiveStreamRegistry } from "../src/generations/active-streams.js";
import { compactionPrompt } from "../src/generations/compaction-prompt.js";
import { FakeModelGateway } from "../src/generations/fake-model-gateway.js";
import { continueMessage, systemPrompt } from "../src/generations/prompt.js";
import {
  CheckpointScheduler,
  NdjsonWriter,
  splitContentDelta,
} from "../src/generations/response-stream.js";
import type { GenerationService } from "../src/generations/service.js";
import { generationTuning } from "../src/generations/settings.js";
import { createApplicationTelemetry } from "../src/observability/telemetry.js";
import { OpenRouterGateway } from "../src/openrouter/openrouter-gateway.js";

describe("Phase 4 generation configuration", () => {
  it("locks the approved operational values and versioned backend copy", () => {
    expect(generationTuning).toEqual({
      backpressureTimeoutMilliseconds: 5_000,
      checkpointBytes: 1_024,
      checkpointMilliseconds: 250,
      durableStatePollMilliseconds: 250,
      fakeChunkDelayMilliseconds: 400,
      gracefulDrainMilliseconds: 4 * 60 * 1_000,
      maximumAssistantBytes: 1_048_576,
      maximumContextBytes: 1_048_576,
      maximumNdjsonLineBytes: 65_536,
      messageBytes: 32_768,
      requestBodyBytes: 69_632,
    });
    expect(systemPrompt).toEqual({
      text: [
        "You are Capstone Chat, an AI assistant for Capstone employees.",
        "Be helpful, accurate, and direct.",
        "Follow the employee's requested format and use Markdown when useful.",
        "Clearly distinguish known facts from uncertainty.",
        "Respond in the language of the employee's latest request unless they request another language.",
        "Use only the conversation content provided. Do not claim access to company systems, documents, or current information you have not received, and do not invent company knowledge.",
      ].join("\n"),
      version: "capstone-chat-v1",
    });
    expect(continueMessage).toEqual({
      text: "Continúa desde donde te detuviste, manteniendo el idioma y el formato de la respuesta anterior.",
      version: "capstone-continue-v1",
    });
  });

  it("selects OpenRouter and prohibits an injected local fake gateway in production", async () => {
    const production = Object.freeze({
      ...loadConfig({
        BETTER_AUTH_SECRET: "production-auth-secret-longer-than-thirty-two-characters",
        DATABASE_URL: "postgresql://capstone:capstone@example.invalid/capstone",
        EMAIL_DELIVERY: "resend",
        EMAIL_FROM: "Capstone Chat <no-reply@mail.capstone.com.ec>",
        MODEL_GATEWAY: "openrouter",
        NODE_ENV: "production",
        OPENROUTER_API_KEY: "test-openrouter-key-never-sent",
        OTEL_EXPORTER_OTLP_ENDPOINT: "https://otlp.nr-data.net",
        OTEL_EXPORTER_OTLP_HEADERS: "api-key=test-license-key-never-sent",
        PUBLIC_ORIGIN: "https://chat.capstone.com.ec",
        RENDER_GIT_COMMIT: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        RESEND_API_KEY: "test-resend-key-never-sent",
      }),
      webAssetsDirectory: null,
    });
    const telemetry = createApplicationTelemetry({
      endpoint: null,
      environment: "test",
      headers: {},
      release: "test",
    });
    const application = createApplication(production, { telemetry });
    expect(application.modelGateway).toBeInstanceOf(OpenRouterGateway);
    await application.shutdown();
    expect(() =>
      createApplication(production, { modelGateway: new FakeModelGateway(), telemetry }),
    ).toThrow("FakeModelGateway is prohibited");
  });
});

describe("NDJSON delta framing", () => {
  it("splits escaped and multi-byte text without exceeding one approved line", () => {
    const source = `${'"\\\n'.repeat(30_000)}${"🧭".repeat(20_000)}`;
    const chunks = splitContentDelta(source);
    expect(chunks.join("")).toBe(source);
    expect(chunks.length).toBeGreaterThan(1);
    for (const text of chunks) {
      expect(
        Buffer.byteLength(`${JSON.stringify({ text, type: "content.delta" })}\n`, "utf8"),
      ).toBeLessThanOrEqual(65_536);
    }
  });
});

class BackpressuredResponse extends EventEmitter {
  destroyed = false;
  writableEnded = false;
  readonly write = vi.fn(() => false);
}

function backpressuredWriter(raw: BackpressuredResponse): NdjsonWriter {
  return new NdjsonWriter(
    { raw } as unknown as FastifyReply,
    new AbortController().signal,
    new AbortController().signal,
  );
}

describe("NDJSON backpressure", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits for drain after the downstream buffer fills", async () => {
    const raw = new BackpressuredResponse();
    const writing = backpressuredWriter(raw).write({ text: "bounded", type: "content.delta" });
    await Promise.resolve();
    raw.emit("drain");
    await expect(writing).resolves.toBeUndefined();
    expect(raw.write).toHaveBeenCalledOnce();
  });

  it("fails a stalled downstream write at the locked timeout", async () => {
    vi.useFakeTimers();
    const raw = new BackpressuredResponse();
    const writing = backpressuredWriter(raw).write({ text: "stalled", type: "content.delta" });
    const rejection = expect(writing).rejects.toThrow("backpressure timed out");
    await vi.advanceTimersByTimeAsync(4_999);
    expect(raw.listenerCount("drain")).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await rejection;
    expect(raw.listenerCount("drain")).toBe(0);
  });
});

describe("CheckpointScheduler", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("checkpoints one small delta after the elapsed-time threshold", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-07T12:00:00.000Z"));
    const checkpoint = vi.fn(async () => true);
    const scheduler = new CheckpointScheduler(
      { checkpoint } as unknown as GenerationService,
      "00000000-0000-4000-8000-000000000001",
      Date.now(),
    );
    const firstTokenAt = new Date();
    scheduler.observe("small", 5, firstTokenAt, Date.now());
    expect(checkpoint).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(249);
    expect(checkpoint).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(checkpoint).toHaveBeenCalledOnce();
    expect(checkpoint).toHaveBeenCalledWith(
      "00000000-0000-4000-8000-000000000001",
      "small",
      firstTokenAt,
    );
    await scheduler.settle();
  });

  it("coalesces byte-eligible observations behind one in-flight checkpoint", async () => {
    let releaseFirstCheckpoint: (() => void) | undefined;
    const firstCheckpointGate = new Promise<void>((resolve) => {
      releaseFirstCheckpoint = resolve;
    });
    let observeFollowUp: (() => void) | undefined;
    const followUpStarted = new Promise<void>((resolve) => {
      observeFollowUp = resolve;
    });
    let invocation = 0;
    const checkpoint = vi.fn(async () => {
      invocation += 1;
      if (invocation === 1) {
        await firstCheckpointGate;
      } else {
        observeFollowUp?.();
      }
      return true;
    });
    const generationId = "00000000-0000-4000-8000-000000000001";
    const firstTokenAt = new Date("2026-08-07T12:00:00.000Z");
    const scheduler = new CheckpointScheduler(
      { checkpoint } as unknown as GenerationService,
      generationId,
      firstTokenAt.getTime(),
    );
    const thresholdContent = "a".repeat(1_024);

    scheduler.observe("a".repeat(1_023), 1_023, firstTokenAt, firstTokenAt.getTime());
    expect(checkpoint).not.toHaveBeenCalled();
    scheduler.observe(thresholdContent, 1_024, firstTokenAt, firstTokenAt.getTime());
    expect(checkpoint).toHaveBeenCalledOnce();
    expect(checkpoint).toHaveBeenCalledWith(generationId, thresholdContent, firstTokenAt);

    scheduler.observe("b".repeat(2_048), 2_048, firstTokenAt, firstTokenAt.getTime());
    scheduler.observe("c".repeat(3_072), 3_072, firstTokenAt, firstTokenAt.getTime());
    const latestContent = "d".repeat(4_096);
    scheduler.observe(latestContent, 4_096, firstTokenAt, firstTokenAt.getTime());
    expect(checkpoint).toHaveBeenCalledOnce();

    releaseFirstCheckpoint?.();
    await followUpStarted;
    await scheduler.settle();

    expect(checkpoint).toHaveBeenCalledTimes(2);
    expect(checkpoint).toHaveBeenLastCalledWith(generationId, latestContent, firstTokenAt);
  });

  it("keeps sub-threshold content behind a successful checkpoint on the elapsed schedule", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-07T12:00:00.000Z"));
    const firstCheckpoint = Promise.withResolvers<boolean>();
    let invocation = 0;
    const checkpoint = vi.fn(() => {
      invocation += 1;
      return invocation === 1 ? firstCheckpoint.promise : Promise.resolve(true);
    });
    const generationId = "00000000-0000-4000-8000-000000000001";
    const firstTokenAt = new Date();
    const scheduler = new CheckpointScheduler(
      { checkpoint } as unknown as GenerationService,
      generationId,
      Date.now(),
    );

    scheduler.observe("a".repeat(1_024), 1_024, firstTokenAt, Date.now());
    scheduler.observe("b".repeat(1_025), 1_025, firstTokenAt, Date.now());
    expect(checkpoint).toHaveBeenCalledOnce();

    firstCheckpoint.resolve(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(checkpoint).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(249);
    expect(checkpoint).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(checkpoint).toHaveBeenCalledTimes(2);
    expect(checkpoint).toHaveBeenLastCalledWith(generationId, "b".repeat(1_025), firstTokenAt);
    await scheduler.settle();
  });

  it("keeps a failed checkpoint eligible for a later observation without retrying on its own", async () => {
    const firstAttemptFinished = Promise.withResolvers<void>();
    let invocation = 0;
    const checkpoint = vi.fn(async () => {
      invocation += 1;
      if (invocation === 1) {
        firstAttemptFinished.resolve();
        throw new Error("Synthetic checkpoint failure");
      }
      return true;
    });
    const generationId = "00000000-0000-4000-8000-000000000001";
    const firstTokenAt = new Date("2026-08-07T12:00:00.000Z");
    const scheduler = new CheckpointScheduler(
      { checkpoint } as unknown as GenerationService,
      generationId,
      firstTokenAt.getTime(),
    );

    scheduler.observe("a".repeat(1_024), 1_024, firstTokenAt, firstTokenAt.getTime());
    await firstAttemptFinished.promise;
    await Promise.resolve();
    await Promise.resolve();
    expect(checkpoint).toHaveBeenCalledOnce();

    scheduler.observe("b".repeat(1_025), 1_025, firstTokenAt, firstTokenAt.getTime() + 1);
    await scheduler.settle();

    expect(checkpoint).toHaveBeenCalledTimes(2);
    expect(checkpoint).toHaveBeenLastCalledWith(generationId, "b".repeat(1_025), firstTokenAt);
  });
});

describe("FakeModelGateway", () => {
  const request = {
    history: [],
    message: { role: "user" as const, text: "Mensaje sintético" },
    modelTier: "balanced" as const,
    purpose: "chat" as const,
    systemPrompt,
  };

  it("emits the exact clearly simulated local response in three chunks", async () => {
    const gateway = new FakeModelGateway([
      { event: { text: "Esta es ", type: "content.delta" } },
      {
        event: {
          text: "una respuesta simulada de Capstone Chat ",
          type: "content.delta",
        },
      },
      { event: { text: "para desarrollo local.", type: "content.delta" } },
      {
        event: {
          reason: "stop",
          type: "response.completed",
          usage: { inputTokens: 1, outputTokens: 2 },
        },
      },
    ]);
    const events = [];
    for await (const event of gateway.stream(request, new AbortController().signal)) {
      events.push(event);
    }
    expect(
      events.flatMap((event) => (event.type === "content.delta" ? [event.text] : [])).join(""),
    ).toBe("Esta es una respuesta simulada de Capstone Chat para desarrollo local.");
    expect(events.at(-1)).toMatchObject({ reason: "stop", type: "response.completed" });
  });

  it("honors cancellation during a delayed step", async () => {
    const gateway = new FakeModelGateway([
      { delayMilliseconds: 10_000, event: { text: "late", type: "content.delta" } },
    ]);
    const controller = new AbortController();
    const collecting = (async () => {
      for await (const _event of gateway.stream(request, controller.signal)) {
        // The delayed event must never arrive.
      }
    })();
    controller.abort();
    await expect(collecting).rejects.toMatchObject({ name: "AbortError" });
  });

  it("selects deterministic fixtures by generation purpose", async () => {
    const gateway = new FakeModelGateway({
      chat: [{ event: { text: "chat fixture", type: "content.delta" } }],
      compaction: [{ event: { text: "compaction fixture", type: "content.delta" } }],
    });
    const chatEvents = [];
    for await (const event of gateway.stream(request, new AbortController().signal)) {
      chatEvents.push(event);
    }
    const compactionEvents = [];
    for await (const event of gateway.stream(
      {
        history: [],
        message: { role: "user", text: "{}" },
        modelTier: "fast",
        purpose: "compaction",
        systemPrompt: compactionPrompt,
      },
      new AbortController().signal,
    )) {
      compactionEvents.push(event);
    }

    expect(chatEvents).toEqual([
      { transportElapsedMilliseconds: expect.any(Number), type: "response.headers" },
      {
        text: "chat fixture",
        transportElapsedMilliseconds: expect.any(Number),
        type: "content.delta",
      },
    ]);
    expect(compactionEvents).toEqual([
      { transportElapsedMilliseconds: expect.any(Number), type: "response.headers" },
      {
        text: "compaction fixture",
        transportElapsedMilliseconds: expect.any(Number),
        type: "content.delta",
      },
    ]);
  });

  it("allows an injected harness to resolve a request-specific script", async () => {
    const gateway = new FakeModelGateway({
      chat: [{ event: { text: "ordinary fixture", type: "content.delta" } }],
      resolve: (resolvedRequest) =>
        resolvedRequest.message.text === "load canary"
          ? [{ event: { text: "resolved canary", type: "content.delta" } }]
          : undefined,
    });
    const events = [];
    for await (const event of gateway.stream(
      { ...request, message: { role: "user", text: "load canary" } },
      new AbortController().signal,
    )) {
      events.push(event);
    }

    expect(events).toEqual([
      { transportElapsedMilliseconds: expect.any(Number), type: "response.headers" },
      {
        text: "resolved canary",
        transportElapsedMilliseconds: expect.any(Number),
        type: "content.delta",
      },
    ]);
  });
});

describe("ActiveStreamRegistry", () => {
  it("signals local cancellation and waits for release", async () => {
    const registry = new ActiveStreamRegistry();
    const lease = registry.register("generation-1");
    expect(registry.abort("generation-1", "cancelled")).toBe(true);
    expect(lease.signal.aborted).toBe(true);
    expect(lease.signal.reason).toBe("cancelled");
    expect(await registry.waitForIdle(1)).toBe(false);
    lease.release();
    expect(await registry.waitForIdle(1)).toBe(true);
  });

  it("immediately aborts a stream registered after drain begins", () => {
    const registry = new ActiveStreamRegistry();
    registry.beginDraining();
    const lease = registry.register("generation-2");
    expect(lease.signal.aborted).toBe(true);
    expect(lease.signal.reason).toBe("shutdown");
    lease.release();
  });
});

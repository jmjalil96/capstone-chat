import { EventEmitter } from "node:events";
import type { FastifyReply } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApplication } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { ActiveStreamRegistry } from "../src/generations/active-streams.js";
import { FakeModelGateway } from "../src/generations/fake-model-gateway.js";
import { continueMessage, systemPrompt } from "../src/generations/prompt.js";
import {
  CheckpointScheduler,
  NdjsonWriter,
  splitContentDelta,
} from "../src/generations/response-stream.js";
import type { GenerationService } from "../src/generations/service.js";
import { generationTuning } from "../src/generations/settings.js";

describe("Phase 4 generation configuration", () => {
  it("locks the approved operational values and versioned backend copy", () => {
    expect(generationTuning).toEqual({
      backpressureTimeoutMilliseconds: 5_000,
      checkpointBytes: 1_024,
      checkpointMilliseconds: 250,
      fakeChunkDelayMilliseconds: 400,
      gracefulDrainMilliseconds: 10_000,
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

  it("prohibits the local fake gateway in production", () => {
    const production = loadConfig({
      BETTER_AUTH_SECRET: "production-auth-secret-longer-than-thirty-two-characters",
      DATABASE_URL: "postgresql://capstone:capstone@example.invalid/capstone",
      EMAIL_DELIVERY: "disabled",
      NODE_ENV: "production",
      PUBLIC_ORIGIN: "https://chat.capstone.example",
    });
    expect(() => createApplication(production)).toThrow("FakeModelGateway is prohibited");
    expect(() => createApplication(production, { modelGateway: new FakeModelGateway() })).toThrow(
      "FakeModelGateway is prohibited",
    );
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
});

describe("FakeModelGateway", () => {
  const request = {
    history: [],
    message: { role: "user" as const, text: "Mensaje sintético" },
    modelTier: "balanced" as const,
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

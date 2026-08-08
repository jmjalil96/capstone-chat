import type { StreamEvent } from "@capstone/protocol";
import { describe, expect, it } from "vitest";

import { parseResponseStream, type StreamReadError } from "./stream-parser";

const conversationId = "11111111-1111-4111-8111-111111111111";
const generationId = "22222222-2222-4222-8222-222222222222";
const userMessageId = "33333333-3333-4333-8333-333333333333";
const messageId = "44444444-4444-4444-8444-444444444444";

const started = {
  type: "response.started",
  conversationId,
  generationId,
  userMessageId,
  messageId,
  revision: 1,
} as const;

const completed = {
  type: "response.completed",
  messageId,
  revision: 2,
  reason: "stop",
  usage: { inputTokens: 5, outputTokens: 3 },
} as const;

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function streamFrom(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
}

function lines(...events: readonly unknown[]): Uint8Array {
  return bytes(`${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
}

async function collect(
  chunks: readonly Uint8Array[],
  signal: AbortSignal = new AbortController().signal,
): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of parseResponseStream(streamFrom(chunks), signal)) {
    events.push(event);
  }
  return events;
}

async function expectCode(chunks: readonly Uint8Array[], code: StreamReadError["code"]) {
  await expect(collect(chunks)).rejects.toMatchObject({ code });
}

describe("response stream parser", () => {
  it("reconstructs UTF-8, JSON, and delimiters split at arbitrary byte boundaries", async () => {
    const payload = lines(started, { type: "content.delta", text: "Sí, brújula 🧭" }, completed);
    const chunks = Array.from(payload, (value) => new Uint8Array([value]));

    await expect(collect(chunks)).resolves.toEqual([
      started,
      { type: "content.delta", text: "Sí, brújula 🧭" },
      completed,
    ]);
  });

  it("ignores well-formed unknown events without allowing them to replace start or terminal", async () => {
    await expect(
      collect([
        lines(
          { type: "response.future", safe: true },
          started,
          { type: "response.future", sequence: 2 },
          { type: "content.delta", text: "Texto" },
          completed,
        ),
      ]),
    ).resolves.toEqual([started, { type: "content.delta", text: "Texto" }, completed]);

    await expectCode([lines({ type: "response.future" })], "STREAM_INTERRUPTED");
  });

  it("ignores blank and whitespace-only lines, including CRLF framing", async () => {
    await expect(
      collect([
        bytes(`\r\n ${"  "}\n${JSON.stringify(started)}\r\n\t\n${JSON.stringify(completed)}\r\n`),
      ]),
    ).resolves.toEqual([started, completed]);
  });

  it("enforces the compaction mini-state", async () => {
    await expect(
      collect([
        lines(
          started,
          { type: "context.compacting" },
          { type: "context.warning", code: "CONTEXT_COMPACTION_FALLBACK" },
          { type: "content.delta", text: "Texto" },
          completed,
        ),
      ]),
    ).resolves.toHaveLength(5);

    await expect(
      collect([
        lines(
          started,
          { type: "context.warning", code: "CONTEXT_COMPACTION_FALLBACK" },
          { type: "content.delta", text: "Contexto acotado" },
          completed,
        ),
      ]),
    ).resolves.toHaveLength(4);

    await expect(
      collect([
        lines(
          started,
          { type: "context.compacting" },
          {
            type: "response.cancelled",
            messageId,
            revision: 2,
          },
        ),
      ]),
    ).resolves.toHaveLength(3);
    await expect(
      collect([
        lines(
          started,
          { type: "context.compacting" },
          {
            type: "response.failed",
            errorCode: "GENERATION_FAILED",
            messageId,
            partial: false,
            revision: 2,
          },
        ),
      ]),
    ).resolves.toHaveLength(3);

    for (const payload of [
      lines(started, { type: "context.compacted" }, completed),
      lines(
        started,
        { type: "context.compacting" },
        { type: "content.delta", text: "x" },
        completed,
      ),
      lines(started, { type: "context.compacting" }, completed),
      lines(
        started,
        { type: "context.compacting" },
        { type: "context.compacted" },
        { type: "context.warning", code: "CONTEXT_COMPACTION_FALLBACK" },
        completed,
      ),
      lines(
        started,
        { type: "content.delta", text: "x" },
        { type: "context.warning", code: "CONTEXT_COMPACTION_FALLBACK" },
        completed,
      ),
      lines(
        started,
        { type: "context.warning", code: "CONTEXT_COMPACTION_FALLBACK" },
        { type: "context.warning", code: "CONTEXT_COMPACTION_FALLBACK" },
        completed,
      ),
    ]) {
      await expectCode([payload], "STREAM_PROTOCOL_ERROR");
    }
  });

  it.each([
    ["known malformed", lines(started, { type: "content.delta", text: "" }, completed)],
    ["invalid JSON", bytes(`${JSON.stringify(started)}\n{"type":\n`)],
    ["non-object JSON", lines(started, ["content.delta"], completed)],
    ["missing type", lines(started, { text: "sin tipo" }, completed)],
  ])("rejects %s without exposing stream content", async (_label, payload) => {
    let error: unknown;
    try {
      await collect([payload]);
    } catch (received) {
      error = received;
    }
    expect(error).toMatchObject({ code: "STREAM_PROTOCOL_ERROR" });
    expect(String(error)).not.toContain("sin tipo");
  });

  it("rejects invalid UTF-8", async () => {
    const prefix = lines(started);
    const invalid = new Uint8Array([...bytes('{"type":"content.delta","text":"'), 0xc3, 0x28]);
    await expectCode([prefix, invalid, bytes('"}\n')], "STREAM_PROTOCOL_ERROR");
  });

  it.each([
    ["event before start", lines({ type: "content.delta", text: "x" }, started, completed)],
    ["duplicate start", lines(started, started, completed)],
    ["duplicate terminal", lines(started, completed, completed)],
    ["event after terminal", lines(started, completed, { type: "response.future" })],
    [
      "wrong terminal message",
      lines(started, { ...completed, messageId: "55555555-5555-4555-8555-555555555555" }),
    ],
  ])("rejects invalid ordering: %s", async (_label, payload) => {
    await expectCode([payload], "STREAM_PROTOCOL_ERROR");
  });

  it("distinguishes EOF and a trailing partial object from protocol violations", async () => {
    await expectCode(
      [lines(started, { type: "content.delta", text: "parcial" })],
      "STREAM_INTERRUPTED",
    );
    await expectCode(
      [lines(started, { type: "content.delta", text: "parcial" }), bytes('{"type":')],
      "STREAM_INTERRUPTED",
    );
  });

  it("enforces the completed-line bound without depending on transport chunk size", async () => {
    await expect(
      (async () => {
        for await (const _event of parseResponseStream(
          streamFrom([bytes('{"type":"response.future","padding":"12345"}\n')]),
          new AbortController().signal,
          { maxLineBytes: 16 },
        )) {
          // No known event is expected.
        }
      })(),
    ).rejects.toMatchObject({ code: "STREAM_PROTOCOL_ERROR" });

    const shortUnknownEvents = Array.from({ length: 5_000 }, (_, sequence) => ({
      sequence,
      type: "response.future",
    }));
    const coalescedChunk = lines(started, ...shortUnknownEvents, completed);
    expect(coalescedChunk.byteLength).toBeGreaterThan(131_072);
    await expect(collect([coalescedChunk])).resolves.toEqual([started, completed]);
  });

  it("honors cancellation even when the reader has not completed", async () => {
    const controller = new AbortController();
    const stream = new ReadableStream<Uint8Array>({
      start(target) {
        target.enqueue(lines(started));
      },
    });
    const reading = (async () => {
      for await (const _event of parseResponseStream(stream, controller.signal)) {
        controller.abort();
      }
    })();

    await expect(reading).rejects.toMatchObject({ name: "AbortError" });
  });
});

import { type StreamEvent, StreamEventSchema } from "@capstone/protocol";
import Value from "typebox/value";

import { STREAM_MAX_DECODER_BUFFER_BYTES, STREAM_MAX_LINE_BYTES } from "./config";

const knownEventTypes = new Set([
  "response.started",
  "context.compacting",
  "context.compacted",
  "context.warning",
  "content.delta",
  "response.completed",
  "response.cancelled",
  "response.failed",
]);

const terminalEventTypes = new Set(["response.completed", "response.cancelled", "response.failed"]);

export type StreamReadErrorCode = "STREAM_INTERRUPTED" | "STREAM_PROTOCOL_ERROR";

export class StreamReadError extends Error {
  readonly code: StreamReadErrorCode;

  constructor(code: StreamReadErrorCode) {
    super(
      code === "STREAM_INTERRUPTED"
        ? "The response stream was interrupted."
        : "The response stream was invalid.",
    );
    this.name = "StreamReadError";
    this.code = code;
  }
}

export interface StreamParserLimits {
  readonly maxBufferBytes: number;
  readonly maxLineBytes: number;
}

const defaultLimits: StreamParserLimits = {
  maxBufferBytes: STREAM_MAX_DECODER_BUFFER_BYTES,
  maxLineBytes: STREAM_MAX_LINE_BYTES,
};

function abortError(): DOMException {
  return new DOMException("The response stream was aborted.", "AbortError");
}

function isEventObject(value: unknown): value is { readonly type: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof Reflect.get(value, "type") === "string"
  );
}

function decodeLine(parts: readonly Uint8Array[], decoder: TextDecoder): string {
  try {
    let line = "";
    for (const part of parts) {
      line += decoder.decode(part, { stream: true });
    }
    line += decoder.decode();
    return line;
  } catch {
    throw new StreamReadError("STREAM_PROTOCOL_ERROR");
  }
}

function parseLine(line: string): unknown {
  try {
    return JSON.parse(line) as unknown;
  } catch {
    throw new StreamReadError("STREAM_PROTOCOL_ERROR");
  }
}

export async function* parseResponseStream(
  stream: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  limits: StreamParserLimits = defaultLimits,
): AsyncGenerator<StreamEvent> {
  if (signal.aborted) {
    throw abortError();
  }

  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const parts: Uint8Array[] = [];
  let bufferedBytes = 0;
  let startedMessageId: string | undefined;
  let terminal = false;
  let contentSeen = false;
  let compaction: "none" | "compacting" | "settled" = "none";
  const cancelReader = () => void reader.cancel().catch(() => undefined);
  signal.addEventListener("abort", cancelReader, { once: true });

  try {
    while (true) {
      const read = await reader.read();
      if (signal.aborted) {
        throw abortError();
      }
      if (read.done) {
        break;
      }

      let offset = 0;
      while (offset < read.value.byteLength) {
        const newline = read.value.indexOf(0x0a, offset);
        const end = newline === -1 ? read.value.byteLength : newline;
        const segment = read.value.subarray(offset, end);
        if (segment.byteLength > 0) {
          bufferedBytes += segment.byteLength;
          if (bufferedBytes > limits.maxLineBytes || bufferedBytes > limits.maxBufferBytes) {
            throw new StreamReadError("STREAM_PROTOCOL_ERROR");
          }
          parts.push(segment);
        }

        if (newline === -1) {
          break;
        }

        const line = decodeLine(parts, decoder);
        parts.length = 0;
        bufferedBytes = 0;
        offset = newline + 1;
        if (line.trim().length === 0) {
          continue;
        }

        const parsed = parseLine(line);

        if (!isEventObject(parsed)) {
          throw new StreamReadError("STREAM_PROTOCOL_ERROR");
        }
        if (terminal) {
          throw new StreamReadError("STREAM_PROTOCOL_ERROR");
        }
        if (!knownEventTypes.has(parsed.type)) {
          continue;
        }
        if (!Value.Check(StreamEventSchema, parsed)) {
          throw new StreamReadError("STREAM_PROTOCOL_ERROR");
        }

        const event = parsed as StreamEvent;
        if (!startedMessageId) {
          if (event.type !== "response.started") {
            throw new StreamReadError("STREAM_PROTOCOL_ERROR");
          }
          startedMessageId = event.messageId;
        } else if (event.type === "response.started") {
          throw new StreamReadError("STREAM_PROTOCOL_ERROR");
        }

        if (event.type === "context.compacting") {
          if (compaction !== "none" || contentSeen) {
            throw new StreamReadError("STREAM_PROTOCOL_ERROR");
          }
          compaction = "compacting";
        } else if (event.type === "context.compacted" || event.type === "context.warning") {
          if (compaction !== "compacting") {
            throw new StreamReadError("STREAM_PROTOCOL_ERROR");
          }
          compaction = "settled";
        } else if (event.type === "content.delta") {
          if (compaction === "compacting") {
            throw new StreamReadError("STREAM_PROTOCOL_ERROR");
          }
          contentSeen = true;
        }

        if (terminalEventTypes.has(event.type)) {
          if (
            compaction === "compacting" ||
            !("messageId" in event) ||
            event.messageId !== startedMessageId
          ) {
            throw new StreamReadError("STREAM_PROTOCOL_ERROR");
          }
          terminal = true;
        }

        yield event;
      }
    }

    if (bufferedBytes > 0 || parts.length > 0 || !terminal) {
      throw new StreamReadError("STREAM_INTERRUPTED");
    }
  } catch (error) {
    if (signal.aborted) {
      throw abortError();
    }
    if (error instanceof StreamReadError) {
      throw error;
    }
    throw new StreamReadError("STREAM_INTERRUPTED");
  } finally {
    signal.removeEventListener("abort", cancelReader);
    reader.releaseLock();
  }
}

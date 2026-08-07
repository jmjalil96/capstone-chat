import type {
  ResponseCancelledEvent,
  ResponseCompletedEvent,
  ResponseFailedEvent,
  ResponseStartedEvent,
  StreamEvent,
  StreamFailureErrorCode,
} from "@capstone/protocol";
import type { FastifyReply, FastifyRequest } from "fastify";
import { hasUnsupportedControlCharacter } from "../conversations/content.js";
import { applySecurityHeaders } from "../security/http.js";
import type { ActiveStreamRegistry } from "./active-streams.js";
import type { GatewayFailureCode, GatewayUsage, ModelGateway } from "./model-gateway.js";
import type {
  DurableGenerationState,
  GenerationService,
  StartedResponse,
  TerminalGenerationResult,
} from "./service.js";
import { generationTuning } from "./settings.js";

class StreamTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StreamTransportError";
  }
}

class GatewayOutputError extends Error {
  readonly code: GatewayFailureCode;

  constructor(code: GatewayFailureCode) {
    super("The gateway returned unusable output");
    this.name = "GatewayOutputError";
    this.code = code;
  }
}

export class NdjsonWriter {
  readonly #interruptSignal: AbortSignal;
  readonly #reply: FastifyReply;
  readonly #transportSignal: AbortSignal;

  constructor(reply: FastifyReply, transportSignal: AbortSignal, interruptSignal: AbortSignal) {
    this.#reply = reply;
    this.#transportSignal = transportSignal;
    this.#interruptSignal = interruptSignal;
  }

  start(requestId: string): void {
    void this.#reply.code(200);
    void this.#reply.header("cache-control", "no-store");
    void this.#reply.header("content-type", "application/x-ndjson");
    void this.#reply.header("x-content-type-options", "nosniff");
    void this.#reply.header("x-request-id", requestId);
    applySecurityHeaders(this.#reply);
    const headers: Record<string, string | string[]> = {};
    for (const [name, value] of Object.entries(this.#reply.getHeaders())) {
      if (value !== undefined) {
        headers[name] = typeof value === "number" ? String(value) : value;
      }
    }
    this.#reply.hijack();
    this.#reply.raw.writeHead(200, headers);
    this.#reply.raw.flushHeaders();
  }

  async write(event: StreamEvent): Promise<void> {
    this.#transportSignal.throwIfAborted();
    if (this.#reply.raw.destroyed || this.#reply.raw.writableEnded) {
      throw new StreamTransportError("The downstream response is no longer writable");
    }
    const line = `${JSON.stringify(event)}\n`;
    if (this.#reply.raw.write(line, "utf8")) {
      return;
    }
    await this.#waitForDrain();
  }

  async #waitForDrain(): Promise<void> {
    this.#interruptSignal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const raw = this.#reply.raw;
      const timeout = setTimeout(() => {
        finish(new StreamTransportError("Downstream response backpressure timed out"));
      }, generationTuning.backpressureTimeoutMilliseconds);

      const drained = () => finish();
      const closed = () => finish(new StreamTransportError("Downstream response closed"));
      const errored = () => finish(new StreamTransportError("Downstream response failed"));
      const aborted = () => finish(new StreamTransportError("Generation stream was aborted"));

      const finish = (error?: Error): void => {
        clearTimeout(timeout);
        raw.removeListener("drain", drained);
        raw.removeListener("close", closed);
        raw.removeListener("error", errored);
        this.#interruptSignal.removeEventListener("abort", aborted);
        if (error === undefined) {
          resolve();
        } else {
          reject(error);
        }
      };

      raw.once("drain", drained);
      raw.once("close", closed);
      raw.once("error", errored);
      this.#interruptSignal.addEventListener("abort", aborted, { once: true });
    });
  }
}

export class CheckpointScheduler {
  readonly #generations: GenerationService;
  readonly #generationId: string;
  #firstTokenAt: Date | null = null;
  #inFlight: Promise<void> | null = null;
  #lastCheckpointAt: number;
  #lastCheckpointBytes = 0;
  #latestBytes = 0;
  #latestContent = "";
  #pending = false;
  #stopped = false;
  #timer: ReturnType<typeof setTimeout> | null = null;

  constructor(generations: GenerationService, generationId: string, now: number) {
    this.#generations = generations;
    this.#generationId = generationId;
    this.#lastCheckpointAt = now;
  }

  observe(content: string, totalBytes: number, firstTokenAt: Date, now: number): void {
    this.#latestContent = content;
    this.#latestBytes = totalBytes;
    this.#firstTokenAt ??= firstTokenAt;
    const eligible =
      totalBytes - this.#lastCheckpointBytes >= generationTuning.checkpointBytes ||
      now - this.#lastCheckpointAt >= generationTuning.checkpointMilliseconds;
    if (this.#stopped) {
      return;
    }
    if (eligible) {
      this.#requestCheckpoint(now);
      return;
    }
    this.#scheduleElapsedCheckpoint(now);
  }

  async settle(): Promise<void> {
    this.#stopped = true;
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    await this.#inFlight;
  }

  #requestCheckpoint(now: number): void {
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    if (this.#inFlight !== null) {
      this.#pending = true;
      return;
    }
    this.#start(now);
  }

  #scheduleElapsedCheckpoint(now: number): void {
    if (this.#timer !== null || this.#latestBytes === this.#lastCheckpointBytes) {
      return;
    }
    const remaining = Math.max(
      0,
      generationTuning.checkpointMilliseconds - (now - this.#lastCheckpointAt),
    );
    this.#timer = setTimeout(() => {
      this.#timer = null;
      if (!this.#stopped) {
        this.#requestCheckpoint(Date.now());
      }
    }, remaining);
  }

  #start(now: number): void {
    const content = this.#latestContent;
    const bytes = this.#latestBytes;
    this.#lastCheckpointAt = now;
    this.#lastCheckpointBytes = bytes;
    const operation = this.#generations
      .checkpoint(this.#generationId, content, this.#firstTokenAt)
      .then(() => undefined)
      .catch(() => undefined)
      .finally(() => {
        if (this.#inFlight === operation) {
          this.#inFlight = null;
        }
        if (!this.#stopped && this.#pending) {
          this.#pending = false;
          this.#start(Date.now());
        } else if (!this.#stopped) {
          this.#scheduleElapsedCheckpoint(Date.now());
        }
      });
    this.#inFlight = operation;
  }
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

function validUsage(usage: GatewayUsage): boolean {
  return (
    Number.isSafeInteger(usage.inputTokens) &&
    usage.inputTokens >= 0 &&
    Number.isSafeInteger(usage.outputTokens) &&
    usage.outputTokens >= 0
  );
}

function isWritable(reply: FastifyReply): boolean {
  return !reply.raw.destroyed && !reply.raw.writableEnded;
}

export function splitContentDelta(text: string): readonly string[] {
  const lineOverhead = Buffer.byteLength(
    `${JSON.stringify({ text: "", type: "content.delta" })}\n`,
    "utf8",
  );
  const maximumEscapedTextBytes = generationTuning.maximumNdjsonLineBytes - lineOverhead;
  const chunks: string[] = [];
  let characters: string[] = [];
  let escapedBytes = 0;
  for (const character of text) {
    const encoded = JSON.stringify(character);
    const characterBytes = Buffer.byteLength(encoded.slice(1, -1), "utf8");
    if (characters.length > 0 && escapedBytes + characterBytes > maximumEscapedTextBytes) {
      chunks.push(characters.join(""));
      characters = [];
      escapedBytes = 0;
    }
    characters.push(character);
    escapedBytes += characterBytes;
  }
  if (characters.length > 0) {
    chunks.push(characters.join(""));
  }
  return chunks;
}

export function createResponseStreamCoordinator(dependencies: {
  readonly gateway: ModelGateway;
  readonly generations: GenerationService;
  readonly registry: ActiveStreamRegistry;
}) {
  const { gateway, generations, registry } = dependencies;

  async function stream(
    started: StartedResponse,
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    let assistantContent = "";
    let assistantBytes = 0;
    let firstTokenAt: Date | null = null;
    let terminal = false;
    const lease = registry.register(started.generationId, () => ({
      content: assistantContent,
      firstTokenAt,
    }));
    const disconnected = new AbortController();
    const gatewayController = new AbortController();
    const gatewaySignal = AbortSignal.any([
      lease.signal,
      disconnected.signal,
      gatewayController.signal,
    ]);
    const writer = new NdjsonWriter(
      reply,
      disconnected.signal,
      AbortSignal.any([lease.signal, disconnected.signal]),
    );
    const checkpoints = new CheckpointScheduler(generations, started.generationId, Date.now());

    const connectionClosed = (): void => {
      if (!reply.raw.writableFinished && !disconnected.signal.aborted) {
        disconnected.abort("disconnect");
      }
    };
    const connectionError = (): void => {
      if (!disconnected.signal.aborted) {
        disconnected.abort("disconnect");
      }
    };
    reply.raw.once("close", connectionClosed);
    reply.raw.once("error", connectionError);

    async function durableTerminalEvent(state: DurableGenerationState): Promise<boolean> {
      if (
        state.status === "cancelled" &&
        state.assistantMessageId !== null &&
        state.revision !== null &&
        isWritable(reply)
      ) {
        const event: ResponseCancelledEvent = {
          messageId: state.assistantMessageId,
          revision: state.revision,
          type: "response.cancelled",
        };
        await writer.write(event);
        return true;
      }
      return state.status !== "active";
    }

    async function emitFailure(
      errorCode: StreamFailureErrorCode,
      result: TerminalGenerationResult,
    ): Promise<void> {
      if (result.assistantMessageId === null || result.revision === null || !isWritable(reply)) {
        return;
      }
      const event: ResponseFailedEvent = {
        errorCode,
        messageId: result.assistantMessageId,
        partial: result.status === "incomplete",
        revision: result.revision,
        type: "response.failed",
      };
      await writer.write(event);
    }

    async function fail(errorCode: GatewayFailureCode): Promise<void> {
      const partial = /\S/u.test(assistantContent);
      const result = await generations.terminalize(started.generationId, {
        content: assistantContent,
        errorCode,
        firstTokenAt,
        reason: "error",
        status: partial ? "incomplete" : "failed",
      });
      if (result.won) {
        await emitFailure(errorCode, result);
      } else {
        terminal = await durableTerminalEvent(result);
      }
    }

    try {
      writer.start(request.id);
      const startedEvent: ResponseStartedEvent = {
        conversationId: started.conversationId,
        generationId: started.generationId,
        messageId: started.messageId,
        revision: started.revision,
        type: "response.started",
        userMessageId: started.userMessageId,
      };
      await writer.write(startedEvent);

      for await (const event of gateway.stream(started.request, gatewaySignal)) {
        const state = await generations.readState(started.generationId);
        if (state === null) {
          throw new GatewayOutputError("GENERATION_FAILED");
        }
        if (state.status !== "active") {
          gatewayController.abort("cancelled");
          terminal = await durableTerminalEvent(state);
          break;
        }
        const pendingCancellation = lease.pendingCancellation();
        if (pendingCancellation !== undefined && (await pendingCancellation)) {
          const cancelledState = await generations.readState(started.generationId);
          if (cancelledState === null) {
            throw new GatewayOutputError("GENERATION_FAILED");
          }
          gatewayController.abort("cancelled");
          terminal = await durableTerminalEvent(cancelledState);
          break;
        }

        if (event.type === "content.delta") {
          if (
            event.text.length === 0 ||
            !event.text.isWellFormed() ||
            hasUnsupportedControlCharacter(event.text)
          ) {
            throw new GatewayOutputError("GENERATION_FAILED");
          }
          const deltaBytes = Buffer.byteLength(event.text, "utf8");
          if (assistantBytes + deltaBytes > generationTuning.maximumAssistantBytes) {
            throw new GatewayOutputError("GENERATION_FAILED");
          }
          assistantContent += event.text;
          assistantBytes += deltaBytes;
          firstTokenAt ??= new Date();
          for (const chunk of splitContentDelta(event.text)) {
            await writer.write({ text: chunk, type: "content.delta" });
          }
          checkpoints.observe(assistantContent, assistantBytes, firstTokenAt, Date.now());
          continue;
        }

        if (event.type === "response.failed") {
          await fail(event.errorCode);
          terminal = true;
          break;
        }

        if (!validUsage(event.usage)) {
          throw new GatewayOutputError("GENERATION_FAILED");
        }
        if (!/\S/u.test(assistantContent)) {
          const result = await generations.terminalize(started.generationId, {
            content: "",
            errorCode: "EMPTY_RESPONSE",
            firstTokenAt,
            reason: "error",
            status: "failed",
          });
          if (result.won) {
            await emitFailure("EMPTY_RESPONSE", result);
          } else {
            terminal = await durableTerminalEvent(result);
          }
          terminal = true;
          break;
        }

        const result = await generations.terminalize(started.generationId, {
          content: assistantContent,
          errorCode: null,
          firstTokenAt,
          reason: event.reason,
          status: "completed",
        });
        if (result.won && result.assistantMessageId !== null && result.revision !== null) {
          const completed: ResponseCompletedEvent = {
            messageId: result.assistantMessageId,
            reason: event.reason,
            revision: result.revision,
            type: "response.completed",
            usage: event.usage,
          };
          await writer.write(completed);
        } else {
          terminal = await durableTerminalEvent(result);
        }
        terminal = true;
        break;
      }

      if (!terminal) {
        await fail("GENERATION_FAILED");
        terminal = true;
      }
    } catch (error: unknown) {
      const state = await generations.readState(started.generationId).catch(() => null);
      if (state !== null && state.status !== "active") {
        terminal = await durableTerminalEvent(state).catch(() => true);
      } else if (state?.status === "active") {
        const interrupted =
          lease.signal.aborted ||
          disconnected.signal.aborted ||
          error instanceof StreamTransportError ||
          isAbortError(error);
        const partial = /\S/u.test(assistantContent);
        const failureCode: GatewayFailureCode =
          error instanceof GatewayOutputError ? error.code : "GENERATION_FAILED";
        const committed = await generations
          .terminalize(started.generationId, {
            content: assistantContent,
            errorCode: interrupted ? "STREAM_INTERRUPTED" : failureCode,
            firstTokenAt,
            reason: "error",
            status: partial ? "incomplete" : "failed",
          })
          .catch(() => undefined);
        if (committed?.won && !interrupted && isWritable(reply) && !disconnected.signal.aborted) {
          await emitFailure(failureCode, committed).catch(() => undefined);
        }
      }
    } finally {
      if (!gatewayController.signal.aborted) {
        gatewayController.abort("disconnect");
      }
      await checkpoints.settle();
      reply.raw.removeListener("close", connectionClosed);
      reply.raw.removeListener("error", connectionError);
      if (!reply.raw.destroyed && !reply.raw.writableEnded) {
        reply.raw.end();
      }
      lease.release();
    }
  }

  return Object.freeze({ stream });
}

export type ResponseStreamCoordinator = ReturnType<typeof createResponseStreamCoordinator>;

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
import type {
  GatewayAccounting,
  GatewayEvent,
  GatewayFailureCode,
  GatewayProviderMetadata,
  GatewayUsage,
  GenerationAccountingGateway,
  ModelGateway,
} from "./model-gateway.js";
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
  #terminalEnqueued = false;

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
    const terminal =
      event.type === "response.completed" ||
      event.type === "response.cancelled" ||
      event.type === "response.failed";
    if (terminal && this.#terminalEnqueued) {
      return;
    }
    this.#transportSignal.throwIfAborted();
    if (this.#reply.raw.destroyed || this.#reply.raw.writableEnded) {
      throw new StreamTransportError("The downstream response is no longer writable");
    }
    const line = `${JSON.stringify(event)}\n`;
    const accepted = this.#reply.raw.write(line, "utf8");
    if (terminal) {
      this.#terminalEnqueued = true;
    }
    if (accepted) {
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
  #durableCheckpointAt: number;
  #durableCheckpointBytes = 0;
  #firstTokenAt: Date | null = null;
  #inFlight: Promise<void> | null = null;
  #latestBytes = 0;
  #latestContent = "";
  #observedWhileInFlight = false;
  #pending = false;
  #scheduledCheckpointAt: number;
  #scheduledCheckpointBytes = 0;
  #stopped = false;
  #timer: ReturnType<typeof setTimeout> | null = null;

  constructor(generations: GenerationService, generationId: string, now: number) {
    this.#generations = generations;
    this.#generationId = generationId;
    this.#durableCheckpointAt = now;
    this.#scheduledCheckpointAt = now;
  }

  observe(content: string, totalBytes: number, firstTokenAt: Date, now: number): void {
    this.#latestContent = content;
    this.#latestBytes = totalBytes;
    this.#firstTokenAt ??= firstTokenAt;
    if (this.#inFlight !== null) {
      this.#observedWhileInFlight = true;
    }
    const eligible =
      totalBytes - this.#scheduledCheckpointBytes >= generationTuning.checkpointBytes ||
      now - this.#scheduledCheckpointAt >= generationTuning.checkpointMilliseconds;
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
    if (this.#timer !== null || this.#latestBytes === this.#scheduledCheckpointBytes) {
      return;
    }
    const remaining = Math.max(
      0,
      generationTuning.checkpointMilliseconds - (now - this.#scheduledCheckpointAt),
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
    this.#scheduledCheckpointAt = now;
    this.#scheduledCheckpointBytes = bytes;
    let persisted = false;
    const operation = this.#generations
      .checkpoint(this.#generationId, content, this.#firstTokenAt)
      .then((didPersist) => {
        persisted = didPersist;
        if (didPersist) {
          this.#durableCheckpointAt = now;
          this.#durableCheckpointBytes = bytes;
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (this.#inFlight === operation) {
          this.#inFlight = null;
        }
        const observedWhileInFlight = this.#observedWhileInFlight;
        this.#observedWhileInFlight = false;
        if (!persisted) {
          this.#scheduledCheckpointAt = this.#durableCheckpointAt;
          this.#scheduledCheckpointBytes = this.#durableCheckpointBytes;
          if (this.#timer !== null) {
            clearTimeout(this.#timer);
            this.#timer = null;
          }
        }
        if (!this.#stopped && this.#pending) {
          this.#pending = false;
          this.#start(Date.now());
        } else if (!this.#stopped && observedWhileInFlight) {
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

function accountingGateway(
  gateway: ModelGateway,
): (ModelGateway & GenerationAccountingGateway) | null {
  return "lookupUsage" in gateway && typeof gateway.lookupUsage === "function"
    ? (gateway as ModelGateway & GenerationAccountingGateway)
    : null;
}

async function waitForDurableStatePoll(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return;
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(finish, generationTuning.durableStatePollMilliseconds);
    const aborted = (): void => finish();

    function finish(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", aborted);
      resolve();
    }

    signal.addEventListener("abort", aborted, { once: true });
  });
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
    let accountingSettled = false;
    let firstTokenAt: Date | null = null;
    let providerGenerationId: string | null = null;
    let terminal = false;
    let usageLookupAttempted = false;
    const lease = registry.register(started.generationId, () => ({
      content: assistantContent,
      firstTokenAt,
    }));
    const disconnected = new AbortController();
    const durableStateMonitorController = new AbortController();
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

    async function persistProviderMetadata(metadata: GatewayProviderMetadata): Promise<void> {
      providerGenerationId = metadata.providerGenerationId ?? providerGenerationId;
      await generations.recordProviderMetadata(started.generationId, metadata);
    }

    async function settleAfterTerminal(
      usage: GatewayUsage,
      accounting: GatewayAccounting,
    ): Promise<void> {
      providerGenerationId = accounting.metadata.providerGenerationId ?? providerGenerationId;
      accountingSettled =
        (await generations.settleAccounting(started.generationId, usage, accounting)) ||
        accountingSettled;
    }

    async function lookupAccounting(): Promise<
      { readonly accounting: GatewayAccounting; readonly usage: GatewayUsage } | undefined
    > {
      const lookup = accountingGateway(gateway);
      if (
        lookup === null ||
        providerGenerationId === null ||
        accountingSettled ||
        usageLookupAttempted
      ) {
        return undefined;
      }
      usageLookupAttempted = true;
      const result = await lookup
        .lookupUsage(providerGenerationId, new AbortController().signal)
        .catch(() => ({ status: "unavailable" as const }));
      if (result.status !== "found") {
        return undefined;
      }
      await persistProviderMetadata(result.accounting.metadata);
      return { accounting: result.accounting, usage: result.usage };
    }

    async function settleLateEvent(event: GatewayEvent): Promise<void> {
      if (event.type === "generation.metadata") {
        await persistProviderMetadata(event.metadata);
        return;
      }
      if (event.type === "content.delta") {
        return;
      }
      if (event.type === "response.completed") {
        if (event.accounting !== undefined) {
          await persistProviderMetadata(event.accounting.metadata);
          if (validUsage(event.usage)) {
            await settleAfterTerminal(event.usage, event.accounting);
          }
        }
        return;
      }

      usageLookupAttempted ||= event.usageLookupAttempted === true;
      const metadata = event.accounting?.actual?.metadata ?? event.accounting?.metadata;
      if (metadata !== undefined) {
        await persistProviderMetadata(metadata);
      }
      if (
        event.accounting?.actual !== undefined &&
        event.usage !== undefined &&
        validUsage(event.usage)
      ) {
        await settleAfterTerminal(event.usage, event.accounting.actual);
      }
    }

    async function monitorDurableState(): Promise<void> {
      const signal = durableStateMonitorController.signal;
      while (!signal.aborted) {
        const state = await generations.readState(started.generationId).catch(() => undefined);
        if (state === null || (state !== undefined && state.status !== "active")) {
          gatewayController.abort("durable-terminal");
          return;
        }
        await waitForDurableStatePoll(signal);
      }
    }

    const durableStateMonitor =
      started.request.route === undefined ? undefined : monitorDurableState();

    async function fail(
      errorCode: GatewayFailureCode,
      details: {
        readonly accounting?: GatewayAccounting;
        readonly settleDeterministicZero?: boolean;
        readonly usage?: GatewayUsage;
      } = {},
    ): Promise<void> {
      const partial = /\S/u.test(assistantContent);
      const result = await generations.terminalize(started.generationId, {
        ...(details.accounting === undefined || details.usage === undefined
          ? {}
          : { accounting: { metadata: details.accounting, usage: details.usage } }),
        content: assistantContent,
        errorCode,
        firstTokenAt,
        reason: "error",
        ...(details.settleDeterministicZero === undefined
          ? {}
          : { settleDeterministicZero: details.settleDeterministicZero }),
        status: partial ? "incomplete" : "failed",
      });
      if (result.won) {
        accountingSettled =
          details.accounting !== undefined || details.settleDeterministicZero === true;
        await emitFailure(errorCode, result);
      } else {
        if (details.accounting !== undefined && details.usage !== undefined) {
          await settleAfterTerminal(details.usage, details.accounting);
        }
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
          await settleLateEvent(event);
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
        lease.signal.throwIfAborted();

        if (event.type === "generation.metadata") {
          await persistProviderMetadata(event.metadata);
          continue;
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
          usageLookupAttempted ||= event.usageLookupAttempted === true;
          if (event.accounting?.metadata !== undefined) {
            await persistProviderMetadata(event.accounting.metadata);
          }
          let terminalAccounting =
            event.accounting?.actual !== undefined && event.usage !== undefined
              ? { accounting: event.accounting.actual, usage: event.usage }
              : undefined;
          if (event.providerOutcome !== undefined && terminalAccounting === undefined) {
            terminalAccounting = await lookupAccounting();
          }
          if (event.providerOutcome !== undefined && terminalAccounting !== undefined) {
            const result = await generations.terminalize(started.generationId, {
              accounting: {
                metadata: terminalAccounting.accounting,
                usage: terminalAccounting.usage,
              },
              content: assistantContent,
              errorCode: null,
              firstTokenAt,
              reason: event.providerOutcome,
              status: "completed",
            });
            if (result.won && result.assistantMessageId !== null && result.revision !== null) {
              accountingSettled = true;
              await writer.write({
                messageId: result.assistantMessageId,
                reason: event.providerOutcome,
                revision: result.revision,
                type: "response.completed",
                usage: terminalAccounting.usage,
              });
            } else {
              await settleAfterTerminal(terminalAccounting.usage, terminalAccounting.accounting);
              terminal = await durableTerminalEvent(result);
            }
          } else {
            await fail(event.errorCode, {
              ...(terminalAccounting ?? {}),
              settleDeterministicZero: event.accounting?.spendRisk === "none",
            });
          }
          terminal = true;
          break;
        }

        if (!validUsage(event.usage)) {
          throw new GatewayOutputError("GENERATION_FAILED");
        }
        if (
          !/\S/u.test(assistantContent) &&
          event.reason !== "refusal" &&
          event.reason !== "content_filter"
        ) {
          const result = await generations.terminalize(started.generationId, {
            ...(event.accounting === undefined
              ? {}
              : { accounting: { metadata: event.accounting, usage: event.usage } }),
            content: "",
            errorCode: "EMPTY_RESPONSE",
            firstTokenAt,
            reason: "error",
            status: "failed",
          });
          if (result.won) {
            accountingSettled = event.accounting !== undefined || accountingSettled;
            await emitFailure("EMPTY_RESPONSE", result);
          } else {
            terminal = await durableTerminalEvent(result);
          }
          terminal = true;
          break;
        }

        const result = await generations.terminalize(started.generationId, {
          ...(event.accounting === undefined
            ? {}
            : { accounting: { metadata: event.accounting, usage: event.usage } }),
          content: assistantContent,
          errorCode: null,
          firstTokenAt,
          reason: event.reason,
          status: "completed",
        });
        if (result.won && result.assistantMessageId !== null && result.revision !== null) {
          accountingSettled = event.accounting !== undefined || accountingSettled;
          const completed: ResponseCompletedEvent = {
            messageId: result.assistantMessageId,
            reason: event.reason,
            revision: result.revision,
            type: "response.completed",
            usage: event.usage,
          };
          await writer.write(completed);
        } else {
          if (event.accounting !== undefined) {
            await settleAfterTerminal(event.usage, event.accounting);
          }
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
        if (committed?.won) {
          if (!interrupted && isWritable(reply) && !disconnected.signal.aborted) {
            await emitFailure(failureCode, committed).catch(() => undefined);
          }
        } else if (committed !== undefined) {
          terminal = await durableTerminalEvent(committed).catch(() => true);
        }
      }
    } finally {
      durableStateMonitorController.abort("stream-settled");
      if (!gatewayController.signal.aborted) {
        gatewayController.abort("disconnect");
      }
      await durableStateMonitor;
      await checkpoints.settle();
      if (!accountingSettled && providerGenerationId !== null) {
        const recovered = await lookupAccounting().catch(() => undefined);
        if (recovered !== undefined) {
          await settleAfterTerminal(recovered.usage, recovered.accounting).catch(() => undefined);
        }
      }
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

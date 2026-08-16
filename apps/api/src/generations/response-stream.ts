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
import { isTerminalGenerationStatus } from "../database/generation-schema.js";
import { promoteToStreamingResponse } from "../http-request-drain.js";
import type {
  ApplicationTelemetry,
  ModelCallTelemetry,
  TelemetryContextMode,
  TelemetryOutcome,
} from "../observability/telemetry-contract.js";
import { applySecurityHeaders } from "../security/http.js";
import type { ActiveStreamRegistry } from "./active-streams.js";
import type { CompactionService } from "./compaction-service.js";
import { DurableGenerationAuthority } from "./durable-authority.js";
import type {
  GatewayAccounting,
  GatewayEvent,
  GatewayFailureCode,
  GatewayProviderMetadata,
  GatewayUsage,
  GenerationAccountingGateway,
  GenerationRequest,
  ModelGateway,
} from "./model-gateway.js";
import { gatewayTransportElapsedMilliseconds } from "./model-gateway.js";
import type {
  DurableGenerationState,
  GenerationService,
  StartedResponse,
  TerminalGenerationResult,
} from "./service.js";
import { generationTuning } from "./settings.js";
import { type NamingHandoff, runTitleGeneration, type TitleOutcome } from "./title-service.js";

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

/**
 * Serial NDJSON writer for one downstream socket. Socket loss, write failure, or a backpressure
 * stall detaches presentation only: later writes become no-ops and the producer keeps consuming,
 * checkpointing, and terminalizing the generation. Only the workflow interrupt signal (Stop,
 * deletion, shutdown) rejects a pending write.
 */
export class NdjsonWriter {
  readonly #interruptSignal: AbortSignal;
  readonly #onDetach: () => void;
  readonly #reply: FastifyReply;
  #detached = false;
  #terminalEnqueued = false;
  #writeTail = Promise.resolve();

  constructor(reply: FastifyReply, interruptSignal: AbortSignal, onDetach: () => void = () => {}) {
    this.#reply = reply;
    this.#interruptSignal = interruptSignal;
    this.#onDetach = onDetach;
  }

  get detached(): boolean {
    return this.#detached;
  }

  /** Marks the socket unusable for presentation. Idempotent; never touches the generation. */
  detach(): void {
    if (this.#detached) {
      return;
    }
    this.#detached = true;
    this.#onDetach();
  }

  start(requestId: string): void {
    void this.#reply.code(200);
    void this.#reply.header("cache-control", "no-store, no-transform");
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
    if (this.#terminalEnqueued) {
      return;
    }
    if (terminal) {
      this.#terminalEnqueued = true;
    }
    if (this.#detached) {
      return;
    }
    const operation = this.#writeTail.then(async () => {
      if (this.#detached) {
        return;
      }
      if (this.#reply.raw.destroyed || this.#reply.raw.writableEnded) {
        this.detach();
        return;
      }
      const line = `${JSON.stringify(event)}\n`;
      let accepted: boolean;
      try {
        accepted = this.#reply.raw.write(line, "utf8");
      } catch {
        this.detach();
        return;
      }
      if (!accepted) {
        await this.#waitForDrain();
      }
    });
    this.#writeTail = operation.catch(() => undefined);
    await operation;
  }

  async #waitForDrain(): Promise<void> {
    this.#interruptSignal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const raw = this.#reply.raw;
      const timeout = setTimeout(() => {
        // A reader that cannot keep up is disconnected explicitly: end() could stay stuck behind
        // buffered data, so destroy() closes the socket and the browser reattaches durably.
        finish();
        this.detach();
        raw.destroy();
      }, generationTuning.backpressureTimeoutMilliseconds);

      const drained = () => finish();
      const closed = () => {
        finish();
        this.detach();
      };
      const errored = () => {
        finish();
        this.detach();
      };
      const aborted = () => finish(new StreamTransportError("Generation stream was aborted"));

      let finished = false;
      const finish = (error?: Error): void => {
        if (finished) {
          return;
        }
        finished = true;
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

export class StreamHeartbeat {
  readonly #intervalMilliseconds: number;
  readonly #writer: NdjsonWriter;
  #inFlight: Promise<void> | undefined;
  #stopped = true;
  #timer: ReturnType<typeof setTimeout> | undefined;

  constructor(writer: NdjsonWriter, intervalMilliseconds: number) {
    this.#writer = writer;
    this.#intervalMilliseconds = intervalMilliseconds;
  }

  start(): void {
    if (!this.#stopped || this.#writer.detached) {
      return;
    }
    this.#stopped = false;
    this.#schedule();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    await this.#inFlight;
  }

  #schedule(): void {
    if (this.#stopped) {
      return;
    }
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      const operation = this.#writer
        .write({ type: "stream.heartbeat" })
        .catch(() => {
          // The writer owns transport detachment. A rejected write is a workflow interrupt and
          // only stops this scheduler from enqueueing more heartbeats.
          this.#stopped = true;
        })
        .finally(() => {
          if (this.#inFlight === operation) {
            this.#inFlight = undefined;
          }
          this.#schedule();
        });
      this.#inFlight = operation;
    }, this.#intervalMilliseconds);
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
  readonly compactions?: CompactionService;
  readonly gateway: ModelGateway;
  readonly generations: GenerationService;
  readonly heartbeatIntervalMilliseconds?: number;
  readonly registry: ActiveStreamRegistry;
  readonly telemetry?:
    | Pick<
        ApplicationTelemetry,
        | "changeActiveEmployeeStreams"
        | "changeActiveProviderCalls"
        | "recordContextDecision"
        | "recordGeneration"
        | "recordResponseStarted"
        | "startModelCall"
      >
    | undefined;
}) {
  const { gateway, generations, registry } = dependencies;

  function observe(action: () => void): void {
    try {
      action();
    } catch {
      // Telemetry cannot affect streaming or durable recovery.
    }
  }

  async function stream(
    started: StartedResponse,
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const workflowStartedAt = performance.now();
    let assistantContent = "";
    let assistantBytes = 0;
    let accountingSettled = false;
    let firstTokenAt: Date | null = null;
    let providerGenerationId: string | null = null;
    let terminal = false;
    let usageLookupAttempted = false;
    let contextMode: TelemetryContextMode =
      started.request.derivedContext !== undefined
        ? "compacted"
        : started.contextWarning === true
          ? "fallback"
          : "full";
    let modelAccounting: GatewayAccounting | undefined;
    let modelCall: ModelCallTelemetry | undefined;
    let modelCallStartedAt = 0;
    let modelCallStoppedAt: number | undefined;
    let modelTransportDurationMilliseconds: number | undefined;
    let modelCancellationObserved = false;
    let modelOutcome: TelemetryOutcome = "failed";
    let modelOutcomeObserved = false;
    let modelUsage: GatewayUsage | undefined;
    let providerCallActive = false;
    let providerHeadersObserved = false;
    let providerTokenObserved = false;
    const promotion = promoteToStreamingResponse(request, () =>
      registry.register(started.generationId, () => ({
        content: assistantContent,
        firstTokenAt,
      })),
    );
    if (promotion.kind === "closed") {
      // The ordinary-request deadline already expired. Its connection has
      // been force-closed and process-owned resources may be shutting down,
      // so the durable admission is left for bounded reconciliation instead
      // of starting untracked cleanup behind the stream fence.
      return;
    }
    const lease = promotion.value;
    const gatewayController = new AbortController();
    // Downstream socket state never enters the provider abort signal: a detached browser
    // reattaches through durable updates while the generation continues.
    const gatewaySignal = AbortSignal.any([lease.signal, gatewayController.signal]);
    const heartbeatController = { stop: async (): Promise<void> => undefined };
    const writer = new NdjsonWriter(reply, lease.signal, () => {
      void heartbeatController.stop();
    });
    const heartbeat = new StreamHeartbeat(
      writer,
      dependencies.heartbeatIntervalMilliseconds ?? generationTuning.heartbeatMilliseconds,
    );
    heartbeatController.stop = () => heartbeat.stop();
    const checkpoints = new CheckpointScheduler(generations, started.generationId, Date.now());
    const durableAuthority = new DurableGenerationAuthority({
      intervalMilliseconds: generationTuning.durableStatePollMilliseconds,
      readState: () => generations.readState(started.generationId),
    });

    function startModelObservation(requestForGateway: GenerationRequest): void {
      modelCallStartedAt = performance.now();
      observe(() => {
        modelCall = dependencies.telemetry?.startModelCall({
          contextMode,
          generationId: started.generationId,
          privacyPolicyVersion:
            requestForGateway.route === undefined ? "not_applicable" : "openrouter-privacy-v1",
          purpose: "chat",
          tier: started.request.modelTier,
        });
      });
      observe(() => modelCall?.requestSent());
      providerCallActive = true;
      observe(() => dependencies.telemetry?.changeActiveProviderCalls("chat", 1));
    }

    function observeGatewayEvent(event: GatewayEvent): void {
      if (event.type === "response.headers" && !providerHeadersObserved) {
        providerHeadersObserved = true;
        observe(() =>
          modelCall?.responseStarted(
            gatewayTransportElapsedMilliseconds(event) ?? performance.now() - modelCallStartedAt,
          ),
        );
      }
      if (event.type === "content.delta" && !providerTokenObserved) {
        providerTokenObserved = true;
        observe(() =>
          modelCall?.firstToken(
            gatewayTransportElapsedMilliseconds(event) ?? performance.now() - modelCallStartedAt,
          ),
        );
      }
      if (event.type === "response.completed") {
        modelTransportDurationMilliseconds =
          gatewayTransportElapsedMilliseconds(event) ?? performance.now() - modelCallStartedAt;
        stopProviderObservation();
        modelOutcomeObserved = true;
        modelOutcome = "completed";
        modelUsage = event.usage;
        modelAccounting = event.accounting;
      } else if (event.type === "response.failed") {
        modelTransportDurationMilliseconds =
          gatewayTransportElapsedMilliseconds(event) ?? performance.now() - modelCallStartedAt;
        stopProviderObservation();
        modelOutcomeObserved = true;
        modelOutcome = event.providerOutcome === undefined ? "failed" : "completed";
        modelUsage = event.usage;
        modelAccounting = event.accounting?.actual;
      }
    }

    function settleModelObservation(fallbackOutcome: TelemetryOutcome): void {
      if (modelCall === undefined) {
        return;
      }
      stopProviderObservation();
      const providerDurationMs =
        modelTransportDurationMilliseconds ??
        (modelCallStoppedAt ?? performance.now()) - modelCallStartedAt;
      const settledCall = modelCall;
      modelCall = undefined;
      observe(() =>
        settledCall.settle({
          cachedTokens: modelAccounting?.cachedTokens,
          completionTokens: modelUsage?.outputTokens,
          costUsd: modelAccounting?.costUsd,
          outcome: modelOutcomeObserved ? modelOutcome : fallbackOutcome,
          promptTokens: modelUsage?.inputTokens,
          providerDurationMs,
          reasoningTokens: modelAccounting?.reasoningTokens,
        }),
      );
    }

    function stopProviderObservation(): void {
      modelCallStoppedAt ??= performance.now();
      if (!providerCallActive) {
        return;
      }
      providerCallActive = false;
      observe(() => dependencies.telemetry?.changeActiveProviderCalls("chat", -1));
    }

    function observeModelCancellation(): void {
      if (modelCancellationObserved) {
        return;
      }
      modelCancellationObserved = true;
      observe(() => modelCall?.cancelRequested());
    }

    const connectionClosed = (): void => {
      if (!reply.raw.writableFinished) {
        writer.detach();
      }
    };
    const connectionError = (): void => {
      writer.detach();
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
      if (
        (state.status === "failed" || state.status === "incomplete") &&
        state.errorCode !== null &&
        state.errorCode !== "STREAM_INTERRUPTED" &&
        state.assistantMessageId !== null &&
        state.revision !== null &&
        isWritable(reply)
      ) {
        await writer.write({
          errorCode: state.errorCode,
          messageId: state.assistantMessageId,
          partial: state.status === "incomplete",
          revision: state.revision,
          type: "response.failed",
        });
        return true;
      }
      return isTerminalGenerationStatus(state.status);
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
      modelUsage = usage;
      modelAccounting = accounting;
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
      if (event.type === "response.headers") {
        return;
      }
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

    if (started.request.route !== undefined) {
      durableAuthority.startMonitor(() => gatewayController.abort("durable-terminal"));
    }

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

    async function runNaming(
      naming: NamingHandoff,
      assistantMessageId: string,
      reason: ResponseCompletedEvent["reason"],
      usage: GatewayUsage,
    ): Promise<void> {
      await writer.write({ type: "conversation.naming" }).catch(() => undefined);
      const fallbackCancellation = new AbortController();
      const providerDeadline = new AbortController();
      const namingSignal = AbortSignal.any([gatewaySignal, providerDeadline.signal]);
      const timeoutOutcome: TitleOutcome = {
        errorCode: "GENERATION_TIMEOUT",
        kind: "failed",
      };

      function waitUntil(at: Date, signal: AbortSignal): Promise<void> {
        signal.throwIfAborted();
        const remaining = at.getTime() - Date.now();
        if (remaining <= 0) {
          return Promise.resolve();
        }
        return new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => finish(), remaining);
          const aborted = () => finish(signal.reason);
          const finish = (error?: unknown): void => {
            clearTimeout(timer);
            signal.removeEventListener("abort", aborted);
            if (error === undefined) {
              resolve();
            } else {
              reject(error);
            }
          };
          signal.addEventListener("abort", aborted, { once: true });
        });
      }

      function finishBeforeDeadline<TResult>(
        deadlineAt: Date,
        operation: () => Promise<TResult>,
      ): Promise<TResult> {
        const remainingMilliseconds = deadlineAt.getTime() - Date.now();
        if (remainingMilliseconds <= 0) {
          return Promise.reject(new Error("The title persistence deadline elapsed"));
        }
        let attempt: Promise<TResult>;
        try {
          attempt = operation();
        } catch (error: unknown) {
          return Promise.reject(error);
        }
        return new Promise<TResult>((resolve, reject) => {
          let finished = false;
          const finish = (result: { readonly error?: unknown; readonly value?: TResult }): void => {
            if (finished) {
              return;
            }
            finished = true;
            clearTimeout(timer);
            if ("error" in result) {
              reject(result.error);
            } else {
              resolve(result.value as TResult);
            }
          };
          const timer = setTimeout(
            () => finish({ error: new Error("The title persistence deadline elapsed") }),
            remainingMilliseconds,
          );
          attempt.then(
            (value) => finish({ value }),
            (error: unknown) => finish({ error }),
          );
        });
      }

      const finalize = (outcome: TitleOutcome) =>
        finishBeforeDeadline(naming.deadlineAt, () =>
          generations.finalizeNaming({
            conversationId: started.conversationId,
            outcome,
            parentGenerationId: started.generationId,
            persistenceDeadlineAt: naming.deadlineAt,
            titleGenerationId: naming.titleGenerationId,
          }),
        );

      async function settleLateProviderAccounting(outcome: TitleOutcome): Promise<void> {
        if (outcome.accounting === undefined || outcome.usage === undefined) {
          return;
        }
        // Deletion intentionally clears the retained title row's conversation link. Settle known
        // provider usage by generation ID when lifecycle finalization cannot retain authority, without
        // extending the response's eight-second naming fence.
        await generations.settleLateTitleAccounting(
          naming.titleGenerationId,
          outcome.usage,
          outcome.accounting,
          {
            ...(outcome.firstTokenAt === undefined ? {} : { firstTokenAt: outcome.firstTokenAt }),
            ...(outcome.metadata === undefined ? {} : { metadata: outcome.metadata }),
          },
        );
      }

      // The provider owns only the first seven seconds. The fallback begins at that cutoff so the
      // final second remains available for one transaction bounded by the absolute eight-second
      // fence. A failed bounded attempt is left to the independent durable reconciler.
      const fallback = (async () => {
        await waitUntil(naming.providerDeadlineAt, fallbackCancellation.signal);
        if (!providerDeadline.signal.aborted) {
          providerDeadline.abort("title-provider-deadline");
        }
        return finalize(timeoutOutcome);
      })();

      const providerOutcome =
        Date.now() >= naming.providerDeadlineAt.getTime()
          ? undefined
          : (async () => {
              let outcome: TitleOutcome;
              try {
                outcome = await runTitleGeneration(
                  gateway,
                  naming.request,
                  namingSignal,
                  dependencies.telemetry,
                  naming.titleGenerationId,
                  (observation) =>
                    generations.recordTitleObservation(naming.titleGenerationId, observation),
                );
              } catch {
                outcome = { errorCode: "GENERATION_FAILED", kind: "failed" };
              }
              if (
                outcome.kind === "cancelled" &&
                providerDeadline.signal.aborted &&
                !gatewaySignal.aborted
              ) {
                outcome = {
                  ...(outcome.accounting === undefined ? {} : { accounting: outcome.accounting }),
                  errorCode: "GENERATION_TIMEOUT",
                  ...(outcome.firstTokenAt === undefined
                    ? {}
                    : { firstTokenAt: outcome.firstTokenAt }),
                  kind: "failed",
                  ...(outcome.metadata === undefined ? {} : { metadata: outcome.metadata }),
                  ...(outcome.usage === undefined ? {} : { usage: outcome.usage }),
                };
              }
              return outcome;
            })();
      const provider = providerOutcome?.then((outcome) => finalize(outcome));
      if (providerOutcome !== undefined && provider !== undefined) {
        // Register the continuation before the HTTP stream can release its lease. Shutdown then
        // keeps the database pool alive until a lost/failed bounded finalizer has persisted any
        // authoritative provider accounting; the response still races only `provider` itself.
        lease.defer(
          (async () => {
            const outcome = await providerOutcome;
            try {
              const result = await provider;
              if (result.kind === "lost-cas") {
                await settleLateProviderAccounting(outcome);
              }
            } catch {
              await settleLateProviderAccounting(outcome);
            }
          })(),
        );
      }

      let finalization: Awaited<ReturnType<GenerationService["finalizeNaming"]>> | undefined;
      try {
        if (provider === undefined) {
          finalization = await fallback;
        } else {
          const resolution = await Promise.race([
            provider
              .then((result) => ({ result, source: "provider" as const }))
              .catch(() => fallback.then((result) => ({ result, source: "fallback" as const }))),
            fallback.then((result) => ({ result, source: "fallback" as const })),
          ]);
          finalization = resolution.result;
          if (resolution.source === "provider") {
            fallbackCancellation.abort("title-finalized");
          }
        }
      } catch {
        finalization = undefined;
      } finally {
        fallbackCancellation.abort("title-stream-settled");
      }

      let revision = finalization?.kind === "finalized" ? finalization.revision : null;
      if (revision === null) {
        const remainingMilliseconds = naming.deadlineAt.getTime() - Date.now();
        let state: Awaited<ReturnType<typeof durableAuthority.stateForEvent>> | null = null;
        let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
        if (remainingMilliseconds > 0) {
          const stateRead = durableAuthority.stateForEvent(true).catch(() => null);
          state = await Promise.race([
            stateRead,
            new Promise<null>((resolve) => {
              deadlineTimer = setTimeout(resolve, remainingMilliseconds, null);
            }),
          ]).finally(() => {
            if (deadlineTimer !== undefined) {
              clearTimeout(deadlineTimer);
            }
          });
        }
        if (
          state?.status === "completed" &&
          state.assistantMessageId !== null &&
          state.revision !== null
        ) {
          revision = state.revision;
        } else if (state !== null && isTerminalGenerationStatus(state.status)) {
          terminal = await durableTerminalEvent(state).catch(() => true);
        }
      }
      if (revision !== null && isWritable(reply)) {
        await writer
          .write({
            messageId: assistantMessageId,
            reason,
            revision,
            type: "response.completed",
            usage,
          })
          .catch(() => undefined);
      }
    }

    try {
      observe(() =>
        dependencies.telemetry?.changeActiveEmployeeStreams(started.request.modelTier, 1),
      );
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
      heartbeat.start();
      observe(() =>
        dependencies.telemetry?.recordResponseStarted(
          started.request.modelTier,
          "chat",
          Date.now() - started.admittedAt.getTime(),
        ),
      );

      // Cancellation can commit after admission but before this process registers the stream.
      // Force the durable fence before compaction or the provider so a missed local abort cannot
      // spend or publish content for work that is already terminal.
      const admittedState = await durableAuthority.stateForEvent(true);
      const expectedAdmissionStatus = started.compaction === undefined ? "active" : "preparing";
      if (admittedState === null) {
        return;
      }
      if (admittedState.status !== expectedAdmissionStatus) {
        if (isTerminalGenerationStatus(admittedState.status)) {
          terminal = await durableTerminalEvent(admittedState);
        }
        return;
      }

      let chatRequest: GenerationRequest = started.request;
      if (started.compaction !== undefined) {
        if (dependencies.compactions === undefined) {
          throw new Error("A pending context plan requires the compaction service");
        }
        await writer.write({ type: "context.compacting" });
        const result = await dependencies.compactions.execute(
          {
            chatGenerationId: started.generationId,
            conversationId: started.conversationId,
            ...started.compaction,
          },
          gatewaySignal,
        );
        if (result.kind === "cancelled") {
          const state = await durableAuthority.stateForEvent(true);
          if (state !== null) {
            terminal = await durableTerminalEvent(state);
          }
          return;
        }
        // The silent monitor may have cached the chat's pre-compaction `preparing` state. Promotion
        // is durable before execute returns, so refresh that lifecycle boundary before any chat
        // event can rely on the sampler's normal freshness window.
        const promotedState = await durableAuthority.stateForEvent(true);
        if (promotedState === null) {
          throw new GatewayOutputError("GENERATION_FAILED");
        }
        if (promotedState.status === "preparing") {
          throw new GatewayOutputError("GENERATION_FAILED");
        }
        if (promotedState.status !== "active") {
          terminal = await durableTerminalEvent(promotedState);
          return;
        }
        chatRequest = {
          ...result.chat.request,
          ...(started.request.route === undefined ? {} : { route: started.request.route }),
        };
        contextMode = result.kind === "compacted" ? "compacted" : "fallback";
        await writer.write(
          result.kind === "compacted"
            ? { type: "context.compacted" }
            : { code: "CONTEXT_COMPACTION_FALLBACK", type: "context.warning" },
        );
      } else if (started.contextWarning === true) {
        await writer.write({
          code: "CONTEXT_COMPACTION_FALLBACK",
          type: "context.warning",
        });
      }

      observe(() =>
        dependencies.telemetry?.recordContextDecision(started.request.modelTier, contextMode),
      );
      startModelObservation(chatRequest);

      for await (const event of gateway.stream(chatRequest, gatewaySignal)) {
        observeGatewayEvent(event);
        if (event.type === "response.headers") {
          continue;
        }
        const state = await durableAuthority.stateForEvent();
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
          const cancelledState = await durableAuthority.stateForEvent(true);
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
        if (result.won && result.naming !== undefined && result.assistantMessageId !== null) {
          accountingSettled = event.accounting !== undefined || accountingSettled;
          await runNaming(result.naming, result.assistantMessageId, event.reason, event.usage);
        } else if (result.won && result.assistantMessageId !== null && result.revision !== null) {
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
      stopProviderObservation();

      if (!terminal) {
        await fail("GENERATION_FAILED");
        terminal = true;
      }
    } catch (error: unknown) {
      stopProviderObservation();
      modelOutcome = isAbortError(error) || gatewaySignal.aborted ? "cancelled" : "failed";
      modelOutcomeObserved = true;
      const state = await durableAuthority.stateForEvent(true).catch(() => null);
      if (lease.signal.aborted || state?.status === "cancelled") {
        observeModelCancellation();
      }
      if (state !== null && isTerminalGenerationStatus(state.status)) {
        terminal = await durableTerminalEvent(state).catch(() => true);
      } else if (state?.status === "finalizing") {
        // The answer is durable and the naming phase owns the parent; bounded reconciliation
        // completes it if this producer cannot.
        terminal = true;
      } else if (state?.status === "active") {
        const interrupted =
          lease.signal.aborted || error instanceof StreamTransportError || isAbortError(error);
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
          if (!interrupted && isWritable(reply) && !writer.detached) {
            await emitFailure(failureCode, committed).catch(() => undefined);
          }
        } else if (committed !== undefined) {
          terminal = await durableTerminalEvent(committed).catch(() => true);
        }
      } else if (state?.status === "preparing" && started.compaction !== undefined) {
        await dependencies.compactions?.cancel({
          chatGenerationId: started.generationId,
          conversationId: started.conversationId,
          ...started.compaction,
        });
        const cancelled = await durableAuthority.stateForEvent(true).catch(() => null);
        if (cancelled !== null) {
          terminal = await durableTerminalEvent(cancelled).catch(() => true);
        }
      }
    } finally {
      try {
        await heartbeat.stop();
        if (!gatewayController.signal.aborted) {
          gatewayController.abort("disconnect");
        }
        await durableAuthority.stop();
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
        const finalState = await durableAuthority.stateForEvent(true).catch(() => null);
        const workflowOutcome: TelemetryOutcome =
          finalState?.status === "completed" || finalState?.status === "finalizing"
            ? "completed"
            : finalState?.status === "cancelled"
              ? "cancelled"
              : finalState?.status === "incomplete"
                ? "incomplete"
                : "failed";
        if (workflowOutcome === "cancelled") {
          observeModelCancellation();
        }
        stopProviderObservation();
        settleModelObservation(workflowOutcome);
        observe(() =>
          dependencies.telemetry?.recordGeneration(
            started.request.modelTier,
            "chat",
            workflowOutcome,
            performance.now() - workflowStartedAt,
          ),
        );
        observe(() =>
          dependencies.telemetry?.changeActiveEmployeeStreams(started.request.modelTier, -1),
        );
      } finally {
        lease.release();
      }
    }
  }

  return Object.freeze({ stream });
}

export type ResponseStreamCoordinator = ReturnType<typeof createResponseStreamCoordinator>;

import { createParser, type EventSourceMessage } from "eventsource-parser";
import { hasUnsupportedControlCharacter } from "../conversations/content.js";
import type {
  GatewayAccounting,
  GatewayCompletionReason,
  GatewayEvent,
  GatewayFailureCode,
  GatewayProviderErrorType,
  GatewayProviderMetadata,
  GatewayUsage,
  GatewayUsageLookupResult,
  GenerationAccountingGateway,
  GenerationModelRoute,
  GenerationRequest,
  ModelGateway,
} from "../generations/model-gateway.js";
import {
  createGatewayTransportClock,
  generationRequestMessages,
} from "../generations/model-gateway.js";
import { canonicalUsd, unitPricePerMillion } from "../model-policy/money.js";
import {
  canonicalProviderDecimal,
  isOpenRouterChatChunk,
  isOpenRouterErrorEnvelope,
  isOpenRouterGenerationLookup,
  type OpenRouterChatChunk,
  type OpenRouterUsage,
  readBoundedJson,
  safeProviderIdentifier,
  sanitizedProviderErrorType,
} from "./provider-contract.js";
import { openRouterTuning } from "./settings.js";

const chatCompletionsUrl = "https://openrouter.ai/api/v1/chat/completions";
const generationLookupUrl = "https://openrouter.ai/api/v1/generation";

const deterministicNoSpendProviderErrors = new Set<GatewayProviderErrorType>([
  "authentication",
  "context_length_exceeded",
  "invalid_prompt",
  "invalid_request",
  "max_tokens_exceeded",
  "not_found",
  "payment_required",
  "payload_too_large",
  "permission_denied",
  "precondition_failed",
  "string_too_long",
  "token_limit_exceeded",
  "unprocessable",
]);

export type OpenRouterFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

interface AdapterFailure {
  readonly accounting: {
    readonly actual?: GatewayAccounting;
    readonly metadata?: GatewayProviderMetadata;
    readonly spendRisk: "none" | "unknown";
  };
  readonly errorCode: GatewayFailureCode;
  readonly providerErrorType?: GatewayProviderErrorType;
  readonly providerOutcome?: "content_filter" | "refusal";
  readonly usageLookupAttempted?: boolean;
  readonly usage?: GatewayUsage;
}

interface NormalizedUsage {
  readonly accounting: GatewayAccounting;
  readonly usage: GatewayUsage;
}

interface RequestRoute {
  readonly completionMaximumPerMillion: string;
  readonly maximumOutputTokens: number;
  readonly promptMaximumPerMillion: string;
  readonly requestMaximum: string;
  readonly requestedModel: string;
}

class OpenRouterAdapterError extends Error {
  readonly failure: AdapterFailure;

  constructor(failure: AdapterFailure) {
    super("OpenRouter returned an unusable provider contract");
    this.name = "OpenRouterAdapterError";
    this.failure = failure;
  }
}

function abortError(reason: unknown): Error {
  if (reason instanceof Error) {
    return reason;
  }
  return new DOMException("The OpenRouter request was aborted", "AbortError");
}

function setAbortTimer(
  controller: AbortController,
  milliseconds: number,
): ReturnType<typeof setTimeout> {
  return setTimeout(() => {
    controller.abort(new DOMException("The OpenRouter request timed out", "TimeoutError"));
  }, milliseconds);
}

function clearTimer(timer: ReturnType<typeof setTimeout> | null): void {
  if (timer !== null) {
    clearTimeout(timer);
  }
}

function localFailure(): OpenRouterAdapterError {
  return new OpenRouterAdapterError({
    accounting: { spendRisk: "none" },
    errorCode: "GENERATION_FAILED",
  });
}

function ambiguousFailure(
  errorCode: GatewayFailureCode,
  metadata?: GatewayProviderMetadata,
  providerErrorType?: GatewayProviderErrorType,
  providerOutcome?: "content_filter" | "refusal",
  usageLookupAttempted?: boolean,
): OpenRouterAdapterError {
  return new OpenRouterAdapterError({
    accounting: {
      ...(metadata === undefined || Object.keys(metadata).length === 0 ? {} : { metadata }),
      spendRisk: "unknown",
    },
    errorCode,
    ...(providerErrorType === undefined ? {} : { providerErrorType }),
    ...(providerOutcome === undefined ? {} : { providerOutcome }),
    ...(usageLookupAttempted === undefined ? {} : { usageLookupAttempted }),
  });
}

function noSpendFailure(
  errorCode: GatewayFailureCode,
  metadata?: GatewayProviderMetadata,
  providerErrorType?: GatewayProviderErrorType,
  providerOutcome?: "content_filter" | "refusal",
): OpenRouterAdapterError {
  return new OpenRouterAdapterError({
    accounting: {
      ...(metadata === undefined || Object.keys(metadata).length === 0 ? {} : { metadata }),
      spendRisk: "none",
    },
    errorCode,
    ...(providerErrorType === undefined ? {} : { providerErrorType }),
    ...(providerOutcome === undefined ? {} : { providerOutcome }),
  });
}

function failureEvent(failure: AdapterFailure): GatewayEvent {
  return {
    accounting: failure.accounting,
    errorCode: failure.errorCode,
    ...(failure.providerErrorType === undefined
      ? {}
      : { providerErrorType: failure.providerErrorType }),
    ...(failure.providerOutcome === undefined ? {} : { providerOutcome: failure.providerOutcome }),
    ...(failure.usageLookupAttempted === undefined
      ? {}
      : { usageLookupAttempted: failure.usageLookupAttempted }),
    type: "response.failed",
    ...(failure.usage === undefined ? {} : { usage: failure.usage }),
  };
}

function withAuthoritativeUsage(
  failure: AdapterFailure,
  authoritative: NormalizedUsage | null,
): AdapterFailure {
  if (authoritative === null) {
    return failure;
  }
  return {
    ...failure,
    accounting: {
      ...failure.accounting,
      actual: authoritative.accounting,
    },
    usage: authoritative.usage,
  };
}

function priceForWire(value: string, perMillion: boolean): string | null {
  let wireValue: string;
  try {
    wireValue = perMillion ? unitPricePerMillion(value) : canonicalUsd(value);
  } catch {
    return null;
  }
  return canonicalProviderDecimal(wireValue, {
    maximumPrecision: 38,
    maximumScale: perMillion ? 24 : 18,
  });
}

function normalizeRoute(route: GenerationModelRoute | undefined): RequestRoute {
  if (
    route === undefined ||
    safeProviderIdentifier(route.requestedModel) === null ||
    !/^[^/\s]+\/[^/\s]+$/u.test(route.requestedModel) ||
    !Number.isSafeInteger(route.maximumOutputTokens) ||
    route.maximumOutputTokens <= 0
  ) {
    throw localFailure();
  }
  const promptMaximumPerMillion = priceForWire(route.promptPriceCeilingUsdPerToken, true);
  const completionMaximumPerMillion = priceForWire(route.completionPriceCeilingUsdPerToken, true);
  const requestMaximum = priceForWire(route.requestPriceCeilingUsd, false);
  if (
    promptMaximumPerMillion === null ||
    completionMaximumPerMillion === null ||
    requestMaximum === null
  ) {
    throw localFailure();
  }
  return {
    completionMaximumPerMillion,
    maximumOutputTokens: route.maximumOutputTokens,
    promptMaximumPerMillion,
    requestMaximum,
    requestedModel: route.requestedModel,
  };
}

function requestBody(request: GenerationRequest, route: RequestRoute): Record<string, unknown> {
  const messages = generationRequestMessages(request);
  if (
    messages.some(
      (message) =>
        !message.content.isWellFormed() || hasUnsupportedControlCharacter(message.content),
    )
  ) {
    throw localFailure();
  }
  return {
    max_tokens: route.maximumOutputTokens,
    messages,
    model: route.requestedModel,
    provider: {
      data_collection: "deny",
      max_price: {
        completion: route.completionMaximumPerMillion,
        prompt: route.promptMaximumPerMillion,
        request: route.requestMaximum,
      },
      require_parameters: true,
      zdr: true,
    },
    reasoning: { exclude: true },
    stream: true,
  };
}

function metadataFrom(
  current: GatewayProviderMetadata,
  values: { readonly id?: unknown; readonly model?: unknown; readonly provider?: unknown },
): GatewayProviderMetadata {
  const providerGenerationId =
    values.id === undefined ? current.providerGenerationId : safeProviderIdentifier(values.id);
  const resolvedModel =
    values.model === undefined ? current.resolvedModel : safeProviderIdentifier(values.model);
  const provider =
    values.provider === undefined ? current.provider : safeProviderIdentifier(values.provider);
  if (
    (values.id !== undefined && providerGenerationId === null) ||
    (values.model !== undefined && resolvedModel === null) ||
    (values.provider !== undefined && provider === null)
  ) {
    throw ambiguousFailure("GENERATION_FAILED", current);
  }
  if (
    current.providerGenerationId !== undefined &&
    providerGenerationId !== undefined &&
    current.providerGenerationId !== providerGenerationId
  ) {
    throw ambiguousFailure("GENERATION_FAILED", current);
  }
  return {
    ...(provider === undefined || provider === null ? {} : { provider }),
    ...(providerGenerationId === undefined || providerGenerationId === null
      ? {}
      : { providerGenerationId }),
    ...(resolvedModel === undefined || resolvedModel === null ? {} : { resolvedModel }),
  };
}

function metadataChanged(
  previous: GatewayProviderMetadata,
  next: GatewayProviderMetadata,
): boolean {
  return (
    previous.provider !== next.provider ||
    previous.providerGenerationId !== next.providerGenerationId ||
    previous.resolvedModel !== next.resolvedModel
  );
}

function metadataChangesAfterContent(
  previous: GatewayProviderMetadata,
  next: GatewayProviderMetadata,
): boolean {
  return (
    (previous.provider !== undefined && previous.provider !== next.provider) ||
    (previous.resolvedModel !== undefined && previous.resolvedModel !== next.resolvedModel)
  );
}

function completionReason(value: unknown): GatewayCompletionReason | null {
  switch (value) {
    case "stop":
    case "length":
    case "refusal":
      return value;
    case "content_filter":
      return "content_filter";
    case null:
    case undefined:
      return null;
    default:
      throw ambiguousFailure("GENERATION_FAILED");
  }
}

function optionalTokenCount(value: number | null | undefined): number | undefined {
  return value === null || value === undefined ? undefined : value;
}

function normalizeUsage(
  usage: OpenRouterUsage,
  metadata: GatewayProviderMetadata,
): NormalizedUsage {
  const costUsd = canonicalProviderDecimal(usage.cost, {
    maximumPrecision: 38,
    maximumScale: 18,
  });
  if (costUsd === null) {
    throw ambiguousFailure("GENERATION_FAILED", metadata);
  }
  const cachedTokens = optionalTokenCount(usage.prompt_tokens_details?.cached_tokens);
  const reasoningTokens = optionalTokenCount(usage.completion_tokens_details?.reasoning_tokens);
  return {
    accounting: {
      ...(cachedTokens === undefined ? {} : { cachedTokens }),
      costUsd,
      metadata,
      ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
    },
    usage: {
      inputTokens: usage.prompt_tokens,
      outputTokens: usage.completion_tokens,
    },
  };
}

function errorTypeFromEnvelope(value: unknown): GatewayProviderErrorType {
  if (!isOpenRouterErrorEnvelope(value)) {
    return "unmapped";
  }
  return sanitizedProviderErrorType(value.error.metadata?.error_type);
}

function failureForProviderError(
  providerErrorType: GatewayProviderErrorType,
  metadata: GatewayProviderMetadata,
  actual?: NormalizedUsage,
  phase: "pre-provider" | "stream" = "stream",
): OpenRouterAdapterError {
  const withActual = (error: OpenRouterAdapterError): OpenRouterAdapterError => {
    if (actual === undefined) {
      return error;
    }
    return new OpenRouterAdapterError({
      ...error.failure,
      accounting: {
        ...error.failure.accounting,
        actual: actual.accounting,
      },
      usage: actual.usage,
    });
  };
  const classifiedFailure = (
    errorCode: GatewayFailureCode,
    providerOutcome?: "content_filter" | "refusal",
  ): OpenRouterAdapterError =>
    phase === "pre-provider" && deterministicNoSpendProviderErrors.has(providerErrorType)
      ? noSpendFailure(errorCode, metadata, providerErrorType, providerOutcome)
      : ambiguousFailure(errorCode, metadata, providerErrorType, providerOutcome);
  if (providerErrorType === "refusal") {
    return withActual(classifiedFailure("GENERATION_FAILED", "refusal"));
  }
  if (providerErrorType === "content_policy_violation") {
    return withActual(classifiedFailure("GENERATION_FAILED", "content_filter"));
  }
  if (providerErrorType === "timeout") {
    return withActual(classifiedFailure("GENERATION_TIMEOUT"));
  }
  if (
    providerErrorType === "not_found" ||
    providerErrorType === "provider_overloaded" ||
    providerErrorType === "provider_unavailable" ||
    providerErrorType === "rate_limit_exceeded"
  ) {
    return withActual(classifiedFailure("MODEL_UNAVAILABLE"));
  }
  return withActual(classifiedFailure("GENERATION_FAILED"));
}

function contentFromChunk(chunk: OpenRouterChatChunk): string | null {
  const choice = chunk.choices?.[0];
  if (choice === undefined) {
    return null;
  }
  if (choice.index !== undefined && choice.index !== 0) {
    throw ambiguousFailure("GENERATION_FAILED");
  }
  const delta = choice.delta as Record<string, unknown> | undefined;
  if (
    delta !== undefined &&
    (("tool_calls" in delta && delta.tool_calls != null) ||
      ("function_call" in delta && delta.function_call != null))
  ) {
    throw ambiguousFailure("GENERATION_FAILED");
  }
  const content = choice.delta?.content;
  const refusal = choice.delta?.refusal;
  if (
    typeof content === "string" &&
    content.length > 0 &&
    typeof refusal === "string" &&
    refusal.length > 0
  ) {
    throw ambiguousFailure("GENERATION_FAILED");
  }
  const text = typeof content === "string" && content.length > 0 ? content : refusal;
  if (typeof text !== "string" || text.length === 0) {
    return null;
  }
  if (!text.isWellFormed() || hasUnsupportedControlCharacter(text)) {
    throw ambiguousFailure("GENERATION_FAILED");
  }
  return text;
}

export class OpenRouterGateway implements ModelGateway, GenerationAccountingGateway {
  readonly #apiKey: string;
  readonly #fetch: OpenRouterFetch;

  constructor(options: { readonly apiKey: string; readonly fetch?: OpenRouterFetch }) {
    if (options.apiKey.trim().length === 0) {
      throw new Error("OpenRouterGateway requires a non-empty API key");
    }
    this.#apiKey = options.apiKey;
    this.#fetch = options.fetch ?? fetch;
  }

  async *stream(request: GenerationRequest, signal: AbortSignal): AsyncIterable<GatewayEvent> {
    let transportClock: ReturnType<typeof createGatewayTransportClock> | undefined;
    const totalController = new AbortController();
    const headerController = new AbortController();
    const activityController = new AbortController();
    const totalTimer = setAbortTimer(totalController, openRouterTuning.totalTimeoutMilliseconds);
    let headerTimer: ReturnType<typeof setTimeout> | null = setAbortTimer(
      headerController,
      openRouterTuning.headerTimeoutMilliseconds,
    );
    let firstTokenTimer: ReturnType<typeof setTimeout> | null = null;
    let inactivityTimer: ReturnType<typeof setTimeout> | null = null;
    let submitted = false;
    let metadata: GatewayProviderMetadata = {};
    let normalizedUsage: NormalizedUsage | null = null;
    let emittedVisibleContent = false;
    try {
      signal.throwIfAborted();
      const route = normalizeRoute(request.route);
      const body = requestBody(request, route);
      const serializedBody = JSON.stringify(body);
      const upstreamSignal = AbortSignal.any([
        signal,
        totalController.signal,
        headerController.signal,
        activityController.signal,
      ]);
      transportClock = createGatewayTransportClock();
      submitted = true;
      const response = await this.#fetch(chatCompletionsUrl, {
        body: serializedBody,
        headers: {
          accept: "text/event-stream",
          authorization: `Bearer ${this.#apiKey}`,
          "content-type": "application/json",
        },
        method: "POST",
        signal: upstreamSignal,
      });
      const responseHeadersElapsedMilliseconds = transportClock.elapsedMilliseconds();
      clearTimer(headerTimer);
      headerTimer = null;
      const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
      const successfulSseResponse =
        response.ok && contentType.startsWith("text/event-stream") && response.body !== null;
      if (successfulSseResponse) {
        firstTokenTimer = setAbortTimer(
          activityController,
          openRouterTuning.firstVisibleTokenTimeoutMilliseconds,
        );
      }
      yield* transportClock.publish({
        transportElapsedMilliseconds: responseHeadersElapsedMilliseconds,
        type: "response.headers",
      });
      const headerGenerationId = response.headers.get("x-generation-id");
      if (headerGenerationId !== null) {
        metadata = metadataFrom(metadata, { id: headerGenerationId });
      }
      if (!response.ok) {
        const payload = await readBoundedJson(response, openRouterTuning.maximumErrorBodyBytes);
        signal.throwIfAborted();
        throw failureForProviderError(
          errorTypeFromEnvelope(payload),
          metadata,
          undefined,
          "pre-provider",
        );
      }
      if (!successfulSseResponse || response.body === null) {
        await response.body?.cancel().catch(() => undefined);
        throw ambiguousFailure("GENERATION_FAILED", metadata);
      }
      if (Object.keys(metadata).length > 0) {
        yield* transportClock.publish({ metadata, type: "generation.metadata" });
      }

      const resetInactivity = (): void => {
        clearTimer(inactivityTimer);
        inactivityTimer = setAbortTimer(
          activityController,
          openRouterTuning.inactivityTimeoutMilliseconds,
        );
      };
      resetInactivity();

      const parsedEvents: EventSourceMessage[] = [];
      let queuedEventBytes = 0;
      let parserFailed = false;
      let done = false;
      const parser = createParser({
        maxBufferSize: openRouterTuning.maximumSseEventBytes,
        onError: () => {
          parserFailed = true;
        },
        onEvent: (event) => {
          const eventBytes = Buffer.byteLength(event.data, "utf8");
          if (
            done ||
            eventBytes > openRouterTuning.maximumSseEventBytes ||
            parsedEvents.length >= openRouterTuning.maximumSseQueueEvents ||
            queuedEventBytes + eventBytes > openRouterTuning.maximumSseQueueBytes
          ) {
            parserFailed = true;
            return;
          }
          parsedEvents.push(event);
          queuedEventBytes += eventBytes;
        },
      });
      const reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8", { fatal: true });
      let reachedEndOfBody = false;
      let terminalReason: GatewayCompletionReason | null = null;
      try {
        while (!done) {
          const result = await reader.read();
          if (result.done) {
            reachedEndOfBody = true;
            parser.reset({ consume: true });
            break;
          }
          resetInactivity();
          parser.feed(decoder.decode(result.value, { stream: true }));
          if (parserFailed) {
            throw ambiguousFailure("GENERATION_FAILED", metadata);
          }
          while (parsedEvents.length > 0) {
            const event = parsedEvents.shift();
            if (event === undefined) {
              break;
            }
            queuedEventBytes -= Buffer.byteLength(event.data, "utf8");
            if (event.data === "[DONE]") {
              if (parsedEvents.length > 0) {
                throw ambiguousFailure("GENERATION_FAILED", metadata);
              }
              done = true;
              break;
            }
            if (normalizedUsage !== null) {
              throw ambiguousFailure("GENERATION_FAILED", metadata);
            }
            if (event.event !== undefined && event.event !== "message" && event.event !== "error") {
              throw ambiguousFailure("GENERATION_FAILED", metadata);
            }
            let payload: unknown;
            try {
              payload = JSON.parse(event.data) as unknown;
            } catch {
              throw ambiguousFailure("GENERATION_FAILED", metadata);
            }
            if (!isOpenRouterChatChunk(payload)) {
              throw ambiguousFailure("GENERATION_FAILED", metadata);
            }
            const nextMetadata = metadataFrom(metadata, {
              ...(payload.id === undefined ? {} : { id: payload.id }),
              ...(payload.model === undefined ? {} : { model: payload.model }),
              ...(payload.provider === undefined ? {} : { provider: payload.provider }),
            });
            const providerMetadataChanged = metadataChanged(metadata, nextMetadata);
            if (providerMetadataChanged) {
              if (emittedVisibleContent && metadataChangesAfterContent(metadata, nextMetadata)) {
                throw ambiguousFailure("GENERATION_FAILED", metadata);
              }
              metadata = nextMetadata;
            }
            const eventUsage =
              payload.usage === undefined ? undefined : normalizeUsage(payload.usage, metadata);
            if (payload.error !== undefined) {
              if (providerMetadataChanged) {
                yield* transportClock.publish({ metadata, type: "generation.metadata" });
              }
              throw failureForProviderError(
                errorTypeFromEnvelope({ error: payload.error }),
                metadata,
                eventUsage,
              );
            }
            const reason = completionReason(payload.choices?.[0]?.finish_reason);
            if (reason !== null) {
              if (terminalReason !== null && terminalReason !== reason) {
                throw ambiguousFailure("GENERATION_FAILED", metadata);
              }
              terminalReason = reason;
            }
            if (eventUsage !== undefined) {
              if (normalizedUsage !== null) {
                throw ambiguousFailure("GENERATION_FAILED", metadata);
              }
              normalizedUsage = eventUsage;
            }
            const text = contentFromChunk(payload);
            let firstTokenElapsedMilliseconds: number | undefined;
            if (text !== null && !emittedVisibleContent) {
              clearTimer(firstTokenTimer);
              firstTokenTimer = null;
              firstTokenElapsedMilliseconds = transportClock.elapsedMilliseconds();
            }
            if (providerMetadataChanged) {
              yield* transportClock.publish({ metadata, type: "generation.metadata" });
            }
            if (text !== null) {
              emittedVisibleContent = true;
              yield* transportClock.publish({
                text,
                ...(firstTokenElapsedMilliseconds === undefined
                  ? {}
                  : { transportElapsedMilliseconds: firstTokenElapsedMilliseconds }),
                type: "content.delta",
              });
            }
          }
        }
        decoder.decode();
      } finally {
        if (!reachedEndOfBody) {
          // Protocol completion and rejection can both precede transport EOF.
          await reader.cancel().catch(() => undefined);
        }
        reader.releaseLock();
      }
      if (parserFailed || !done || terminalReason === null) {
        throw ambiguousFailure("GENERATION_FAILED", metadata);
      }
      if (normalizedUsage === null || normalizedUsage.accounting.metadata.provider === undefined) {
        clearTimer(totalTimer);
        const providerGenerationId = metadata.providerGenerationId;
        if (providerGenerationId === undefined) {
          throw ambiguousFailure("GENERATION_FAILED", metadata);
        }
        const lookup = await this.lookupUsage(providerGenerationId, signal);
        if (lookup.status === "unavailable") {
          throw ambiguousFailure("GENERATION_FAILED", metadata, undefined, undefined, true);
        }
        let nextMetadata: GatewayProviderMetadata;
        try {
          nextMetadata = metadataFrom(metadata, {
            id: lookup.accounting.metadata.providerGenerationId,
            model: lookup.accounting.metadata.resolvedModel,
            provider: lookup.accounting.metadata.provider,
          });
        } catch (error: unknown) {
          if (error instanceof OpenRouterAdapterError) {
            throw new OpenRouterAdapterError({
              ...error.failure,
              usageLookupAttempted: true,
            });
          }
          throw error;
        }
        if (emittedVisibleContent && metadataChangesAfterContent(metadata, nextMetadata)) {
          throw ambiguousFailure("GENERATION_FAILED", metadata, undefined, undefined, true);
        }
        if (nextMetadata.provider === undefined) {
          throw ambiguousFailure("GENERATION_FAILED", metadata, undefined, undefined, true);
        }
        metadata = nextMetadata;
        normalizedUsage =
          normalizedUsage === null
            ? {
                accounting: { ...lookup.accounting, metadata },
                usage: lookup.usage,
              }
            : {
                accounting: { ...normalizedUsage.accounting, metadata },
                usage: normalizedUsage.usage,
              };
      }
      yield* transportClock.publish({
        accounting: normalizedUsage.accounting,
        reason: terminalReason,
        transportElapsedMilliseconds: transportClock.elapsedMilliseconds(),
        type: "response.completed",
        usage: normalizedUsage.usage,
      });
    } catch (error: unknown) {
      if (signal.aborted) {
        throw abortError(signal.reason);
      }
      transportClock ??= createGatewayTransportClock();
      if (
        headerController.signal.aborted ||
        activityController.signal.aborted ||
        totalController.signal.aborted
      ) {
        yield* transportClock.publish({
          ...failureEvent(
            withAuthoritativeUsage(
              {
                accounting: {
                  ...(Object.keys(metadata).length === 0 ? {} : { metadata }),
                  spendRisk: submitted ? "unknown" : "none",
                },
                errorCode: "GENERATION_TIMEOUT",
                providerErrorType: "timeout",
              },
              normalizedUsage,
            ),
          ),
          transportElapsedMilliseconds: transportClock.elapsedMilliseconds(),
        });
        return;
      }
      if (error instanceof OpenRouterAdapterError) {
        const failure = withAuthoritativeUsage(error.failure, normalizedUsage);
        if (failure.providerOutcome !== undefined) {
          let actual = failure.accounting.actual;
          let usage = failure.usage;
          let usageLookupAttempted = failure.usageLookupAttempted;
          let providerMetadataAccepted = actual?.metadata.provider !== undefined;
          const providerGenerationId =
            failure.accounting.metadata?.providerGenerationId ??
            actual?.metadata.providerGenerationId;
          if (
            (actual === undefined || usage === undefined || !providerMetadataAccepted) &&
            providerGenerationId !== undefined &&
            usageLookupAttempted !== true
          ) {
            usageLookupAttempted = true;
            const lookup = await this.lookupUsage(providerGenerationId, signal);
            if (lookup.status === "found") {
              try {
                const nextMetadata = metadataFrom(metadata, {
                  id: lookup.accounting.metadata.providerGenerationId,
                  model: lookup.accounting.metadata.resolvedModel,
                  provider: lookup.accounting.metadata.provider,
                });
                if (
                  (emittedVisibleContent && metadataChangesAfterContent(metadata, nextMetadata)) ||
                  nextMetadata.provider === undefined
                ) {
                  providerMetadataAccepted = false;
                } else {
                  metadata = nextMetadata;
                  actual = { ...(actual ?? lookup.accounting), metadata };
                  usage ??= lookup.usage;
                  providerMetadataAccepted = true;
                }
              } catch {
                providerMetadataAccepted = false;
              }
            }
          }
          if (actual !== undefined && usage !== undefined && providerMetadataAccepted) {
            yield* transportClock.publish({
              accounting: actual,
              reason: failure.providerOutcome,
              transportElapsedMilliseconds: transportClock.elapsedMilliseconds(),
              type: "response.completed",
              usage,
            });
            return;
          }
          yield* transportClock.publish({
            ...failureEvent({
              ...failure,
              accounting: {
                ...failure.accounting,
                ...(actual === undefined ? {} : { actual }),
              },
              ...(usage === undefined ? {} : { usage }),
              ...(usageLookupAttempted === undefined ? {} : { usageLookupAttempted }),
            }),
            transportElapsedMilliseconds: transportClock.elapsedMilliseconds(),
          });
          return;
        }
        yield* transportClock.publish({
          ...failureEvent(failure),
          transportElapsedMilliseconds: transportClock.elapsedMilliseconds(),
        });
        return;
      }
      yield* transportClock.publish({
        ...failureEvent(
          withAuthoritativeUsage(
            {
              accounting: {
                ...(Object.keys(metadata).length === 0 ? {} : { metadata }),
                spendRisk: submitted ? "unknown" : "none",
              },
              errorCode: "GENERATION_FAILED",
            },
            normalizedUsage,
          ),
        ),
        transportElapsedMilliseconds: transportClock.elapsedMilliseconds(),
      });
    } finally {
      clearTimer(headerTimer);
      clearTimer(firstTokenTimer);
      clearTimer(inactivityTimer);
      clearTimer(totalTimer);
    }
  }

  async lookupUsage(
    providerGenerationId: string,
    signal: AbortSignal,
  ): Promise<GatewayUsageLookupResult> {
    const safeGenerationId = safeProviderIdentifier(providerGenerationId);
    if (safeGenerationId === null) {
      return { status: "unavailable" };
    }
    const timeoutController = new AbortController();
    const timeout = setAbortTimer(timeoutController, openRouterTuning.lookupTimeoutMilliseconds);
    try {
      signal.throwIfAborted();
      const url = new URL(generationLookupUrl);
      url.searchParams.set("id", safeGenerationId);
      const response = await this.#fetch(url, {
        headers: {
          accept: "application/json",
          authorization: `Bearer ${this.#apiKey}`,
        },
        method: "GET",
        signal: AbortSignal.any([signal, timeoutController.signal]),
      });
      if (!response.ok) {
        await readBoundedJson(response, openRouterTuning.maximumErrorBodyBytes);
        signal.throwIfAborted();
        return { status: "unavailable" };
      }
      const payload = await readBoundedJson(response, openRouterTuning.maximumErrorBodyBytes);
      signal.throwIfAborted();
      if (!isOpenRouterGenerationLookup(payload) || payload.data.id !== safeGenerationId) {
        return { status: "unavailable" };
      }
      const costUsd = canonicalProviderDecimal(payload.data.total_cost, {
        maximumPrecision: 38,
        maximumScale: 18,
      });
      if (costUsd === null) {
        return { status: "unavailable" };
      }
      const metadata = metadataFrom(
        {},
        {
          id: payload.data.id,
          ...(payload.data.model === undefined ? {} : { model: payload.data.model }),
          ...(payload.data.provider_name === undefined
            ? {}
            : { provider: payload.data.provider_name }),
        },
      );
      const cachedTokens = optionalTokenCount(payload.data.native_tokens_cached);
      const reasoningTokens = optionalTokenCount(payload.data.native_tokens_reasoning);
      return {
        accounting: {
          ...(cachedTokens === undefined ? {} : { cachedTokens }),
          costUsd,
          metadata,
          ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
        },
        status: "found",
        usage: {
          inputTokens: payload.data.tokens_prompt,
          outputTokens: payload.data.tokens_completion,
        },
      };
    } catch {
      if (signal.aborted) {
        throw abortError(signal.reason);
      }
      return { status: "unavailable" };
    } finally {
      clearTimeout(timeout);
    }
  }
}

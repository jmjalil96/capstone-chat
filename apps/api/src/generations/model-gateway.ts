import type { GenerationModelTier } from "@capstone/protocol";
import type { EffectiveModelParameters } from "../model-policy/effective-parameters.js";
import { serializeSummaryFrame } from "./compaction-prompt.js";

export type GatewayCompletionReason = "content_filter" | "length" | "refusal" | "stop";
export type GatewayFailureCode = "GENERATION_FAILED" | "GENERATION_TIMEOUT" | "MODEL_UNAVAILABLE";

export type GatewayProviderErrorType =
  | "authentication"
  | "content_policy_violation"
  | "context_length_exceeded"
  | "invalid_prompt"
  | "invalid_request"
  | "max_tokens_exceeded"
  | "not_found"
  | "payment_required"
  | "payload_too_large"
  | "permission_denied"
  | "precondition_failed"
  | "provider_overloaded"
  | "provider_unavailable"
  | "rate_limit_exceeded"
  | "refusal"
  | "server"
  | "string_too_long"
  | "timeout"
  | "token_limit_exceeded"
  | "unmapped"
  | "unprocessable";

export interface GatewayUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface GatewayProviderMetadata {
  readonly provider?: string;
  readonly providerGenerationId?: string;
  readonly resolvedModel?: string;
}

export interface GatewayAccounting {
  readonly cachedTokens?: number;
  readonly costUsd: string;
  readonly metadata: GatewayProviderMetadata;
  readonly reasoningTokens?: number;
}

export interface GenerationModelRoute {
  readonly completionPriceCeilingUsdPerToken: string;
  readonly maximumOutputTokens: number;
  readonly promptPriceCeilingUsdPerToken: string;
  readonly requestPriceCeilingUsd: string;
  readonly requestedModel: string;
}

export interface GenerationContextMessage {
  readonly role: "assistant" | "user";
  readonly text: string;
}

export interface GenerationDerivedContext {
  readonly kind: "compaction-summary";
  readonly summary: string;
}

export type GenerationPurpose = "chat" | "compaction" | "title";

interface GenerationRequestBase {
  readonly effectiveParameters: EffectiveModelParameters;
  readonly history: readonly GenerationContextMessage[];
  readonly message: GenerationContextMessage & { readonly role: "user" };
  /** Required by a real gateway; omitted only by legacy/fake Phase 4 fixtures. */
  readonly route?: GenerationModelRoute;
  readonly systemPrompt: {
    readonly text: string;
    readonly version: string;
  };
}

export interface ChatGenerationRequest extends GenerationRequestBase {
  readonly derivedContext?: GenerationDerivedContext;
  readonly modelTier: GenerationModelTier;
  readonly purpose: "chat";
}

export interface CompactionGenerationRequest extends GenerationRequestBase {
  readonly derivedContext?: never;
  readonly modelTier: "fast";
  readonly purpose: "compaction";
}

export interface TitleGenerationRequest extends GenerationRequestBase {
  readonly derivedContext?: never;
  readonly modelTier: "fast";
  readonly purpose: "title";
}

export type GenerationRequest =
  | ChatGenerationRequest
  | CompactionGenerationRequest
  | TitleGenerationRequest;

export interface GatewayRequestMessage {
  readonly content: string;
  readonly role: "assistant" | "system" | "user";
}

export function generationRequestMessages(
  request: GenerationRequest,
): readonly GatewayRequestMessage[] {
  return [
    { content: request.systemPrompt.text, role: "system" },
    ...(request.purpose === "chat" && request.derivedContext !== undefined
      ? [
          {
            content: serializeSummaryFrame(request.derivedContext.summary),
            role: "user" as const,
          },
        ]
      : []),
    ...request.history.map((message) => ({ content: message.text, role: message.role })),
    { content: request.message.text, role: "user" },
  ];
}

export function generationRequestEstimatorInputs(request: GenerationRequest): readonly string[] {
  return generationRequestMessages(request).map((message) => message.content);
}

interface GatewayTransportTiming {
  /** Adapter-active time, excluding suspension while the async-iterator consumer handles an event. */
  readonly transportElapsedMilliseconds?: number;
}

export type GatewayEvent =
  | (GatewayTransportTiming & {
      /** Private lifecycle boundary; coordinators consume it and never forward it to browsers. */
      readonly type: "response.headers";
    })
  | {
      readonly metadata: GatewayProviderMetadata;
      readonly type: "generation.metadata";
    }
  | (GatewayTransportTiming & {
      readonly text: string;
      readonly type: "content.delta";
    })
  | (GatewayTransportTiming & {
      readonly reason: GatewayCompletionReason;
      readonly type: "response.completed";
      readonly usage: GatewayUsage;
      readonly accounting?: GatewayAccounting;
    })
  | (GatewayTransportTiming & {
      readonly accounting?: {
        readonly actual?: GatewayAccounting;
        readonly metadata?: GatewayProviderMetadata;
        readonly spendRisk: "none" | "unknown";
      };
      readonly errorCode: GatewayFailureCode;
      readonly providerErrorType?: GatewayProviderErrorType;
      readonly providerOutcome?: "content_filter" | "refusal";
      /** The provider adapter already spent this generation's one bounded usage lookup. */
      readonly usageLookupAttempted?: boolean;
      readonly type: "response.failed";
      readonly usage?: GatewayUsage;
    });

export function gatewayTransportElapsedMilliseconds(event: GatewayEvent): number | undefined {
  const value =
    event.type === "generation.metadata" ? undefined : event.transportElapsedMilliseconds;
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function createGatewayTransportClock(): {
  readonly elapsedMilliseconds: () => number;
  readonly publish: <Event extends GatewayEvent>(event: Event) => AsyncIterable<Event>;
} {
  const startedAt = performance.now();
  let consumerSuspensionMilliseconds = 0;

  function elapsedMilliseconds(): number {
    return Math.max(0, performance.now() - startedAt - consumerSuspensionMilliseconds);
  }

  async function* publish<Event extends GatewayEvent>(event: Event): AsyncIterable<Event> {
    const suspendedAt = performance.now();
    try {
      yield event;
    } finally {
      consumerSuspensionMilliseconds += Math.max(0, performance.now() - suspendedAt);
    }
  }

  return Object.freeze({ elapsedMilliseconds, publish });
}

export interface ModelGateway {
  stream(request: GenerationRequest, signal: AbortSignal): AsyncIterable<GatewayEvent>;
}

export type GatewayUsageLookupResult =
  | {
      readonly accounting: GatewayAccounting;
      readonly status: "found";
      readonly usage: GatewayUsage;
    }
  | {
      readonly status: "unavailable";
    };

export interface GenerationAccountingGateway {
  lookupUsage(providerGenerationId: string, signal: AbortSignal): Promise<GatewayUsageLookupResult>;
}

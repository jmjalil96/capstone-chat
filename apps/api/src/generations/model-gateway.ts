import type { GenerationModelTier } from "@capstone/protocol";

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

export interface GenerationRequest {
  readonly history: readonly GenerationContextMessage[];
  readonly message: GenerationContextMessage & { readonly role: "user" };
  readonly modelTier: GenerationModelTier;
  /** Required by a real gateway; omitted only by legacy/fake Phase 4 fixtures. */
  readonly route?: GenerationModelRoute;
  readonly systemPrompt: {
    readonly text: string;
    readonly version: string;
  };
}

export type GatewayEvent =
  | {
      readonly metadata: GatewayProviderMetadata;
      readonly type: "generation.metadata";
    }
  | {
      readonly text: string;
      readonly type: "content.delta";
    }
  | {
      readonly reason: GatewayCompletionReason;
      readonly type: "response.completed";
      readonly usage: GatewayUsage;
      readonly accounting?: GatewayAccounting;
    }
  | {
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
    };

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

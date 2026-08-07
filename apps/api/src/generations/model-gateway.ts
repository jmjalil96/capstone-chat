export type GatewayCompletionReason = "content_filter" | "length" | "refusal" | "stop";
export type GatewayFailureCode = "GENERATION_FAILED" | "GENERATION_TIMEOUT" | "MODEL_UNAVAILABLE";

export interface GatewayUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface GenerationContextMessage {
  readonly role: "assistant" | "user";
  readonly text: string;
}

export interface GenerationRequest {
  readonly history: readonly GenerationContextMessage[];
  readonly message: GenerationContextMessage & { readonly role: "user" };
  readonly modelTier: "balanced";
  readonly systemPrompt: {
    readonly text: string;
    readonly version: string;
  };
}

export type GatewayEvent =
  | {
      readonly text: string;
      readonly type: "content.delta";
    }
  | {
      readonly reason: GatewayCompletionReason;
      readonly type: "response.completed";
      readonly usage: GatewayUsage;
    }
  | {
      readonly errorCode: GatewayFailureCode;
      readonly type: "response.failed";
    };

export interface ModelGateway {
  stream(request: GenerationRequest, signal: AbortSignal): AsyncIterable<GatewayEvent>;
}

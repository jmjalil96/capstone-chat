import {
  type Static,
  type TSchema,
  Type,
  TypeBoxValidatorCompiler,
} from "@fastify/type-provider-typebox";
import { Decimal } from "decimal.js";
import type { GatewayProviderErrorType } from "../generations/model-gateway.js";

const maximumSafeInteger = Number.MAX_SAFE_INTEGER;
const ProviderDecimal = Decimal.clone({ precision: 80, toExpNeg: -1_000, toExpPos: 1_000 });
const DecimalWireSchema = Type.Union([Type.Number(), Type.String({ maxLength: 128 })]);
const TokenCountSchema = Type.Integer({ maximum: maximumSafeInteger, minimum: 0 });
const NullableTokenCountSchema = Type.Union([TokenCountSchema, Type.Null()]);

const UsageDetailsSchema = Type.Object(
  {
    cached_tokens: Type.Optional(NullableTokenCountSchema),
    reasoning_tokens: Type.Optional(NullableTokenCountSchema),
  },
  { additionalProperties: true },
);

export const OpenRouterUsageSchema = Type.Object(
  {
    completion_tokens: TokenCountSchema,
    completion_tokens_details: Type.Optional(UsageDetailsSchema),
    cost: DecimalWireSchema,
    prompt_tokens: TokenCountSchema,
    prompt_tokens_details: Type.Optional(UsageDetailsSchema),
  },
  { additionalProperties: true },
);
export type OpenRouterUsage = Static<typeof OpenRouterUsageSchema>;

const OpenRouterDeltaSchema = Type.Object(
  {
    content: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    refusal: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  },
  { additionalProperties: true },
);

const OpenRouterChoiceSchema = Type.Object(
  {
    delta: Type.Optional(OpenRouterDeltaSchema),
    finish_reason: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    index: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: true },
);

const OpenRouterErrorMetadataSchema = Type.Object(
  { error_type: Type.Optional(Type.String({ maxLength: 80 })) },
  { additionalProperties: true },
);

export const OpenRouterErrorEnvelopeSchema = Type.Object(
  {
    error: Type.Object(
      {
        code: Type.Optional(Type.Union([Type.Integer(), Type.String({ maxLength: 80 })])),
        metadata: Type.Optional(OpenRouterErrorMetadataSchema),
      },
      { additionalProperties: true },
    ),
  },
  { additionalProperties: true },
);
export type OpenRouterErrorEnvelope = Static<typeof OpenRouterErrorEnvelopeSchema>;

export const OpenRouterChatChunkSchema = Type.Object(
  {
    choices: Type.Optional(Type.Array(OpenRouterChoiceSchema, { maxItems: 1 })),
    error: Type.Optional(OpenRouterErrorEnvelopeSchema.properties.error),
    id: Type.Optional(Type.String({ maxLength: 256 })),
    model: Type.Optional(Type.String({ maxLength: 256 })),
    provider: Type.Optional(Type.String({ maxLength: 256 })),
    usage: Type.Optional(OpenRouterUsageSchema),
  },
  { additionalProperties: true },
);
export type OpenRouterChatChunk = Static<typeof OpenRouterChatChunkSchema>;

const OpenRouterPricingOverrideSchema = Type.Object(
  {
    audio: Type.Optional(DecimalWireSchema),
    completion: Type.Optional(DecimalWireSchema),
    input_audio_cache: Type.Optional(DecimalWireSchema),
    input_cache_read: Type.Optional(DecimalWireSchema),
    input_cache_write: Type.Optional(DecimalWireSchema),
    input_cache_write_1h: Type.Optional(DecimalWireSchema),
    min_prompt_tokens: Type.Optional(TokenCountSchema),
    prompt: Type.Optional(DecimalWireSchema),
    utc_end: Type.Optional(Type.Integer({ maximum: 2359, minimum: 0 })),
    utc_start: Type.Optional(Type.Integer({ maximum: 2359, minimum: 0 })),
  },
  { additionalProperties: true },
);

const OpenRouterEndpointPricingSchema = Type.Object(
  {
    audio: Type.Optional(DecimalWireSchema),
    audio_output: Type.Optional(DecimalWireSchema),
    completion: DecimalWireSchema,
    discount: Type.Optional(Type.Number({ maximum: 1, minimum: 0 })),
    image: Type.Optional(DecimalWireSchema),
    image_output: Type.Optional(DecimalWireSchema),
    image_token: Type.Optional(DecimalWireSchema),
    input_audio_cache: Type.Optional(DecimalWireSchema),
    input_cache_read: Type.Optional(DecimalWireSchema),
    input_cache_write: Type.Optional(DecimalWireSchema),
    input_cache_write_1h: Type.Optional(DecimalWireSchema),
    internal_reasoning: Type.Optional(DecimalWireSchema),
    overrides: Type.Optional(Type.Array(OpenRouterPricingOverrideSchema, { maxItems: 256 })),
    prompt: DecimalWireSchema,
    request: Type.Optional(DecimalWireSchema),
    web_search: Type.Optional(DecimalWireSchema),
  },
  { additionalProperties: true },
);

export const OpenRouterEndpointSchema = Type.Object(
  {
    context_length: Type.Integer({ maximum: maximumSafeInteger, minimum: 1 }),
    max_completion_tokens: Type.Optional(
      Type.Union([Type.Integer({ maximum: maximumSafeInteger, minimum: 1 }), Type.Null()]),
    ),
    max_prompt_tokens: Type.Optional(
      Type.Union([Type.Integer({ maximum: maximumSafeInteger, minimum: 1 }), Type.Null()]),
    ),
    model_id: Type.String({ maxLength: 256, minLength: 1 }),
    pricing: OpenRouterEndpointPricingSchema,
    status: Type.Integer(),
    supported_parameters: Type.Array(Type.String({ maxLength: 80 }), { maxItems: 256 }),
  },
  { additionalProperties: true },
);
export type OpenRouterEndpoint = Static<typeof OpenRouterEndpointSchema>;

export const OpenRouterZdrEndpointsSchema = Type.Object(
  { data: Type.Array(Type.Unknown(), { maxItems: 20_000 }) },
  { additionalProperties: true },
);
export type OpenRouterZdrEndpoints = Static<typeof OpenRouterZdrEndpointsSchema>;

const OpenRouterArchitectureSchema = Type.Object(
  {
    input_modalities: Type.Array(Type.String({ maxLength: 80 }), { maxItems: 32 }),
    output_modalities: Type.Array(Type.String({ maxLength: 80 }), { maxItems: 32 }),
  },
  { additionalProperties: true },
);

const OpenRouterModelSchema = Type.Object(
  {
    architecture: OpenRouterArchitectureSchema,
    canonical_slug: Type.Union([Type.String({ maxLength: 256, minLength: 1 }), Type.Null()]),
    context_length: Type.Integer({ maximum: maximumSafeInteger, minimum: 1 }),
    id: Type.String({ maxLength: 256, minLength: 1 }),
    name: Type.String({ maxLength: 256, minLength: 1 }),
    supported_parameters: Type.Array(Type.String({ maxLength: 80 }), { maxItems: 256 }),
    top_provider: Type.Optional(
      Type.Object(
        {
          context_length: Type.Optional(
            Type.Union([Type.Integer({ maximum: maximumSafeInteger, minimum: 1 }), Type.Null()]),
          ),
          max_completion_tokens: Type.Optional(
            Type.Union([Type.Integer({ maximum: maximumSafeInteger, minimum: 1 }), Type.Null()]),
          ),
        },
        { additionalProperties: true },
      ),
    ),
  },
  { additionalProperties: true },
);

export const OpenRouterModelResponseSchema = Type.Object(
  { data: OpenRouterModelSchema },
  { additionalProperties: true },
);
export type OpenRouterModelResponse = Static<typeof OpenRouterModelResponseSchema>;

export const OpenRouterGenerationLookupSchema = Type.Object(
  {
    data: Type.Object(
      {
        id: Type.String({ maxLength: 256, minLength: 1 }),
        model: Type.Optional(Type.String({ maxLength: 256, minLength: 1 })),
        native_tokens_cached: Type.Optional(NullableTokenCountSchema),
        native_tokens_reasoning: Type.Optional(NullableTokenCountSchema),
        provider_name: Type.Optional(Type.String({ maxLength: 256, minLength: 1 })),
        tokens_completion: TokenCountSchema,
        tokens_prompt: TokenCountSchema,
        total_cost: DecimalWireSchema,
      },
      { additionalProperties: true },
    ),
  },
  { additionalProperties: true },
);
export type OpenRouterGenerationLookup = Static<typeof OpenRouterGenerationLookupSchema>;

const schemaValidators = new WeakMap<object, ReturnType<typeof TypeBoxValidatorCompiler>>();

function schemaCheck<const Schema extends TSchema>(
  schema: Schema,
  value: unknown,
): value is Static<Schema> {
  let validate = schemaValidators.get(schema);
  if (validate === undefined) {
    validate = TypeBoxValidatorCompiler({
      httpPart: "body",
      method: "GET",
      schema,
      url: "openrouter-private-contract",
    });
    schemaValidators.set(schema, validate);
  }
  const result = validate(value);
  if (typeof result === "boolean") {
    return result;
  }
  if (result === null || typeof result !== "object" || "then" in result) {
    return false;
  }
  return result.error === undefined;
}

export function isOpenRouterChatChunk(value: unknown): value is OpenRouterChatChunk {
  return schemaCheck(OpenRouterChatChunkSchema, value);
}

export function isOpenRouterErrorEnvelope(value: unknown): value is OpenRouterErrorEnvelope {
  return schemaCheck(OpenRouterErrorEnvelopeSchema, value);
}

export function isOpenRouterEndpoint(value: unknown): value is OpenRouterEndpoint {
  return schemaCheck(OpenRouterEndpointSchema, value);
}

export function isOpenRouterGenerationLookup(value: unknown): value is OpenRouterGenerationLookup {
  return schemaCheck(OpenRouterGenerationLookupSchema, value);
}

export function isOpenRouterModelResponse(value: unknown): value is OpenRouterModelResponse {
  return schemaCheck(OpenRouterModelResponseSchema, value);
}

export function isOpenRouterUsage(value: unknown): value is OpenRouterUsage {
  return schemaCheck(OpenRouterUsageSchema, value);
}

export function isOpenRouterZdrEndpoints(value: unknown): value is OpenRouterZdrEndpoints {
  return schemaCheck(OpenRouterZdrEndpointsSchema, value);
}

const providerErrorTypes = new Set<GatewayProviderErrorType>([
  "authentication",
  "content_policy_violation",
  "context_length_exceeded",
  "invalid_prompt",
  "invalid_request",
  "max_tokens_exceeded",
  "not_found",
  "payment_required",
  "payload_too_large",
  "permission_denied",
  "precondition_failed",
  "provider_overloaded",
  "provider_unavailable",
  "rate_limit_exceeded",
  "refusal",
  "server",
  "string_too_long",
  "timeout",
  "token_limit_exceeded",
  "unmapped",
  "unprocessable",
]);

export function sanitizedProviderErrorType(value: unknown): GatewayProviderErrorType {
  return typeof value === "string" && providerErrorTypes.has(value as GatewayProviderErrorType)
    ? (value as GatewayProviderErrorType)
    : "unmapped";
}

export function canonicalProviderDecimal(
  value: unknown,
  options: { readonly maximumPrecision: number; readonly maximumScale: number },
): string | null {
  if (typeof value !== "string" && typeof value !== "number") {
    return null;
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    return null;
  }
  const source = String(value);
  if (
    source.length === 0 ||
    source.length > 128 ||
    !/^(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/u.test(source)
  ) {
    return null;
  }
  let decimal: Decimal;
  try {
    decimal = new ProviderDecimal(source);
  } catch {
    return null;
  }
  if (!decimal.isFinite() || decimal.isNegative()) {
    return null;
  }
  if (
    !decimal.isZero() &&
    (decimal.e < -options.maximumScale || decimal.e >= options.maximumPrecision)
  ) {
    return null;
  }
  const canonical = decimal.toFixed();
  const [whole = "", fraction = ""] = canonical.split(".");
  const precision = whole.replace(/^0+/u, "").length + fraction.length;
  if (fraction.length > options.maximumScale || Math.max(1, precision) > options.maximumPrecision) {
    return null;
  }
  return canonical;
}

export function safeProviderIdentifier(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 256 ||
    !value.isWellFormed() ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
    }) ||
    !/\S/u.test(value)
  ) {
    return null;
  }
  return value;
}

export async function readBoundedJson(
  response: Response,
  maximumBytes: number,
): Promise<unknown | null> {
  if (response.body === null) {
    return null;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let reachedEndOfBody = false;
  let text = "";
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        reachedEndOfBody = true;
        break;
      }
      bytes += result.value.byteLength;
      if (bytes > maximumBytes) {
        return null;
      }
      text += decoder.decode(result.value, { stream: true });
    }
    text += decoder.decode();
  } catch {
    return null;
  } finally {
    if (!reachedEndOfBody) {
      await reader.cancel().catch(() => undefined);
    }
    reader.releaseLock();
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

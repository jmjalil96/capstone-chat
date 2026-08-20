import {
  addUnitPrices,
  canonicalUnitPrice,
  canonicalUsd,
  compareDecimal,
  maximumDecimal,
} from "./money.js";

export const modelTiers = ["fast", "balanced", "pro"] as const;
export type ModelTier = (typeof modelTiers)[number];
export type CatalogMetadataSource = "openrouter" | "simulated";

export const initialTierModels = {
  balanced: "deepseek/deepseek-v4-pro",
  fast: "deepseek/deepseek-v4-flash-0731",
  pro: "moonshotai/kimi-k3",
} as const satisfies Readonly<Record<ModelTier, string>>;

export const gatewayEfforts = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type GatewayEffort = (typeof gatewayEfforts)[number];

const requiredParameters = ["max_tokens"] as const;
const reasoningContractSource = "openrouter-reasoning-docs-2026-08-17";
const pricedTextComponents = new Set([
  "cache_read",
  "cache_write",
  "completion",
  "input_cache_read",
  "input_cache_write",
  "internal_reasoning",
  "prompt",
  "request",
]);
const unsupportedComponents = new Set([
  "audio",
  "image",
  "image_output",
  "input_audio",
  "output_audio",
  "web_search",
]);

export class CatalogValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CatalogValidationError";
  }
}

export interface PricingSnapshot {
  readonly [component: string]: unknown;
}

export interface EndpointPricingSnapshot {
  readonly base: PricingSnapshot;
  /** Conditional pricing is safe only when every alternative is supplied and bounded here. */
  readonly overrides?: readonly PricingSnapshot[];
}

export interface OpenRouterModelMetadata {
  readonly canonicalSlug: string | null;
  readonly contextLength: number;
  readonly displayName: string;
  readonly inputModalities: readonly string[];
  readonly maximumOutputTokens: number | null;
  readonly modelId: string;
  readonly outputModalities: readonly string[];
  readonly reasoning?: Readonly<{
    readonly defaultEffort?: string;
    readonly defaultEnabled?: boolean;
    readonly mandatory?: boolean;
    readonly supportedEfforts?: readonly string[] | null;
    readonly supportsMaxTokens?: boolean;
  }>;
  readonly supportedParameters: readonly string[];
}

export interface ZdrEndpointMetadata {
  readonly contextLength: number;
  readonly healthy: boolean;
  readonly inputModalities: readonly string[];
  readonly maximumOutputTokens: number;
  readonly modelId: string;
  readonly outputModalities: readonly string[];
  readonly pricing: EndpointPricingSnapshot;
  readonly supportedParameters: readonly string[];
  readonly zdr: boolean;
}

export interface CatalogModelSnapshot {
  readonly available: boolean;
  readonly canonicalSlug: string | null;
  readonly capability: CatalogModelCapability;
  readonly completionPricePerToken: string;
  readonly contextLength: number;
  readonly displayName: string;
  readonly inputModalities: readonly string[];
  readonly maximumOutputTokens: number;
  readonly metadataSource: CatalogMetadataSource;
  readonly modelId: string;
  readonly outputModalities: readonly string[];
  readonly promptPricePerToken: string;
  readonly requestPriceUsd: string;
  readonly supportedParameters: readonly string[];
  readonly validatedAt: Date;
}

export type CatalogEffortSupport =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "all" }>
  | Readonly<{ kind: "listed"; values: readonly GatewayEffort[] }>;

export interface CatalogReasoningCapability {
  readonly contractSource: string;
  readonly defaultEffort: GatewayEffort | null;
  readonly defaultEnabled: boolean | null;
  readonly effortSupport: CatalogEffortSupport;
  readonly exclusionVerifiedAt: Date | null;
  readonly kind: "none" | "optional" | "mandatory" | "unverified";
  readonly maxTokensAccepted: boolean;
  readonly traceSafety: "non_reasoning" | "provider_excluded" | "unverified";
}

export interface CatalogModelCapability {
  readonly reasoning: CatalogReasoningCapability;
  readonly temperatureSupported: boolean;
}

export interface ChargeCeilings {
  readonly completionPricePerToken: string;
  readonly promptPricePerToken: string;
  readonly requestPriceUsd: string;
}

function component(record: PricingSnapshot, name: string, required = false): string {
  const value = record[name];
  if (value === undefined || value === null || value === "") {
    if (required) {
      throw new CatalogValidationError(`Pricing component ${name} is required`);
    }
    return "0";
  }
  if (typeof value !== "string") {
    throw new CatalogValidationError(`Pricing component ${name} must be a decimal string`);
  }
  try {
    return name === "request"
      ? canonicalUsd(value, `pricing.${name}`)
      : canonicalUnitPrice(value, `pricing.${name}`);
  } catch {
    throw new CatalogValidationError(`Pricing component ${name} is not a supported decimal`);
  }
}

function assertNoUnboundedCharges(record: PricingSnapshot): void {
  for (const [name, rawValue] of Object.entries(record)) {
    if (pricedTextComponents.has(name)) {
      continue;
    }

    const value = rawValue === null || rawValue === undefined || rawValue === "" ? "0" : rawValue;
    if (typeof value !== "string") {
      throw new CatalogValidationError(`Pricing component ${name} is not bounded`);
    }
    let canonical: string;
    try {
      canonical = name === "request" ? canonicalUsd(value) : canonicalUnitPrice(value);
    } catch {
      throw new CatalogValidationError(`Pricing component ${name} is not bounded`);
    }
    if (compareDecimal(canonical, "0") !== 0) {
      const category = unsupportedComponents.has(name) ? "unsupported" : "unknown";
      throw new CatalogValidationError(
        `Endpoint has a non-zero ${category} pricing component: ${name}`,
      );
    }
  }
}

function deriveOnePricingRecord(record: PricingSnapshot): ChargeCeilings {
  assertNoUnboundedCharges(record);

  // Cache reads replace ordinary input pricing; cache writes may be an additional surcharge.
  const promptOrCacheRead = maximumDecimal([
    component(record, "prompt", true),
    component(record, "cache_read"),
    component(record, "input_cache_read"),
  ]);
  const promptPricePerToken = addUnitPrices(
    addUnitPrices(promptOrCacheRead, component(record, "cache_write")),
    component(record, "input_cache_write"),
  );

  // Hidden reasoning may be billed in addition to visible completion tokens even when its content
  // is excluded, so the reservation covers both dimensions under the output allowance.
  const completionPricePerToken = addUnitPrices(
    component(record, "completion", true),
    component(record, "internal_reasoning"),
  );

  return {
    completionPricePerToken,
    promptPricePerToken,
    requestPriceUsd: component(record, "request", true),
  };
}

export function deriveChargeCeilings(pricing: EndpointPricingSnapshot): ChargeCeilings {
  const alternatives = [pricing.base, ...(pricing.overrides ?? [])];
  if (alternatives.length === 0) {
    throw new CatalogValidationError("Endpoint pricing is missing");
  }
  const ceilings = alternatives.map(deriveOnePricingRecord);
  return {
    completionPricePerToken: maximumDecimal(
      ceilings.map(({ completionPricePerToken }) => completionPricePerToken),
    ),
    promptPricePerToken: maximumDecimal(
      ceilings.map(({ promptPricePerToken }) => promptPricePerToken),
    ),
    requestPriceUsd: maximumDecimal(ceilings.map(({ requestPriceUsd }) => requestPriceUsd)),
  };
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new CatalogValidationError(`${label} must be a positive safe integer`);
  }
  return value;
}

function includesEvery(values: readonly string[], required: readonly string[]): boolean {
  return required.every((value) => values.includes(value));
}

function isEligibleEndpoint(endpoint: ZdrEndpointMetadata, modelId: string): boolean {
  return (
    endpoint.modelId === modelId &&
    endpoint.zdr &&
    endpoint.healthy &&
    endpoint.inputModalities.includes("text") &&
    endpoint.outputModalities.includes("text") &&
    includesEvery(endpoint.supportedParameters, requiredParameters) &&
    Number.isSafeInteger(endpoint.contextLength) &&
    endpoint.contextLength > 0 &&
    Number.isSafeInteger(endpoint.maximumOutputTokens) &&
    endpoint.maximumOutputTokens > 0
  );
}

function normalizedEffortSupport(
  reasoning: NonNullable<OpenRouterModelMetadata["reasoning"]>,
  effortParameterAccepted: boolean,
): CatalogEffortSupport {
  if (!effortParameterAccepted || reasoning.supportedEfforts === undefined) {
    return Object.freeze({ kind: "none" });
  }
  if (reasoning.supportedEfforts === null) {
    return Object.freeze({ kind: "all" });
  }
  const recognized = gatewayEfforts.filter((effort) =>
    reasoning.supportedEfforts?.includes(effort),
  );
  return recognized.length === 0
    ? Object.freeze({ kind: "none" })
    : Object.freeze({ kind: "listed", values: Object.freeze(recognized) });
}

function normalizedCapability(
  model: OpenRouterModelMetadata,
  eligibleEndpoints: readonly ZdrEndpointMetadata[],
  validatedAt: Date,
): CatalogModelCapability {
  const modelReasoningParameter = model.supportedParameters.includes("reasoning");
  const structuredReasoning = model.reasoning;
  const endpointReasoningParameter = eligibleEndpoints.every((endpoint) =>
    endpoint.supportedParameters.includes("reasoning"),
  );
  const modelHasStructuredReasoning = structuredReasoning !== undefined;
  const modelAndEndpointsAcceptReasoning = modelReasoningParameter && endpointReasoningParameter;
  const temperatureSupported =
    model.supportedParameters.includes("temperature") &&
    eligibleEndpoints.every((endpoint) => endpoint.supportedParameters.includes("temperature"));

  if (!modelHasStructuredReasoning && !modelReasoningParameter) {
    return Object.freeze({
      reasoning: Object.freeze({
        contractSource: reasoningContractSource,
        defaultEffort: null,
        defaultEnabled: null,
        effortSupport: Object.freeze({ kind: "none" }),
        exclusionVerifiedAt: null,
        kind: "none",
        maxTokensAccepted: false,
        traceSafety: "non_reasoning",
      }),
      temperatureSupported,
    });
  }

  if (!modelHasStructuredReasoning || !modelAndEndpointsAcceptReasoning) {
    return Object.freeze({
      reasoning: Object.freeze({
        contractSource: reasoningContractSource,
        defaultEffort: null,
        defaultEnabled: null,
        effortSupport: Object.freeze({ kind: "none" }),
        exclusionVerifiedAt: null,
        kind: "unverified",
        maxTokensAccepted: false,
        traceSafety: "unverified",
      }),
      temperatureSupported,
    });
  }

  const defaultEffort = gatewayEfforts.find(
    (effort) => effort === structuredReasoning.defaultEffort,
  );
  const effortParameterAccepted =
    model.supportedParameters.includes("reasoning_effort") &&
    eligibleEndpoints.every((endpoint) =>
      endpoint.supportedParameters.includes("reasoning_effort"),
    );
  return Object.freeze({
    reasoning: Object.freeze({
      contractSource: reasoningContractSource,
      defaultEffort: defaultEffort ?? null,
      defaultEnabled: structuredReasoning.defaultEnabled ?? null,
      effortSupport: normalizedEffortSupport(structuredReasoning, effortParameterAccepted),
      exclusionVerifiedAt: validatedAt,
      kind: structuredReasoning.mandatory === true ? "mandatory" : "optional",
      maxTokensAccepted: structuredReasoning.supportsMaxTokens === true,
      traceSafety: "provider_excluded",
    }),
    temperatureSupported,
  });
}

export function buildOpenRouterCatalogSnapshot(
  model: OpenRouterModelMetadata,
  endpoints: readonly ZdrEndpointMetadata[],
  validatedAt: Date,
): CatalogModelSnapshot {
  if (!model.inputModalities.includes("text") || !model.outputModalities.includes("text")) {
    throw new CatalogValidationError("Approved model must accept and produce text");
  }
  if (!includesEvery(model.supportedParameters, requiredParameters)) {
    throw new CatalogValidationError("Approved model must support max_tokens");
  }
  positiveInteger(model.contextLength, "model context length");
  if (model.maximumOutputTokens !== null) {
    positiveInteger(model.maximumOutputTokens, "model maximum output tokens");
    if (model.maximumOutputTokens > model.contextLength) {
      throw new CatalogValidationError("Model output limit exceeds its context length");
    }
  }
  if (!Number.isFinite(validatedAt.getTime())) {
    throw new CatalogValidationError("Catalog validation time is invalid");
  }

  const structurallyEligible = endpoints.filter((endpoint) =>
    isEligibleEndpoint(endpoint, model.modelId),
  );
  const eligible: Array<{ endpoint: ZdrEndpointMetadata; prices: ChargeCeilings }> = [];
  for (const endpoint of structurallyEligible) {
    try {
      eligible.push({ endpoint, prices: deriveChargeCeilings(endpoint.pricing) });
    } catch (error: unknown) {
      if (!(error instanceof CatalogValidationError)) {
        throw error;
      }
    }
  }
  if (eligible.length === 0) {
    throw new CatalogValidationError("Approved model has no eligible healthy ZDR endpoint");
  }

  const priceCeilings = eligible.map(({ prices }) => prices);
  const contextLength = Math.min(
    model.contextLength,
    ...eligible.map(({ endpoint }) => endpoint.contextLength),
  );
  const maximumOutputTokens = Math.min(
    model.maximumOutputTokens ?? Number.MAX_SAFE_INTEGER,
    ...eligible.map(({ endpoint }) => endpoint.maximumOutputTokens),
  );
  if (maximumOutputTokens > contextLength) {
    throw new CatalogValidationError("Eligible output limit exceeds the conservative context");
  }
  const capability = normalizedCapability(
    model,
    eligible.map(({ endpoint }) => endpoint),
    validatedAt,
  );

  return Object.freeze({
    available: capability.reasoning.kind !== "unverified",
    canonicalSlug: model.canonicalSlug,
    capability,
    completionPricePerToken: maximumDecimal(
      priceCeilings.map(({ completionPricePerToken }) => completionPricePerToken),
    ),
    contextLength,
    displayName: model.displayName,
    inputModalities: Object.freeze(["text"]),
    maximumOutputTokens,
    metadataSource: "openrouter",
    modelId: model.modelId,
    outputModalities: Object.freeze(["text"]),
    promptPricePerToken: maximumDecimal(
      priceCeilings.map(({ promptPricePerToken }) => promptPricePerToken),
    ),
    requestPriceUsd: maximumDecimal(priceCeilings.map(({ requestPriceUsd }) => requestPriceUsd)),
    supportedParameters: Object.freeze(
      model.supportedParameters.filter((parameter) =>
        eligible.every(({ endpoint }) => endpoint.supportedParameters.includes(parameter)),
      ),
    ),
    validatedAt,
  });
}

export function buildSimulatedCatalogSnapshot(
  modelId: string,
  maximumOutputTokens: number,
  validatedAt: Date,
): CatalogModelSnapshot {
  positiveInteger(maximumOutputTokens, "simulated maximum output tokens");
  const simulatedContextLength = 1_000_000;
  if (maximumOutputTokens > simulatedContextLength) {
    throw new CatalogValidationError("Simulated output limit exceeds its context length");
  }
  return Object.freeze({
    available: true,
    canonicalSlug: null,
    capability: Object.freeze({
      reasoning: Object.freeze({
        contractSource: "simulated",
        defaultEffort: null,
        defaultEnabled: null,
        effortSupport: Object.freeze({ kind: "all" }),
        exclusionVerifiedAt: validatedAt,
        kind: "optional",
        maxTokensAccepted: true,
        traceSafety: "provider_excluded",
      }),
      temperatureSupported: true,
    }),
    completionPricePerToken: "0",
    contextLength: simulatedContextLength,
    displayName: "Capstone simulated model",
    inputModalities: Object.freeze(["text"]),
    maximumOutputTokens,
    metadataSource: "simulated",
    modelId,
    outputModalities: Object.freeze(["text"]),
    promptPricePerToken: "0",
    requestPriceUsd: "0",
    supportedParameters: Object.freeze([
      "max_tokens",
      "reasoning",
      "reasoning_effort",
      "temperature",
    ]),
    validatedAt,
  });
}

export interface PrivacyAttestationInput {
  readonly attestationVersion: "openrouter-privacy-v1";
  readonly broadcastEnabled: boolean;
  readonly dataDiscountLoggingEnabled: boolean;
  readonly inputOutputLoggingEnabled: boolean;
  readonly verifiedAt: Date;
}

export interface VerifiedPrivacyAttestation {
  readonly attestationVersion: "openrouter-privacy-v1";
  readonly verifiedAt: Date;
}

export function verifyPrivacyAttestation(
  input: PrivacyAttestationInput,
): VerifiedPrivacyAttestation {
  if (
    input.dataDiscountLoggingEnabled ||
    input.inputOutputLoggingEnabled ||
    input.broadcastEnabled
  ) {
    throw new CatalogValidationError("OpenRouter content logging and broadcast must be disabled");
  }
  if (!Number.isFinite(input.verifiedAt.getTime())) {
    throw new CatalogValidationError("Privacy attestation time is invalid");
  }
  return Object.freeze({
    attestationVersion: input.attestationVersion,
    verifiedAt: input.verifiedAt,
  });
}

export function isModelTier(value: string): value is ModelTier {
  return modelTiers.some((tier) => tier === value);
}

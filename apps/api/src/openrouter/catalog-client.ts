import {
  buildOpenRouterCatalogSnapshot,
  type CatalogModelSnapshot,
  CatalogValidationError,
  type EndpointPricingSnapshot,
  type OpenRouterModelMetadata,
  type PricingSnapshot,
  type ZdrEndpointMetadata,
} from "../model-policy/catalog.js";
import { canonicalUnitPrice, canonicalUsd, maximumDecimal } from "../model-policy/money.js";
import type { OpenRouterFetch } from "./openrouter-gateway.js";
import {
  canonicalProviderDecimal,
  isOpenRouterEndpoint,
  isOpenRouterModelResponse,
  isOpenRouterZdrEndpoints,
  type OpenRouterEndpoint,
  type OpenRouterModelResponse,
  type OpenRouterZdrEndpoints,
  readBoundedJson,
  safeProviderIdentifier,
} from "./provider-contract.js";
import { openRouterTuning } from "./settings.js";

const zdrEndpointsUrl = "https://openrouter.ai/api/v1/endpoints/zdr";
const exactModelBaseUrl = "https://openrouter.ai/api/v1/model/";
const overrideConditionFields = new Set(["min_prompt_tokens", "utc_end", "utc_start"]);

export type OpenRouterCatalogSnapshot = CatalogModelSnapshot;

export class OpenRouterCatalogUnavailableError extends Error {
  constructor() {
    super("OpenRouter catalog metadata is unavailable");
    this.name = "OpenRouterCatalogUnavailableError";
  }
}

function safeExactModelId(value: string): string | null {
  return safeProviderIdentifier(value) !== null && /^[^/\s]+\/[^/\s]+$/u.test(value) ? value : null;
}

function unknownRecord(value: object): Readonly<Record<string, unknown>> {
  return value as Readonly<Record<string, unknown>>;
}

function pricingComponents(
  source: Readonly<Record<string, unknown>>,
  excluded: ReadonlySet<string>,
): PricingSnapshot {
  const result: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(source)) {
    if (!excluded.has(name)) {
      const canonical = canonicalProviderDecimal(value, {
        maximumPrecision: 38,
        maximumScale: name === "request" ? 18 : 24,
      });
      result[name] = canonical ?? value;
    }
  }
  return result;
}

function conservativeComponentRecord(records: readonly PricingSnapshot[]): PricingSnapshot {
  const result: Record<string, unknown> = {};
  const names = new Set(records.flatMap((record) => Object.keys(record)));
  for (const name of names) {
    const values = records.map((record) => record[name]).filter((value) => value !== undefined);
    if (values.length === 0 || values.some((value) => typeof value !== "string")) {
      continue;
    }
    try {
      const canonical = (values as string[]).map((value) =>
        name === "request" ? canonicalUsd(value) : canonicalUnitPrice(value),
      );
      result[name] = maximumDecimal(canonical);
    } catch {
      // Each original alternative is still validated by the shared catalog policy and will fail
      // closed. The synthetic record exists only to bound overlapping partial overrides.
    }
  }
  return result;
}

function materializeEndpointPricing(endpoint: OpenRouterEndpoint): EndpointPricingSnapshot {
  const source = unknownRecord(endpoint.pricing);
  const base = {
    ...pricingComponents(source, new Set(["discount", "overrides"])),
    // OpenRouter's public endpoint contract omits this optional field for endpoints without a
    // fixed request charge. Keep the internal catalog contract explicit so every later price
    // calculation and max_price request still carries a bounded value.
    ...(!Object.hasOwn(source, "request") && { request: "0" }),
  };
  const materialized = (endpoint.pricing.overrides ?? []).map((override) => ({
    ...base,
    ...pricingComponents(unknownRecord(override), overrideConditionFields),
  }));
  if (materialized.length === 0) {
    return { base };
  }
  return {
    base,
    overrides: [...materialized, conservativeComponentRecord([base, ...materialized])],
  };
}

function endpointMetadata(
  endpoint: OpenRouterEndpoint,
  model: OpenRouterModelMetadata,
): ZdrEndpointMetadata {
  return {
    contextLength: Math.min(
      endpoint.context_length,
      endpoint.max_prompt_tokens ?? endpoint.context_length,
    ),
    healthy: endpoint.status === 0,
    inputModalities: model.inputModalities,
    maximumOutputTokens: endpoint.max_completion_tokens ?? 0,
    modelId: endpoint.model_id,
    outputModalities: model.outputModalities,
    pricing: materializeEndpointPricing(endpoint),
    supportedParameters: endpoint.supported_parameters,
    zdr: true,
  };
}

function safeStringArray(values: readonly string[]): readonly string[] | null {
  const safe = values.map(safeProviderIdentifier);
  if (safe.some((value) => value === null)) {
    return null;
  }
  return safe as string[];
}

export function validateOpenRouterCatalogModel(
  exactModelId: string,
  zdrPayload: unknown,
  modelPayload: unknown,
  configuredMaximumOutputTokens: number,
  validatedAt = new Date(),
): OpenRouterCatalogSnapshot | null {
  if (!Number.isSafeInteger(configuredMaximumOutputTokens) || configuredMaximumOutputTokens <= 0) {
    return null;
  }
  const snapshot = validatedCatalogSnapshot(exactModelId, zdrPayload, modelPayload, validatedAt);
  if (
    snapshot === null ||
    configuredMaximumOutputTokens > snapshot.maximumOutputTokens ||
    configuredMaximumOutputTokens > snapshot.contextLength
  ) {
    return null;
  }
  return snapshot;
}

function validatedCatalogSnapshot(
  exactModelId: string,
  zdrPayload: unknown,
  modelPayload: unknown,
  validatedAt: Date,
): OpenRouterCatalogSnapshot | null {
  if (
    safeExactModelId(exactModelId) === null ||
    !isOpenRouterZdrEndpoints(zdrPayload) ||
    !isOpenRouterModelResponse(modelPayload)
  ) {
    return null;
  }
  const model = modelPayload.data;
  const inputModalities = safeStringArray(model.architecture.input_modalities);
  const outputModalities = safeStringArray(model.architecture.output_modalities);
  const supportedParameters = safeStringArray(model.supported_parameters);
  const canonicalSlug =
    model.canonical_slug === null ? null : safeProviderIdentifier(model.canonical_slug);
  const displayName = safeProviderIdentifier(model.name);
  if (
    model.id !== exactModelId ||
    (model.canonical_slug !== null && canonicalSlug === null) ||
    displayName === null ||
    inputModalities === null ||
    outputModalities === null ||
    supportedParameters === null
  ) {
    return null;
  }
  const metadata: OpenRouterModelMetadata = {
    canonicalSlug,
    contextLength: Math.min(
      model.context_length,
      model.top_provider?.context_length ?? model.context_length,
    ),
    displayName,
    inputModalities,
    maximumOutputTokens: model.top_provider?.max_completion_tokens ?? null,
    modelId: exactModelId,
    outputModalities,
    supportedParameters,
  };
  const endpoints = zdrPayload.data.flatMap((endpoint) =>
    isOpenRouterEndpoint(endpoint) ? [endpointMetadata(endpoint, metadata)] : [],
  );
  try {
    return buildOpenRouterCatalogSnapshot(metadata, endpoints, validatedAt);
  } catch (error: unknown) {
    if (error instanceof CatalogValidationError) {
      return null;
    }
    throw error;
  }
}

export class OpenRouterCatalogClient {
  readonly #apiKey: string;
  readonly #fetch: OpenRouterFetch;

  constructor(options: { readonly apiKey: string; readonly fetch?: OpenRouterFetch }) {
    if (options.apiKey.trim().length === 0) {
      throw new Error("OpenRouterCatalogClient requires a non-empty API key");
    }
    this.#apiKey = options.apiKey;
    this.#fetch = options.fetch ?? fetch;
  }

  async fetchZdrEndpoints(signal: AbortSignal): Promise<OpenRouterZdrEndpoints> {
    const payload = await this.#fetchJson(zdrEndpointsUrl, signal);
    if (!isOpenRouterZdrEndpoints(payload)) {
      throw new OpenRouterCatalogUnavailableError();
    }
    return payload;
  }

  async fetchExactModel(
    exactModelId: string,
    signal: AbortSignal,
  ): Promise<OpenRouterModelResponse | null> {
    const safeModelId = safeExactModelId(exactModelId);
    if (safeModelId === null) {
      return null;
    }
    const path = safeModelId.split("/").map(encodeURIComponent).join("/");
    const payload = await this.#fetchJson(`${exactModelBaseUrl}${path}`, signal, true);
    if (payload === null) {
      return null;
    }
    if (!isOpenRouterModelResponse(payload)) {
      return null;
    }
    return payload;
  }

  async loadSnapshots(
    modelIds: readonly string[],
    signal: AbortSignal,
  ): Promise<readonly OpenRouterCatalogSnapshot[]> {
    signal.throwIfAborted();
    const uniqueModelIds = [...new Set(modelIds)];
    if (uniqueModelIds.length === 0) {
      return Object.freeze([]);
    }
    const zdrPayload = await this.fetchZdrEndpoints(signal);
    const validatedAt = new Date();
    signal.throwIfAborted();
    const batchController = new AbortController();
    const abortBatch = (): void => {
      batchController.abort(signal.reason);
    };
    signal.addEventListener("abort", abortBatch, { once: true });
    let firstFailure: unknown;
    let failed = false;
    let settled: readonly PromiseSettledResult<{
      readonly modelId: string;
      readonly payload: OpenRouterModelResponse | null;
    }>[];
    try {
      settled = await Promise.allSettled(
        uniqueModelIds.map(async (modelId) => {
          try {
            return {
              modelId,
              payload: await this.fetchExactModel(modelId, batchController.signal),
            };
          } catch (error: unknown) {
            if (!signal.aborted && !failed) {
              failed = true;
              firstFailure = error;
              batchController.abort(error);
            }
            throw error;
          }
        }),
      );
    } finally {
      signal.removeEventListener("abort", abortBatch);
    }
    signal.throwIfAborted();
    if (failed) {
      throw firstFailure;
    }

    const snapshots: OpenRouterCatalogSnapshot[] = [];
    for (const result of settled) {
      if (result.status === "rejected") {
        throw new OpenRouterCatalogUnavailableError();
      }
      const { modelId, payload } = result.value;
      if (payload === null) {
        continue;
      }
      const snapshot = validatedCatalogSnapshot(modelId, zdrPayload, payload, validatedAt);
      if (snapshot !== null) {
        snapshots.push(snapshot);
      }
    }
    return Object.freeze(snapshots);
  }

  async #fetchJson(
    url: string,
    signal: AbortSignal,
    notFoundIsNull = false,
  ): Promise<unknown | null> {
    const timeoutController = new AbortController();
    const timeout = setTimeout(() => {
      timeoutController.abort(new DOMException("OpenRouter catalog timed out", "TimeoutError"));
    }, openRouterTuning.catalogTimeoutMilliseconds);
    try {
      signal.throwIfAborted();
      const response = await this.#fetch(url, {
        headers: {
          accept: "application/json",
          authorization: `Bearer ${this.#apiKey}`,
        },
        method: "GET",
        signal: AbortSignal.any([signal, timeoutController.signal]),
      });
      if (notFoundIsNull && response.status === 404) {
        await readBoundedJson(response, openRouterTuning.maximumErrorBodyBytes);
        return null;
      }
      if (!response.ok || !response.headers.get("content-type")?.toLowerCase().includes("json")) {
        await readBoundedJson(response, openRouterTuning.maximumErrorBodyBytes);
        throw new OpenRouterCatalogUnavailableError();
      }
      const payload = await readBoundedJson(response, openRouterTuning.maximumJsonBodyBytes);
      signal.throwIfAborted();
      if (payload === null) {
        throw new OpenRouterCatalogUnavailableError();
      }
      return payload;
    } catch (error: unknown) {
      if (signal.aborted) {
        if (signal.reason instanceof Error) {
          throw signal.reason;
        }
        throw new DOMException("OpenRouter catalog request was aborted", "AbortError");
      }
      if (error instanceof OpenRouterCatalogUnavailableError) {
        throw error;
      }
      throw new OpenRouterCatalogUnavailableError();
    } finally {
      clearTimeout(timeout);
    }
  }
}

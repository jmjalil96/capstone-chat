import { describe, expect, it } from "vitest";
import {
  OpenRouterCatalogClient,
  validateOpenRouterCatalogModel,
} from "../src/openrouter/catalog-client.js";
import type { OpenRouterFetch } from "../src/openrouter/openrouter-gateway.js";
import { readBoundedJson } from "../src/openrouter/provider-contract.js";

const exactModelId = "example/model-v1";
const validatedAt = new Date("2026-08-08T12:00:00.000Z");

function modelPayload(overrides: Record<string, unknown> = {}, modelId = exactModelId): unknown {
  return {
    data: {
      architecture: { input_modalities: ["text"], output_modalities: ["text"] },
      canonical_slug: `${modelId}-20260808`,
      context_length: 16_384,
      id: modelId,
      name: "Synthetic Model",
      supported_parameters: ["max_tokens", "reasoning", "temperature"],
      top_provider: { context_length: 16_000, max_completion_tokens: 4096 },
      ...overrides,
    },
  };
}

function endpoint(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    context_length: 16_000,
    max_completion_tokens: 4096,
    max_prompt_tokens: 12_000,
    model_id: exactModelId,
    pricing: {
      completion: "0.000003",
      image: "0",
      input_cache_read: "0.0000005",
      input_cache_write: "0.00000025",
      internal_reasoning: "0.000002",
      overrides: [
        {
          completion: "0.000004",
          input_cache_read: "0.000003",
          input_cache_write: "0.0000005",
          min_prompt_tokens: 10_000,
          prompt: "0.000002",
        },
      ],
      prompt: "0.000001",
      request: "0",
    },
    status: 0,
    supported_parameters: ["max_tokens", "reasoning", "temperature"],
    ...overrides,
  };
}

function endpointPricing(): Record<string, unknown> {
  const pricing = endpoint().pricing;
  if (pricing === null || typeof pricing !== "object" || Array.isArray(pricing)) {
    throw new Error("Synthetic endpoint pricing is invalid");
  }
  return pricing as Record<string, unknown>;
}

function endpointPricingWithoutRequest(): Record<string, unknown> {
  const pricing = endpointPricing();
  delete pricing.request;
  return pricing;
}

function modelPayloadWithoutTopProvider(modelId = exactModelId): unknown {
  const payload = modelPayload({}, modelId) as { data: Record<string, unknown> };
  delete payload.data.top_provider;
  return payload;
}

describe("OpenRouter catalog validation", () => {
  it("cancels a bounded JSON body after malformed UTF-8", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
      start(controller) {
        controller.enqueue(Uint8Array.from([0xc3, 0x28]));
      },
    });

    await expect(readBoundedJson(new Response(body), 128)).resolves.toBeNull();
    expect(cancelled).toBe(true);
  });

  it("joins exact text architecture with healthy ZDR endpoints and keeps conservative extrema", () => {
    const snapshot = validateOpenRouterCatalogModel(
      exactModelId,
      {
        data: [
          endpoint(),
          endpoint({
            context_length: 14_000,
            max_completion_tokens: 3072,
            max_prompt_tokens: 10_000,
            pricing: {
              completion: "0.0000035",
              discount: 0.5,
              image: "0",
              input_cache_read: "0.000001",
              input_cache_write: "0.00000025",
              internal_reasoning: "0.0000015",
              overrides: [
                { min_prompt_tokens: 8_000, prompt: "0.000004" },
                { input_cache_write: "0.000002", utc_start: 900, utc_end: 1700 },
              ],
              prompt: "0.0000015",
              request: "0.01",
            },
          }),
        ],
      },
      modelPayload(),
      2048,
      validatedAt,
    );

    expect(snapshot).toEqual({
      available: true,
      canonicalSlug: "example/model-v1-20260808",
      completionPricePerToken: "0.000006",
      contextLength: 10_000,
      displayName: "Synthetic Model",
      inputModalities: ["text"],
      maximumOutputTokens: 3072,
      metadataSource: "openrouter",
      modelId: exactModelId,
      outputModalities: ["text"],
      promptPricePerToken: "0.000006",
      requestPriceUsd: "0.01",
      supportedParameters: ["max_tokens", "reasoning"],
      validatedAt,
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
  });

  it.each([
    ["unhealthy endpoint", { status: 1 }, {}],
    ["missing reasoning support", { supported_parameters: ["max_tokens"] }, {}],
    ["nonzero image charge", { pricing: { ...endpointPricing(), image: "0.1" } }, {}],
    ["unknown charge dimension", { pricing: { ...endpointPricing(), future_charge: "0.1" } }, {}],
    ["conditional pricing", { pricing: { ...endpointPricing(), prompt: { if: "condition" } } }, {}],
    [
      "non-text model",
      {},
      { architecture: { input_modalities: ["image"], output_modalities: ["text"] } },
    ],
    ["model without reasoning", {}, { supported_parameters: ["max_tokens"] }],
  ])("fails closed for %s", (_name, endpointOverrides, modelOverrides) => {
    expect(
      validateOpenRouterCatalogModel(
        exactModelId,
        { data: [endpoint(endpointOverrides as Record<string, unknown>)] },
        modelPayload(modelOverrides as Record<string, unknown>),
        2048,
        validatedAt,
      ),
    ).toBeNull();
  });

  it("allows a bounded zero unsupported charge and ignores malformed endpoint entries", () => {
    const snapshot = validateOpenRouterCatalogModel(
      exactModelId,
      {
        data: [
          { model_id: exactModelId, pricing: "malformed" },
          endpoint({ pricing: { ...endpointPricing(), image_output: "0" } }),
        ],
      },
      modelPayload(),
      2048,
      validatedAt,
    );

    expect(snapshot).toMatchObject({ available: true, modelId: exactModelId });
  });

  it("canonicalizes parseable numeric price fields at the provider boundary", () => {
    const snapshot = validateOpenRouterCatalogModel(
      exactModelId,
      {
        data: [
          endpoint({
            pricing: { completion: 0.000003, image: 0, prompt: 0.000001, request: 0 },
          }),
        ],
      },
      modelPayload(),
      2048,
      validatedAt,
    );

    expect(snapshot).toMatchObject({
      completionPricePerToken: "0.000003",
      promptPricePerToken: "0.000001",
      requestPriceUsd: "0",
    });
  });

  it("normalizes only an omitted fixed-request price to explicit zero", () => {
    const omitted = validateOpenRouterCatalogModel(
      exactModelId,
      { data: [endpoint({ pricing: endpointPricingWithoutRequest() })] },
      modelPayload(),
      2048,
      validatedAt,
    );
    const explicit = validateOpenRouterCatalogModel(
      exactModelId,
      {
        data: [endpoint({ pricing: { ...endpointPricingWithoutRequest(), request: "0.01" } })],
      },
      modelPayload(),
      2048,
      validatedAt,
    );

    expect(omitted).toMatchObject({ requestPriceUsd: "0" });
    expect(explicit).toMatchObject({ requestPriceUsd: "0.01" });
    for (const request of [null, "not-a-decimal"]) {
      expect(
        validateOpenRouterCatalogModel(
          exactModelId,
          {
            data: [endpoint({ pricing: { ...endpointPricingWithoutRequest(), request } })],
          },
          modelPayload(),
          2048,
          validatedAt,
        ),
      ).toBeNull();
    }
  });

  it("derives a missing model output cap from fully eligible known endpoint limits", () => {
    const endpoints = [
      endpoint({ max_completion_tokens: 4096 }),
      endpoint({ max_completion_tokens: 3072 }),
      endpoint({ max_completion_tokens: null }),
      endpoint({ max_completion_tokens: 1024, status: 1 }),
      endpoint({ max_completion_tokens: 512, supported_parameters: ["max_tokens"] }),
      endpoint({
        max_completion_tokens: 256,
        pricing: { ...endpointPricing(), future_surcharge: "0.1" },
      }),
    ];
    const missingAggregatePayloads = [
      modelPayload({
        top_provider: { context_length: 16_000, max_completion_tokens: null },
      }),
      modelPayloadWithoutTopProvider(),
    ];

    for (const payload of missingAggregatePayloads) {
      expect(
        validateOpenRouterCatalogModel(
          exactModelId,
          { data: endpoints },
          payload,
          2048,
          validatedAt,
        ),
      ).toMatchObject({ maximumOutputTokens: 3072 });
    }
    expect(
      validateOpenRouterCatalogModel(
        exactModelId,
        { data: [endpoint({ max_completion_tokens: 4096 })] },
        modelPayload({
          top_provider: { context_length: 16_000, max_completion_tokens: 2048 },
        }),
        2048,
        validatedAt,
      ),
    ).toMatchObject({ maximumOutputTokens: 2048 });
  });

  it("fails closed without a known eligible endpoint cap or when the configured limit exceeds it", () => {
    const model = modelPayload({
      top_provider: { context_length: 16_000, max_completion_tokens: null },
    });

    expect(
      validateOpenRouterCatalogModel(
        exactModelId,
        { data: [endpoint({ max_completion_tokens: null })] },
        model,
        512,
        validatedAt,
      ),
    ).toBeNull();
    expect(
      validateOpenRouterCatalogModel(
        exactModelId,
        { data: [endpoint({ max_completion_tokens: 1024 })] },
        model,
        2048,
        validatedAt,
      ),
    ).toBeNull();
  });

  it.each([
    ["Fast", "deepseek/deepseek-v4-flash-0731", 4096, 32_768, 384_000],
    ["Balanced", "deepseek/deepseek-v4-pro", 8192, 16_384, 384_000],
    ["Pro", "moonshotai/kimi-k3", 16_384, 16_384, null],
  ])(
    "accepts the planned %s limit with current optional catalog fields",
    (_tier, modelId, configuredLimit, endpointLimit, aggregateLimit) => {
      const snapshot = validateOpenRouterCatalogModel(
        modelId,
        {
          data: [
            endpoint({
              context_length: 131_072,
              max_completion_tokens: endpointLimit,
              max_prompt_tokens: 131_072,
              model_id: modelId,
              pricing: endpointPricingWithoutRequest(),
            }),
          ],
        },
        modelPayload(
          {
            context_length: 1_048_576,
            top_provider: {
              context_length: 1_048_576,
              max_completion_tokens: aggregateLimit,
            },
          },
          modelId,
        ),
        configuredLimit,
        validatedAt,
      );

      expect(snapshot).toMatchObject({
        maximumOutputTokens: endpointLimit,
        modelId,
        requestPriceUsd: "0",
      });
    },
  );

  it("fails closed when the configured output allowance exceeds the endpoint contract", () => {
    expect(
      validateOpenRouterCatalogModel(
        exactModelId,
        { data: [endpoint({ max_completion_tokens: 1024 })] },
        modelPayload(),
        2048,
        validatedAt,
      ),
    ).toBeNull();
  });

  it("accepts exact model metadata with no canonical slug", () => {
    expect(
      validateOpenRouterCatalogModel(
        exactModelId,
        { data: [endpoint()] },
        modelPayload({ canonical_slug: null }),
        2048,
        validatedAt,
      ),
    ).toMatchObject({ canonicalSlug: null, modelId: exactModelId });
  });

  it("fetches only the authenticated ZDR and exact-model metadata endpoints", async () => {
    const calls: { headers: Headers; url: string }[] = [];
    const transport: OpenRouterFetch = async (input, init) => {
      const url = String(input);
      calls.push({ headers: new Headers(init?.headers), url });
      return new Response(
        JSON.stringify(url.endsWith("/endpoints/zdr") ? { data: [endpoint()] } : modelPayload()),
        { headers: { "content-type": "application/json" }, status: 200 },
      );
    };
    const client = new OpenRouterCatalogClient({
      apiKey: "test-key-never-sent",
      fetch: transport,
    });
    const signal = new AbortController().signal;
    await expect(client.fetchZdrEndpoints(signal)).resolves.toMatchObject({ data: [{}] });
    await expect(client.fetchExactModel(exactModelId, signal)).resolves.toMatchObject({
      data: { id: exactModelId },
    });
    expect(calls.map((call) => call.url)).toEqual([
      "https://openrouter.ai/api/v1/endpoints/zdr",
      "https://openrouter.ai/api/v1/model/example/model-v1",
    ]);
    expect(
      calls.every((call) => call.headers.get("authorization") === "Bearer test-key-never-sent"),
    ).toBe(true);
  });

  it("loads one ZDR batch and omits missing or confirmed-ineligible approved models", async () => {
    const missingModelId = "example/missing";
    const ineligibleModelId = "example/ineligible";
    const calls: string[] = [];
    const transport: OpenRouterFetch = async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/endpoints/zdr")) {
        return new Response(JSON.stringify({ data: [endpoint()] }), {
          headers: { "content-type": "application/json" },
          status: 200,
        });
      }
      if (url.endsWith("/example/missing")) {
        return new Response(JSON.stringify({ error: { code: 404 } }), {
          headers: { "content-type": "application/json" },
          status: 404,
        });
      }
      if (url.endsWith("/example/ineligible")) {
        return new Response(
          JSON.stringify(
            modelPayload(
              { architecture: { input_modalities: ["image"], output_modalities: ["text"] } },
              ineligibleModelId,
            ),
          ),
          { headers: { "content-type": "application/json" }, status: 200 },
        );
      }
      return new Response(JSON.stringify(modelPayload()), {
        headers: { "content-type": "application/json" },
        status: 200,
      });
    };
    const client = new OpenRouterCatalogClient({
      apiKey: "test-key-never-sent",
      fetch: transport,
    });

    const snapshots = await client.loadSnapshots(
      [exactModelId, missingModelId, ineligibleModelId, exactModelId],
      new AbortController().signal,
    );

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({ available: true, modelId: exactModelId });
    expect(calls.filter((url) => url.endsWith("/endpoints/zdr"))).toHaveLength(1);
    expect(calls.filter((url) => url.endsWith("/example/model-v1"))).toHaveLength(1);
  });

  it("omits exact metadata that a successful response confirms is invalid", async () => {
    const transport: OpenRouterFetch = async (input) => {
      const url = String(input);
      return new Response(
        JSON.stringify(
          url.endsWith("/endpoints/zdr")
            ? { data: [endpoint()] }
            : { data: { id: exactModelId, raw: "[not-recorded]" } },
        ),
        { headers: { "content-type": "application/json" }, status: 200 },
      );
    };
    const client = new OpenRouterCatalogClient({
      apiKey: "test-key-never-sent",
      fetch: transport,
    });

    await expect(
      client.loadSnapshots([exactModelId], new AbortController().signal),
    ).resolves.toEqual([]);
  });

  it("fails the whole batch on transport availability so the last good catalog survives", async () => {
    const client = new OpenRouterCatalogClient({
      apiKey: "test-key-never-sent",
      fetch: async (input) =>
        String(input).endsWith("/endpoints/zdr")
          ? new Response(JSON.stringify({ data: [endpoint()] }), {
              headers: { "content-type": "application/json" },
              status: 200,
            })
          : new Response(JSON.stringify({ error: { code: 503 } }), {
              headers: { "content-type": "application/json" },
              status: 503,
            }),
    });

    await expect(
      client.loadSnapshots([exactModelId], new AbortController().signal),
    ).rejects.toBeInstanceOf(Error);
  });

  it("aborts and joins sibling exact-model requests before rejecting a failed batch", async () => {
    const lifecycle: string[] = [];
    const transport: OpenRouterFetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith("/endpoints/zdr")) {
        return new Response(JSON.stringify({ data: [endpoint()] }), {
          headers: { "content-type": "application/json" },
          status: 200,
        });
      }
      if (url.endsWith("/example/failing")) {
        return new Response(JSON.stringify({ error: { code: 503 } }), {
          headers: { "content-type": "application/json" },
          status: 503,
        });
      }
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => {
            queueMicrotask(() => {
              lifecycle.push(`settled:${url}`);
              reject(init.signal?.reason ?? new DOMException("aborted", "AbortError"));
            });
          },
          { once: true },
        );
      });
    };
    const client = new OpenRouterCatalogClient({
      apiKey: "test-key-never-sent",
      fetch: transport,
    });

    const batch = client
      .loadSnapshots(
        ["example/failing", "example/pending-a", "example/pending-b"],
        new AbortController().signal,
      )
      .catch((error: unknown) => {
        lifecycle.push("batch:rejected");
        throw error;
      });

    await expect(batch).rejects.toBeInstanceOf(Error);
    expect(lifecycle).toEqual([
      "settled:https://openrouter.ai/api/v1/model/example/pending-a",
      "settled:https://openrouter.ai/api/v1/model/example/pending-b",
      "batch:rejected",
    ]);
  });

  it("aborts and joins the exact-model batch before propagating parent cancellation", async () => {
    const lifecycle: string[] = [];
    const parent = new AbortController();
    let exactRequestsStarted = 0;
    let markExactRequestsStarted: (() => void) | undefined;
    const allExactRequestsStarted = new Promise<void>((resolve) => {
      markExactRequestsStarted = resolve;
    });
    const transport: OpenRouterFetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith("/endpoints/zdr")) {
        return new Response(JSON.stringify({ data: [endpoint()] }), {
          headers: { "content-type": "application/json" },
          status: 200,
        });
      }
      exactRequestsStarted += 1;
      if (exactRequestsStarted === 2) {
        markExactRequestsStarted?.();
      }
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => {
            queueMicrotask(() => {
              lifecycle.push(`settled:${url}`);
              reject(init.signal?.reason ?? new DOMException("aborted", "AbortError"));
            });
          },
          { once: true },
        );
      });
    };
    const client = new OpenRouterCatalogClient({
      apiKey: "test-key-never-sent",
      fetch: transport,
    });
    const batch = client
      .loadSnapshots(["example/pending-a", "example/pending-b"], parent.signal)
      .catch((error: unknown) => {
        lifecycle.push("batch:rejected");
        throw error;
      });
    await allExactRequestsStarted;
    parent.abort(new DOMException("maintenance stopped", "AbortError"));

    await expect(batch).rejects.toMatchObject({ name: "AbortError" });
    expect(lifecycle).toEqual([
      "settled:https://openrouter.ai/api/v1/model/example/pending-a",
      "settled:https://openrouter.ai/api/v1/model/example/pending-b",
      "batch:rejected",
    ]);
  });
});

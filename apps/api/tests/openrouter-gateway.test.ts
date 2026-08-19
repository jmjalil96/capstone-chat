import { afterEach, describe, expect, it, vi } from "vitest";
import {
  compactionPrompt,
  serializeCompactionInput,
  serializeSummaryFrame,
} from "../src/generations/compaction-prompt.js";
import type { GatewayEvent, GenerationRequest } from "../src/generations/model-gateway.js";
import { type OpenRouterFetch, OpenRouterGateway } from "../src/openrouter/openrouter-gateway.js";

const request: GenerationRequest = {
  history: [{ role: "user", text: "[synthetic-history]" }],
  message: { role: "user", text: "[synthetic-request]" },
  modelTier: "balanced",
  purpose: "chat",
  route: {
    completionPriceCeilingUsdPerToken: "0.000003",
    maximumOutputTokens: 512,
    promptPriceCeilingUsdPerToken: "0.000002",
    requestPriceCeilingUsd: "0",
    requestedModel: "example/model-v1",
  },
  systemPrompt: { text: "[synthetic-system]", version: "test-v1" },
};

function streamResponse(
  chunks: readonly Uint8Array[],
  headers: Record<string, string> = {},
): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(chunk);
        }
        controller.close();
      },
    }),
    {
      headers: { "content-type": "text/event-stream; charset=utf-8", ...headers },
      status: 200,
    },
  );
}

function openStreamResponse(
  value: string,
  onCancel: () => void,
  contentType = "text/event-stream; charset=utf-8",
): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      cancel() {
        onCancel();
      },
      start(controller) {
        controller.enqueue(new TextEncoder().encode(value));
      },
    }),
    {
      headers: { "content-type": contentType },
      status: 200,
    },
  );
}

function encodedChunks(value: string, size: number): readonly Uint8Array[] {
  const encoded = new TextEncoder().encode(value);
  const chunks: Uint8Array[] = [];
  for (let index = 0; index < encoded.length; index += size) {
    chunks.push(encoded.slice(index, index + size));
  }
  return chunks;
}

async function collect(
  gateway: OpenRouterGateway,
  signal: AbortSignal = new AbortController().signal,
  includeTransportTiming = false,
): Promise<readonly GatewayEvent[]> {
  return collectRequest(gateway, request, signal, includeTransportTiming);
}

async function collectRequest(
  gateway: OpenRouterGateway,
  generationRequest: GenerationRequest,
  signal: AbortSignal = new AbortController().signal,
  includeTransportTiming = false,
): Promise<readonly GatewayEvent[]> {
  const events: GatewayEvent[] = [];
  for await (const event of gateway.stream(generationRequest, signal)) {
    if (includeTransportTiming || event.type === "generation.metadata") {
      events.push(event);
      continue;
    }
    const { transportElapsedMilliseconds: _transportElapsedMilliseconds, ...withoutTiming } = event;
    events.push(withoutTiming as GatewayEvent);
  }
  return events;
}

describe("OpenRouterGateway", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends the private route and normalizes split, multiline SSE without reasoning content", async () => {
    const captured: {
      body?: unknown;
      headers?: Headers;
      method?: string;
      redirect?: RequestInit["redirect"];
      url?: string;
    } = {};
    const sse = [
      ": OPENROUTER PROCESSING\n\n",
      'data: {"id":"gen-synthetic","model":"resolved/model-v1",\n',
      'data: "provider":"provider-a","choices":[{"index":0,"delta":{"content":"[delta-🧭]","reasoning":"[never-observed]"},"finish_reason":null}]}\n\n',
      'data: {"id":"gen-synthetic","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":11,"completion_tokens":7,"cost":"0.000123","prompt_tokens_details":{"cached_tokens":3},"completion_tokens_details":{"reasoning_tokens":2}}}\n\n',
      ": TERMINAL ACCOUNTING RECEIVED\n\n",
      "data: [DONE]\n\n",
    ].join("");
    const transport: OpenRouterFetch = async (input, init) => {
      captured.url = String(input);
      if (init?.method !== undefined) {
        captured.method = init.method;
      }
      captured.headers = new Headers(init?.headers);
      captured.redirect = init?.redirect;
      captured.body = JSON.parse(String(init?.body)) as unknown;
      return streamResponse(encodedChunks(sse, 5), {
        "x-generation-id": "gen-synthetic",
      });
    };
    const events = await collect(
      new OpenRouterGateway({ apiKey: "test-key-never-sent", fetch: transport }),
    );

    expect(captured.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(captured.method).toBe("POST");
    expect(captured.redirect).toBe("error");
    expect(captured.headers?.get("authorization")).toBe("Bearer test-key-never-sent");
    expect(captured.body).toEqual({
      max_tokens: 512,
      messages: [
        { content: "[synthetic-system]", role: "system" },
        { content: "[synthetic-history]", role: "user" },
        { content: "[synthetic-request]", role: "user" },
      ],
      model: "example/model-v1",
      provider: {
        data_collection: "deny",
        max_price: { completion: "3", prompt: "2", request: "0" },
        require_parameters: true,
        zdr: true,
      },
      reasoning: { exclude: true },
      stream: true,
    });
    expect(JSON.stringify(captured.body)).not.toMatch(
      /debug|session|stream_options|temperature|top_p|tools|usage\.include/u,
    );
    expect(events).toEqual([
      { type: "response.headers" },
      {
        metadata: { providerGenerationId: "gen-synthetic" },
        type: "generation.metadata",
      },
      {
        metadata: {
          provider: "provider-a",
          providerGenerationId: "gen-synthetic",
          resolvedModel: "resolved/model-v1",
        },
        type: "generation.metadata",
      },
      { text: "[delta-🧭]", type: "content.delta" },
      {
        accounting: {
          cachedTokens: 3,
          costUsd: "0.000123",
          metadata: {
            provider: "provider-a",
            providerGenerationId: "gen-synthetic",
            resolvedModel: "resolved/model-v1",
          },
          reasoningTokens: 2,
        },
        reason: "stop",
        type: "response.completed",
        usage: { inputTokens: 11, outputTokens: 7 },
      },
    ]);
    expect(JSON.stringify(events)).not.toContain("never-observed");
  });

  it("emits the header boundary before delayed SSE even without a generation response header", async () => {
    let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          bodyController = controller;
        },
      }),
      { headers: { "content-type": "text/event-stream" }, status: 200 },
    );
    const gateway = new OpenRouterGateway({
      apiKey: "test-key-never-sent",
      fetch: async () => response,
    });
    const iterator = gateway.stream(request, new AbortController().signal)[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: {
        transportElapsedMilliseconds: expect.any(Number),
        type: "response.headers",
      },
    });

    const sse = [
      'data: {"id":"gen-delayed","model":"resolved/model-v1","provider":"provider-delayed","choices":[{"index":0,"delta":{"content":"[delayed]"},"finish_reason":null}]}\n\n',
      'data: {"id":"gen-delayed","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"cost":"0.000001"}}\n\n',
      "data: [DONE]\n\n",
    ].join("");
    bodyController?.enqueue(new TextEncoder().encode(sse));
    bodyController?.close();

    const remaining: GatewayEvent[] = [];
    for (;;) {
      const result = await iterator.next();
      if (result.done) {
        break;
      }
      remaining.push(result.value);
    }
    expect(remaining.map((event) => event.type)).toEqual([
      "generation.metadata",
      "content.delta",
      "response.completed",
    ]);
  });

  it("excludes async-iterator consumer suspension from transport milestones", async () => {
    vi.useFakeTimers();
    const sse = [
      'data: {"id":"gen-suspended","model":"resolved/model-v1","provider":"provider-suspended","choices":[{"index":0,"delta":{"content":"[visible]"},"finish_reason":null}]}\n\n',
      'data: {"id":"gen-suspended","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"cost":"0.000001"}}\n\n',
      "data: [DONE]\n\n",
    ].join("");
    const iterator = new OpenRouterGateway({
      apiKey: "test-key-never-sent",
      fetch: async () =>
        streamResponse([new TextEncoder().encode(sse)], {
          "x-generation-id": "gen-suspended",
        }),
    })
      .stream(request, new AbortController().signal)
      [Symbol.asyncIterator]();

    const events: GatewayEvent[] = [];
    for (const suspensionMilliseconds of [0, 5_000, 7_000, 11_000, 13_000]) {
      await vi.advanceTimersByTimeAsync(suspensionMilliseconds);
      const result = await iterator.next();
      expect(result.done).toBe(false);
      if (!result.done) {
        events.push(result.value);
      }
    }
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });

    expect(events.map((event) => event.type)).toEqual([
      "response.headers",
      "generation.metadata",
      "generation.metadata",
      "content.delta",
      "response.completed",
    ]);
    const headers = events[0];
    const firstToken = events[3];
    const terminal = events[4];
    expect(headers?.type).toBe("response.headers");
    expect(firstToken?.type).toBe("content.delta");
    expect(terminal?.type).toBe("response.completed");
    if (
      headers?.type !== "response.headers" ||
      firstToken?.type !== "content.delta" ||
      terminal?.type !== "response.completed"
    ) {
      throw new Error("Synthetic OpenRouter lifecycle was incomplete");
    }
    expect(headers.transportElapsedMilliseconds).toBeLessThan(10);
    expect(firstToken.transportElapsedMilliseconds).toBeLessThan(10);
    expect(terminal.transportElapsedMilliseconds).toBeLessThan(10);
  });

  it("emits the header boundary before reading a delayed HTTP error body", async () => {
    let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          bodyController = controller;
        },
      }),
      { headers: { "content-type": "application/json" }, status: 503 },
    );
    const gateway = new OpenRouterGateway({
      apiKey: "test-key-never-sent",
      fetch: async () => response,
    });
    const iterator = gateway.stream(request, new AbortController().signal)[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: {
        transportElapsedMilliseconds: expect.any(Number),
        type: "response.headers",
      },
    });
    const terminal = iterator.next();
    let terminalSettled = false;
    void terminal.finally(() => {
      terminalSettled = true;
    });
    await Promise.resolve();
    expect(terminalSettled).toBe(false);

    bodyController?.enqueue(
      new TextEncoder().encode(
        JSON.stringify({ error: { code: 503, metadata: { error_type: "server" } } }),
      ),
    );
    bodyController?.close();
    await expect(terminal).resolves.toMatchObject({
      done: false,
      value: {
        errorCode: "GENERATION_FAILED",
        providerErrorType: "server",
        transportElapsedMilliseconds: expect.any(Number),
        type: "response.failed",
      },
    });
  });

  it("serializes typed derived context in its exact chat wire position", async () => {
    let capturedBody: { readonly messages?: unknown } | undefined;
    const sse = [
      'data: {"id":"gen-derived","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"cost":"0"}}\n\n',
      "data: [DONE]\n\n",
    ].join("");
    const derivedRequest: GenerationRequest = {
      ...request,
      derivedContext: { kind: "compaction-summary", summary: 'Prior "summary"' },
      history: [
        { role: "user", text: "Recent question" },
        { role: "assistant", text: "Recent answer" },
      ],
    };
    await collectRequest(
      new OpenRouterGateway({
        apiKey: "test-key-never-sent",
        fetch: async (_input, init) => {
          capturedBody = JSON.parse(String(init?.body)) as { readonly messages?: unknown };
          return streamResponse([new TextEncoder().encode(sse)]);
        },
      }),
      derivedRequest,
    );

    expect(capturedBody?.messages).toEqual([
      { content: "[synthetic-system]", role: "system" },
      { content: serializeSummaryFrame('Prior "summary"'), role: "user" },
      { content: "Recent question", role: "user" },
      { content: "Recent answer", role: "assistant" },
      { content: "[synthetic-request]", role: "user" },
    ]);
  });

  it("serializes compaction as exactly one system and one deterministic JSON user message", async () => {
    let capturedBody: { readonly messages?: unknown } | undefined;
    const input = serializeCompactionInput({
      messages: [
        { role: "user", text: "Earlier question" },
        { role: "assistant", text: "Earlier answer" },
      ],
      previousSummary: null,
    });
    const compactionRequest: GenerationRequest = {
      history: [],
      message: { role: "user", text: input },
      modelTier: "fast",
      purpose: "compaction",
      ...(request.route === undefined ? {} : { route: request.route }),
      systemPrompt: compactionPrompt,
    };
    const sse = [
      'data: {"id":"gen-compaction","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"cost":"0"}}\n\n',
      "data: [DONE]\n\n",
    ].join("");
    await collectRequest(
      new OpenRouterGateway({
        apiKey: "test-key-never-sent",
        fetch: async (_request, init) => {
          capturedBody = JSON.parse(String(init?.body)) as { readonly messages?: unknown };
          return streamResponse([new TextEncoder().encode(sse)]);
        },
      }),
      compactionRequest,
    );

    expect(capturedBody?.messages).toEqual([
      { content: compactionPrompt.text, role: "system" },
      { content: input, role: "user" },
    ]);
  });

  it("disables hidden reasoning only for title requests", async () => {
    const bodies: Record<string, unknown>[] = [];
    const sse = [
      'data: {"id":"gen-title","choices":[{"index":0,"delta":{"content":"Título"},"finish_reason":null}]}\n\n',
      'data: {"id":"gen-title","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"cost":"0"}}\n\n',
      "data: [DONE]\n\n",
    ].join("");
    const gateway = new OpenRouterGateway({
      apiKey: "test-key-never-sent",
      fetch: async (_request, init) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return streamResponse([new TextEncoder().encode(sse)]);
      },
    });
    const titleRequest: GenerationRequest = {
      history: [],
      message: { role: "user", text: "[synthetic-title-input]" },
      modelTier: "fast",
      purpose: "title",
      ...(request.route === undefined ? {} : { route: request.route }),
      systemPrompt: { text: "[synthetic-title-prompt]", version: "capstone-title-v1" },
    };

    await collectRequest(gateway, titleRequest);
    await collectRequest(gateway, request);

    expect(bodies[0]?.reasoning).toEqual({ enabled: false, exclude: true });
    expect(bodies[1]?.reasoning).toEqual({ exclude: true });
  });

  it("cancels an open upstream body after protocol completion", async () => {
    const cancelled = vi.fn();
    const sse = [
      'data: {"id":"gen-open","provider":"provider-open","choices":[{"index":0,"delta":{"content":"[delta]"},"finish_reason":null}]}\n\n',
      'data: {"id":"gen-open","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"cost":"0"}}\n\n',
      "data: [DONE]\n\n",
    ].join("");

    const events = await collect(
      new OpenRouterGateway({
        apiKey: "test-key-never-sent",
        fetch: async () => openStreamResponse(sse, cancelled),
      }),
    );

    expect(events.at(-1)).toMatchObject({ reason: "stop", type: "response.completed" });
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it("rejects data after terminal usage while preserving its authoritative accounting", async () => {
    const calls: string[] = [];
    const sse = [
      'data: {"id":"gen-terminal","choices":[{"index":0,"delta":{"content":"[before]"},"finish_reason":null}]}\n\n',
      'data: {"id":"gen-terminal","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":9,"completion_tokens":4,"cost":"0.00007"}}\n\n',
      ": SAFE COMMENT\n\n",
      'data: {"id":"gen-terminal","choices":[{"index":0,"delta":{"content":"[after]"},"finish_reason":null}]}\n\n',
      "data: [DONE]\n\n",
    ].join("");
    const events = await collect(
      new OpenRouterGateway({
        apiKey: "test-key-never-sent",
        fetch: async (input) => {
          calls.push(String(input));
          return streamResponse([new TextEncoder().encode(sse)]);
        },
      }),
    );

    expect(calls).toEqual(["https://openrouter.ai/api/v1/chat/completions"]);
    expect(events).toEqual([
      { type: "response.headers" },
      {
        metadata: { providerGenerationId: "gen-terminal" },
        type: "generation.metadata",
      },
      { text: "[before]", type: "content.delta" },
      {
        accounting: {
          actual: {
            costUsd: "0.00007",
            metadata: { providerGenerationId: "gen-terminal" },
          },
          metadata: { providerGenerationId: "gen-terminal" },
          spendRisk: "unknown",
        },
        errorCode: "GENERATION_FAILED",
        type: "response.failed",
        usage: { inputTokens: 9, outputTokens: 4 },
      },
    ]);
    expect(JSON.stringify(events)).not.toContain("[after]");
  });

  it("cancels an open upstream body when its successful content type is invalid", async () => {
    const cancelled = vi.fn();
    const events = await collect(
      new OpenRouterGateway({
        apiKey: "test-key-never-sent",
        fetch: async () => openStreamResponse("[not-read]", cancelled, "application/json"),
      }),
    );

    expect(events.at(-1)).toMatchObject({
      accounting: { spendRisk: "unknown" },
      errorCode: "GENERATION_FAILED",
      type: "response.failed",
    });
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it("looks up authoritative usage before completing a typed refusal", async () => {
    const calls: string[] = [];
    const transport: OpenRouterFetch = async (input) => {
      calls.push(String(input));
      if (calls.length === 1) {
        return new Response(
          JSON.stringify({
            error: {
              code: 400,
              message: "[raw-provider-prose]",
              metadata: { error_type: "refusal" },
            },
          }),
          {
            headers: { "content-type": "application/json", "x-generation-id": "gen-refusal" },
            status: 400,
          },
        );
      }
      return new Response(
        JSON.stringify({
          data: {
            id: "gen-refusal",
            model: "resolved/model-v1",
            native_tokens_cached: 1,
            native_tokens_reasoning: 0,
            provider_name: "provider-b",
            tokens_completion: 2,
            tokens_prompt: 5,
            total_cost: 0.00004,
          },
        }),
        { headers: { "content-type": "application/json" }, status: 200 },
      );
    };

    const events = await collect(
      new OpenRouterGateway({ apiKey: "test-key-never-sent", fetch: transport }),
    );

    expect(calls).toEqual([
      "https://openrouter.ai/api/v1/chat/completions",
      "https://openrouter.ai/api/v1/generation?id=gen-refusal",
    ]);
    expect(events).toEqual([
      { type: "response.headers" },
      {
        accounting: {
          cachedTokens: 1,
          costUsd: "0.00004",
          metadata: {
            provider: "provider-b",
            providerGenerationId: "gen-refusal",
            resolvedModel: "resolved/model-v1",
          },
          reasoningTokens: 0,
        },
        reason: "refusal",
        type: "response.completed",
        usage: { inputTokens: 5, outputTokens: 2 },
      },
    ]);
    expect(JSON.stringify(events)).not.toContain("raw-provider-prose");
  });

  it("recovers provider metadata for a streamed content-policy terminal", async () => {
    const calls: string[] = [];
    const sse = [
      'data: {"id":"gen-filter","error":{"code":400,"message":"[raw]","metadata":{"error_type":"content_policy_violation"}},"usage":{"prompt_tokens":4,"completion_tokens":0,"cost":"0.00001"}}\n\n',
      "data: [DONE]\n\n",
    ].join("");
    const events = await collect(
      new OpenRouterGateway({
        apiKey: "test-key-never-sent",
        fetch: async (input) => {
          calls.push(String(input));
          if (calls.length === 1) {
            return streamResponse(encodedChunks(sse, 13));
          }
          return new Response(
            JSON.stringify({
              data: {
                id: "gen-filter",
                provider_name: "provider-filter",
                tokens_completion: 99,
                tokens_prompt: 99,
                total_cost: "0.9",
              },
            }),
            { headers: { "content-type": "application/json" }, status: 200 },
          );
        },
      }),
    );
    expect(calls).toEqual([
      "https://openrouter.ai/api/v1/chat/completions",
      "https://openrouter.ai/api/v1/generation?id=gen-filter",
    ]);
    expect(events).toEqual([
      { type: "response.headers" },
      {
        metadata: { providerGenerationId: "gen-filter" },
        type: "generation.metadata",
      },
      {
        accounting: {
          costUsd: "0.00001",
          metadata: {
            provider: "provider-filter",
            providerGenerationId: "gen-filter",
          },
        },
        reason: "content_filter",
        type: "response.completed",
        usage: { inputTokens: 4, outputTokens: 0 },
      },
    ]);
  });

  it("preserves authoritative usage for a validation error returned after streaming begins", async () => {
    const sse = [
      'data: {"id":"gen-stream-validation","error":{"code":400,"message":"[raw]","metadata":{"error_type":"invalid_request"}},"usage":{"prompt_tokens":4,"completion_tokens":1,"cost":"0.00002"}}\n\n',
      "data: [DONE]\n\n",
    ].join("");
    const events = await collect(
      new OpenRouterGateway({
        apiKey: "test-key-never-sent",
        fetch: async () => streamResponse(encodedChunks(sse, 13)),
      }),
    );

    expect(events).toEqual([
      { type: "response.headers" },
      {
        metadata: { providerGenerationId: "gen-stream-validation" },
        type: "generation.metadata",
      },
      {
        accounting: {
          actual: {
            costUsd: "0.00002",
            metadata: { providerGenerationId: "gen-stream-validation" },
          },
          metadata: { providerGenerationId: "gen-stream-validation" },
          spendRisk: "unknown",
        },
        errorCode: "GENERATION_FAILED",
        providerErrorType: "invalid_request",
        type: "response.failed",
        usage: { inputTokens: 4, outputTokens: 1 },
      },
    ]);
  });

  it("recovers missing final stream usage through one bounded generation lookup", async () => {
    const calls: string[] = [];
    const transport: OpenRouterFetch = async (input) => {
      calls.push(String(input));
      if (calls.length === 1) {
        const sse = [
          'data: {"id":"gen-recovered","choices":[{"index":0,"delta":{"content":"[delta]"},"finish_reason":"stop"}]}\n\n',
          "data: [DONE]\n\n",
        ].join("");
        return streamResponse(encodedChunks(sse, 7));
      }
      return new Response(
        JSON.stringify({
          data: {
            id: "gen-recovered",
            model: "resolved/model-v1",
            provider_name: "provider-c",
            tokens_completion: 3,
            tokens_prompt: 8,
            total_cost: "0.00005",
          },
        }),
        { headers: { "content-type": "application/json" }, status: 200 },
      );
    };

    const events = await collect(
      new OpenRouterGateway({ apiKey: "test-key-never-sent", fetch: transport }),
    );

    expect(calls).toEqual([
      "https://openrouter.ai/api/v1/chat/completions",
      "https://openrouter.ai/api/v1/generation?id=gen-recovered",
    ]);
    expect(events).toEqual([
      { type: "response.headers" },
      {
        metadata: { providerGenerationId: "gen-recovered" },
        type: "generation.metadata",
      },
      { text: "[delta]", type: "content.delta" },
      {
        accounting: {
          costUsd: "0.00005",
          metadata: {
            provider: "provider-c",
            providerGenerationId: "gen-recovered",
            resolvedModel: "resolved/model-v1",
          },
        },
        reason: "stop",
        type: "response.completed",
        usage: { inputTokens: 8, outputTokens: 3 },
      },
    ]);
  });

  it("recovers a missing provider without replacing authoritative stream usage", async () => {
    const calls: string[] = [];
    const transport: OpenRouterFetch = async (input) => {
      calls.push(String(input));
      if (calls.length === 1) {
        const sse = [
          'data: {"id":"gen-provider-recovery","model":"resolved/model-v1","choices":[{"index":0,"delta":{"content":"[delta]"},"finish_reason":null}]}\n\n',
          'data: {"id":"gen-provider-recovery","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":11,"completion_tokens":7,"cost":"0.000123"}}\n\n',
          "data: [DONE]\n\n",
        ].join("");
        return streamResponse(encodedChunks(sse, 9));
      }
      return new Response(
        JSON.stringify({
          data: {
            id: "gen-provider-recovery",
            model: "resolved/model-v1",
            provider_name: "provider-recovered",
            tokens_completion: 700,
            tokens_prompt: 1_100,
            total_cost: "0.9",
          },
        }),
        { headers: { "content-type": "application/json" }, status: 200 },
      );
    };

    const events = await collect(
      new OpenRouterGateway({ apiKey: "test-key-never-sent", fetch: transport }),
    );

    expect(calls).toEqual([
      "https://openrouter.ai/api/v1/chat/completions",
      "https://openrouter.ai/api/v1/generation?id=gen-provider-recovery",
    ]);
    expect(events.at(-1)).toEqual({
      accounting: {
        costUsd: "0.000123",
        metadata: {
          provider: "provider-recovered",
          providerGenerationId: "gen-provider-recovery",
          resolvedModel: "resolved/model-v1",
        },
      },
      reason: "stop",
      type: "response.completed",
      usage: { inputTokens: 11, outputTokens: 7 },
    });
  });

  it("fails closed when provider recovery omits the provider while retaining actual accounting", async () => {
    const calls: string[] = [];
    const events = await collect(
      new OpenRouterGateway({
        apiKey: "test-key-never-sent",
        fetch: async (input) => {
          calls.push(String(input));
          if (calls.length === 1) {
            const sse = [
              'data: {"id":"gen-provider-missing","choices":[{"index":0,"delta":{"content":"[delta]"},"finish_reason":null}]}\n\n',
              'data: {"id":"gen-provider-missing","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":2,"cost":"0.00004"}}\n\n',
              "data: [DONE]\n\n",
            ].join("");
            return streamResponse(encodedChunks(sse, 10));
          }
          return new Response(
            JSON.stringify({
              data: {
                id: "gen-provider-missing",
                tokens_completion: 2,
                tokens_prompt: 5,
                total_cost: "0.00004",
              },
            }),
            { headers: { "content-type": "application/json" }, status: 200 },
          );
        },
      }),
    );

    expect(calls).toHaveLength(2);
    expect(events.at(-1)).toEqual({
      accounting: {
        actual: {
          costUsd: "0.00004",
          metadata: { providerGenerationId: "gen-provider-missing" },
        },
        metadata: { providerGenerationId: "gen-provider-missing" },
        spendRisk: "unknown",
      },
      errorCode: "GENERATION_FAILED",
      type: "response.failed",
      usage: { inputTokens: 5, outputTokens: 2 },
      usageLookupAttempted: true,
    });
  });

  it("reports an exhausted missing-usage lookup so no second owner retries it", async () => {
    const calls: string[] = [];
    const events = await collect(
      new OpenRouterGateway({
        apiKey: "test-key-never-sent",
        fetch: async (input) => {
          calls.push(String(input));
          if (calls.length === 1) {
            const sse = [
              'data: {"id":"gen-unavailable","choices":[{"index":0,"delta":{"content":"[delta]"},"finish_reason":"stop"}]}\n\n',
              "data: [DONE]\n\n",
            ].join("");
            return streamResponse(encodedChunks(sse, 11));
          }
          return new Response("{}", {
            headers: { "content-type": "application/json" },
            status: 503,
          });
        },
      }),
    );

    expect(calls).toEqual([
      "https://openrouter.ai/api/v1/chat/completions",
      "https://openrouter.ai/api/v1/generation?id=gen-unavailable",
    ]);
    expect(events.at(-1)).toEqual({
      accounting: {
        metadata: { providerGenerationId: "gen-unavailable" },
        spendRisk: "unknown",
      },
      errorCode: "GENERATION_FAILED",
      type: "response.failed",
      usageLookupAttempted: true,
    });
  });

  it("marks a completed lookup before rejecting conflicting post-content metadata", async () => {
    const calls: string[] = [];
    const events = await collect(
      new OpenRouterGateway({
        apiKey: "test-key-never-sent",
        fetch: async (input) => {
          calls.push(String(input));
          if (calls.length === 1) {
            const sse = [
              'data: {"id":"gen-conflict","model":"first/model","choices":[{"index":0,"delta":{"content":"[delta]"},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2,"cost":"0.00001"}}\n\n',
              "data: [DONE]\n\n",
            ].join("");
            return streamResponse(encodedChunks(sse, 13));
          }
          return new Response(
            JSON.stringify({
              data: {
                id: "gen-conflict",
                model: "second/model",
                provider_name: "provider-conflict",
                tokens_completion: 2,
                tokens_prompt: 3,
                total_cost: "0.9",
              },
            }),
            { headers: { "content-type": "application/json" }, status: 200 },
          );
        },
      }),
    );

    expect(calls).toHaveLength(2);
    expect(events.at(-1)).toEqual({
      accounting: {
        actual: {
          costUsd: "0.00001",
          metadata: {
            providerGenerationId: "gen-conflict",
            resolvedModel: "first/model",
          },
        },
        metadata: {
          providerGenerationId: "gen-conflict",
          resolvedModel: "first/model",
        },
        spendRisk: "unknown",
      },
      errorCode: "GENERATION_FAILED",
      type: "response.failed",
      usage: { inputTokens: 3, outputTokens: 2 },
      usageLookupAttempted: true,
    });
  });

  it("reports one exhausted lookup for a typed provider outcome with an ID", async () => {
    const calls: string[] = [];
    const events = await collect(
      new OpenRouterGateway({
        apiKey: "test-key-never-sent",
        fetch: async (input) => {
          calls.push(String(input));
          if (calls.length === 1) {
            return new Response(
              JSON.stringify({
                error: {
                  code: 400,
                  metadata: { error_type: "content_policy_violation" },
                },
              }),
              {
                headers: {
                  "content-type": "application/json",
                  "x-generation-id": "gen-filter-unavailable",
                },
                status: 400,
              },
            );
          }
          return new Response("{}", {
            headers: { "content-type": "application/json" },
            status: 503,
          });
        },
      }),
    );

    expect(calls).toEqual([
      "https://openrouter.ai/api/v1/chat/completions",
      "https://openrouter.ai/api/v1/generation?id=gen-filter-unavailable",
    ]);
    expect(events).toEqual([
      { type: "response.headers" },
      {
        accounting: {
          metadata: { providerGenerationId: "gen-filter-unavailable" },
          spendRisk: "unknown",
        },
        errorCode: "GENERATION_FAILED",
        providerErrorType: "content_policy_violation",
        providerOutcome: "content_filter",
        type: "response.failed",
        usageLookupAttempted: true,
      },
    ]);
  });

  it("keeps typed policy outcomes ambiguous when authoritative usage cannot be recovered", async () => {
    const events = await collect(
      new OpenRouterGateway({
        apiKey: "test-key-never-sent",
        fetch: async () =>
          new Response(
            JSON.stringify({
              error: {
                code: 400,
                message: "[raw]",
                metadata: { error_type: "content_policy_violation" },
              },
            }),
            { headers: { "content-type": "application/json" }, status: 400 },
          ),
      }),
    );
    expect(events).toEqual([
      { type: "response.headers" },
      {
        accounting: { spendRisk: "unknown" },
        errorCode: "GENERATION_FAILED",
        providerErrorType: "content_policy_violation",
        providerOutcome: "content_filter",
        type: "response.failed",
      },
    ]);
  });

  it.each([
    {
      errorCode: "GENERATION_FAILED",
      providerErrorType: "authentication",
      spendRisk: "none",
    },
    {
      errorCode: "MODEL_UNAVAILABLE",
      providerErrorType: "not_found",
      spendRisk: "none",
    },
    {
      errorCode: "GENERATION_FAILED",
      providerErrorType: "server",
      spendRisk: "unknown",
    },
  ] as const)(
    "classifies pre-provider $providerErrorType failures with $spendRisk spend risk",
    async ({ errorCode, providerErrorType, spendRisk }) => {
      const events = await collect(
        new OpenRouterGateway({
          apiKey: "test-key-never-sent",
          fetch: async () =>
            new Response(
              JSON.stringify({
                error: {
                  code: 400,
                  message: "[raw]",
                  metadata: { error_type: providerErrorType },
                },
              }),
              { headers: { "content-type": "application/json" }, status: 400 },
            ),
        }),
      );

      expect(events).toEqual([
        { type: "response.headers" },
        {
          accounting: { spendRisk },
          errorCode,
          providerErrorType,
          type: "response.failed",
        },
      ]);
    },
  );

  it("rejects missing final usage and oversized SSE events without exposing their payloads", async () => {
    const missingUsage = [
      'data: {"choices":[{"delta":{"content":"[delta]"},"finish_reason":"stop"}]}\n\n',
      "data: [DONE]\n\n",
    ].join("");
    const oversized = `data: ${"x".repeat(65_537)}\n\n`;
    for (const sse of [missingUsage, oversized]) {
      const events = await collect(
        new OpenRouterGateway({
          apiKey: "test-key-never-sent",
          fetch: async () => streamResponse(encodedChunks(sse, 4096)),
        }),
      );
      expect(events.at(-1)).toMatchObject({
        accounting: { spendRisk: "unknown" },
        errorCode: "GENERATION_FAILED",
        type: "response.failed",
      });
      expect(JSON.stringify(events)).not.toContain("x".repeat(100));
    }
  });

  it.each([
    ["malformed JSON", 'data: {"choices":\n\n'],
    ["an oversized event", `data: ${"x".repeat(65_537)}\n\n`],
  ])("cancels an open upstream body after rejecting %s", async (_label, sse) => {
    const cancelled = vi.fn();
    const events = await collect(
      new OpenRouterGateway({
        apiKey: "test-key-never-sent",
        fetch: async () => openStreamResponse(sse, cancelled),
      }),
    );

    expect(events.at(-1)).toMatchObject({
      accounting: { spendRisk: "unknown" },
      errorCode: "GENERATION_FAILED",
      type: "response.failed",
    });
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it("bounds the aggregate queue when one upstream chunk contains many SSE events", async () => {
    const event = 'data: {"choices":[{"delta":{"content":"[delta]"},"finish_reason":null}]}\n\n';
    const burst = `${event.repeat(129)}data: [DONE]\n\n`;
    const events = await collect(
      new OpenRouterGateway({
        apiKey: "test-key-never-sent",
        fetch: async () => streamResponse([new TextEncoder().encode(burst)]),
      }),
    );

    expect(events).toEqual([
      { type: "response.headers" },
      {
        accounting: { spendRisk: "unknown" },
        errorCode: "GENERATION_FAILED",
        type: "response.failed",
      },
    ]);
  });

  it("rejects unsupported control characters before forwarding provider output", async () => {
    const sse = [
      'data: {"choices":[{"delta":{"content":"unsafe\\u0001text"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"cost":"0"}}\n\n',
      "data: [DONE]\n\n",
    ].join("");
    const events = await collect(
      new OpenRouterGateway({
        apiKey: "test-key-never-sent",
        fetch: async () => streamResponse(encodedChunks(sse, 11)),
      }),
    );

    expect(events).toEqual([
      { type: "response.headers" },
      {
        accounting: {
          actual: { costUsd: "0", metadata: {} },
          spendRisk: "unknown",
        },
        errorCode: "GENERATION_FAILED",
        type: "response.failed",
        usage: { inputTokens: 1, outputTokens: 1 },
      },
    ]);
  });

  it("classifies the header timeout and propagates employee abort", async () => {
    vi.useFakeTimers();
    const hangingTransport: OpenRouterFetch = async (_input, init) =>
      await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(init.signal?.reason ?? new DOMException("aborted", "AbortError")),
          { once: true },
        );
      });
    const gateway = new OpenRouterGateway({
      apiKey: "test-key-never-sent",
      fetch: hangingTransport,
    });
    const timedOut = collect(gateway, new AbortController().signal, true);
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(timedOut).resolves.toEqual([
      {
        accounting: { spendRisk: "unknown" },
        errorCode: "GENERATION_TIMEOUT",
        providerErrorType: "timeout",
        transportElapsedMilliseconds: 10_000,
        type: "response.failed",
      },
    ]);

    const controller = new AbortController();
    const aborted = collect(gateway, controller.signal);
    controller.abort();
    await expect(aborted).rejects.toMatchObject({ name: "AbortError" });
  });

  it("starts the first-token timeout before publishing successful SSE headers", async () => {
    vi.useFakeTimers();
    const gateway = new OpenRouterGateway({
      apiKey: "test-key-never-sent",
      fetch: async (_input, init) =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              init?.signal?.addEventListener(
                "abort",
                () =>
                  controller.error(
                    init.signal?.reason ?? new DOMException("aborted", "AbortError"),
                  ),
                { once: true },
              );
            },
          }),
          { headers: { "content-type": "text/event-stream" }, status: 200 },
        ),
    });
    const iterator = gateway.stream(request, new AbortController().signal)[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { type: "response.headers" },
    });
    await vi.advanceTimersByTimeAsync(60_000);
    const terminal = await iterator.next();

    expect(terminal).toMatchObject({
      done: false,
      value: {
        errorCode: "GENERATION_TIMEOUT",
        providerErrorType: "timeout",
        type: "response.failed",
      },
    });
    if (!terminal.done && terminal.value.type === "response.failed") {
      expect(terminal.value.transportElapsedMilliseconds).toBeLessThan(10);
    }
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
  });

  it.each([
    ["first visible token", ": processing\n\n", 5_000, 60_000, false],
    [
      "inactivity",
      'data: {"choices":[{"delta":{"content":"[delta]"},"finish_reason":null}]}\n\n',
      null,
      45_000,
      true,
    ],
    [
      "total generation",
      'data: {"choices":[{"delta":{"content":"[delta]"},"finish_reason":null}]}\n\n',
      25_000,
      5 * 60_000,
      true,
    ],
  ] as const)(
    "normalizes the %s timeout independently",
    async (_name, initialText, heartbeatMilliseconds, elapsedMilliseconds, emitsDelta) => {
      vi.useFakeTimers();
      const transport: OpenRouterFetch = async (_input, init) => {
        const signal = init?.signal;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(initialText));
            const heartbeat =
              heartbeatMilliseconds === null
                ? null
                : setInterval(() => {
                    controller.enqueue(new TextEncoder().encode(": heartbeat\n\n"));
                  }, heartbeatMilliseconds);
            signal?.addEventListener(
              "abort",
              () => {
                if (heartbeat !== null) {
                  clearInterval(heartbeat);
                }
                controller.error(signal.reason ?? new DOMException("aborted", "AbortError"));
              },
              { once: true },
            );
          },
        });
        return new Response(body, {
          headers: { "content-type": "text/event-stream" },
          status: 200,
        });
      };
      const result = collect(
        new OpenRouterGateway({ apiKey: "test-key-never-sent", fetch: transport }),
      );
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(elapsedMilliseconds);
      const events = await result;

      expect(events.at(-1)).toEqual({
        accounting: { spendRisk: "unknown" },
        errorCode: "GENERATION_TIMEOUT",
        providerErrorType: "timeout",
        type: "response.failed",
      });
      expect(events.some((event) => event.type === "content.delta")).toBe(emitsDelta);
    },
  );

  it("bounds generation metadata lookup independently", async () => {
    vi.useFakeTimers();
    const gateway = new OpenRouterGateway({
      apiKey: "test-key-never-sent",
      fetch: async (_input, init) =>
        await new Promise<Response>((_resolve, reject) => {
          expect(init?.redirect).toBe("error");
          init?.signal?.addEventListener(
            "abort",
            () => reject(init.signal?.reason ?? new DOMException("aborted", "AbortError")),
            { once: true },
          );
        }),
    });
    const lookup = gateway.lookupUsage("gen-timeout", new AbortController().signal);
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(lookup).resolves.toEqual({ status: "unavailable" });
  });

  it("returns unavailable for malformed usage lookup without leaking provider fields", async () => {
    const gateway = new OpenRouterGateway({
      apiKey: "test-key-never-sent",
      fetch: async () =>
        new Response(JSON.stringify({ data: { id: "other" }, raw: "[secret]" }), {
          headers: { "content-type": "application/json" },
          status: 200,
        }),
    });
    await expect(
      gateway.lookupUsage("gen-synthetic", new AbortController().signal),
    ).resolves.toEqual({ status: "unavailable" });
  });
});

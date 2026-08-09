import { type FakeGatewayStep, FakeModelGateway } from "../generations/fake-model-gateway.js";
import type {
  GatewayAccounting,
  GatewayProviderMetadata,
  GatewayUsageLookupResult,
  GenerationAccountingGateway,
  GenerationRequest,
  ModelGateway,
} from "../generations/model-gateway.js";
import { initialTierModels } from "../model-policy/catalog.js";

const loadMessage =
  /^CAPSTONE_LOAD_V1:([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}):(\d):(\d{1,2}):(\d):(normal|cancel|failure|large|seed|slow)$/u;

const loadProvider = "capstone-load-rehearsal";
const measuredActiveWindowMilliseconds = 15_000;
const loadProviderGeneration =
  /^load-(?:compaction|[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}-\d-\d{1,2}-\d)-[a-z0-9]+$/u;
const controlledReservationProviderGeneration =
  /^load-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}-[0-5]-2-0-[a-z0-9]+$/u;

function accounting(metadata: GatewayProviderMetadata, outputTokens: number): GatewayAccounting {
  return {
    costUsd: (Math.max(1, outputTokens) / 1_000_000).toFixed(6),
    metadata,
  };
}

function providerMetadata(
  providerGenerationId: string,
  resolvedModel?: string,
): GatewayProviderMetadata {
  return {
    provider: loadProvider,
    providerGenerationId,
    ...(resolvedModel === undefined ? {} : { resolvedModel }),
  };
}

function completed(
  inputTokens: number,
  outputTokens: number,
  metadata: GatewayProviderMetadata,
): FakeGatewayStep {
  return {
    event: {
      accounting: accounting(metadata, outputTokens),
      reason: "stop",
      type: "response.completed",
      usage: { inputTokens, outputTokens },
    },
  };
}

function completedAfter(
  inputTokens: number,
  outputTokens: number,
  metadata: GatewayProviderMetadata,
  delayMilliseconds: number,
): FakeGatewayStep {
  return { ...completed(inputTokens, outputTokens, metadata), delayMilliseconds };
}

export function loadRehearsalSteps(
  request: GenerationRequest,
  providerAttempt = "fixture",
): readonly FakeGatewayStep[] {
  if (request.purpose !== "chat") {
    const metadata = providerMetadata(
      `load-compaction-${providerAttempt}`,
      request.route?.requestedModel,
    );
    return [
      { event: { metadata, type: "generation.metadata" } },
      { event: { text: "Resumen sintético de carga.", type: "content.delta" } },
      completed(128, 12, metadata),
    ];
  }

  const match = request.message.text.match(loadMessage);
  if (match === null) {
    return [
      {
        event: {
          errorCode: "GENERATION_FAILED",
          providerErrorType: "invalid_prompt",
          type: "response.failed",
        },
      },
    ];
  }

  const [, runId, wave, employee, conversation, scenario] = match;
  const canary = `LOAD_RESPONSE:${runId}:${wave}:${employee}:${conversation}`;
  const metadata = providerMetadata(
    `load-${runId}-${wave}-${employee}-${conversation}-${providerAttempt}`,
    request.route?.requestedModel,
  );
  const providerStarted: FakeGatewayStep = {
    event: { metadata, type: "generation.metadata" },
  };
  if (scenario === "failure") {
    return [
      providerStarted,
      ...Array.from({ length: 5 }, (_, index) => ({
        delayMilliseconds: 500,
        event: {
          text: `${canary}:partial-${index.toString().padStart(2, "0")};`,
          type: "content.delta" as const,
        },
      })),
      {
        delayMilliseconds: measuredActiveWindowMilliseconds - 5 * 500,
        event: {
          errorCode: "GENERATION_FAILED",
          providerErrorType: "server",
          type: "response.failed",
        },
      },
    ];
  }
  if (scenario === "cancel") {
    return [
      providerStarted,
      ...Array.from({ length: 20 }, (_, index) => ({
        delayMilliseconds: 500,
        event: {
          text: `${canary}:${index.toString().padStart(2, "0")};`,
          type: "content.delta" as const,
        },
      })),
      completedAfter(32, 80, metadata, measuredActiveWindowMilliseconds - 20 * 500),
    ];
  }
  if (scenario === "large") {
    const payload = "x".repeat(992);
    return [
      providerStarted,
      ...Array.from({ length: 820 }, (_, index) => ({
        event: {
          text: `${canary}:${index.toString().padStart(3, "0")}:${payload}`,
          type: "content.delta" as const,
        },
      })),
      completed(32, 8_000, metadata),
    ];
  }
  if (scenario === "slow") {
    const payload = "x".repeat(992);
    return [
      providerStarted,
      ...Array.from({ length: 96 }, (_, index) => ({
        event: {
          text: `${canary}:${index.toString().padStart(2, "0")}:${payload}`,
          type: "content.delta" as const,
        },
      })),
      completedAfter(32, 96, metadata, measuredActiveWindowMilliseconds),
    ];
  }
  if (scenario === "seed") {
    return [
      providerStarted,
      { delayMilliseconds: 10, event: { text: `${canary}:a`, type: "content.delta" } },
      { delayMilliseconds: 10, event: { text: `${canary}:b`, type: "content.delta" } },
      { delayMilliseconds: 10, event: { text: `${canary}:c`, type: "content.delta" } },
      completed(32, 12, metadata),
    ];
  }
  return [
    providerStarted,
    ...Array.from({ length: 20 }, (_, index) => ({
      delayMilliseconds: 500,
      event: {
        text: `${canary}:${index.toString().padStart(2, "0")};`,
        type: "content.delta" as const,
      },
    })),
    completedAfter(32, 80, metadata, measuredActiveWindowMilliseconds - 20 * 500),
  ];
}

export class LoadModelGateway implements ModelGateway, GenerationAccountingGateway {
  readonly #gateway: FakeModelGateway;

  constructor() {
    let providerAttempt = 0;
    this.#gateway = new FakeModelGateway({
      resolve: (request) => loadRehearsalSteps(request, (providerAttempt++).toString(36)),
    });
  }

  stream(request: GenerationRequest, signal: AbortSignal) {
    return this.#gateway.stream(request, signal);
  }

  async lookupUsage(
    providerGenerationId: string,
    signal: AbortSignal,
  ): Promise<GatewayUsageLookupResult> {
    signal.throwIfAborted();
    if (!loadProviderGeneration.test(providerGenerationId)) {
      return { status: "unavailable" };
    }
    // One deterministic failed stream per measured wave deliberately retains its reservation so
    // the real expiry reconciler, rather than the response coordinator, settles that exact row.
    if (controlledReservationProviderGeneration.test(providerGenerationId)) {
      return { status: "unavailable" };
    }
    const metadata = providerMetadata(providerGenerationId, initialTierModel(providerGenerationId));
    return {
      accounting: accounting(metadata, 4),
      status: "found",
      usage: { inputTokens: 32, outputTokens: 4 },
    };
  }
}

function initialTierModel(providerGenerationId: string): string {
  return providerGenerationId.startsWith("load-compaction-")
    ? initialTierModels.fast
    : initialTierModels.balanced;
}

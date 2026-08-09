import type {
  GatewayEvent,
  GenerationPurpose,
  GenerationRequest,
  ModelGateway,
} from "./model-gateway.js";
import { createGatewayTransportClock } from "./model-gateway.js";
import { generationTuning } from "./settings.js";

export interface FakeGatewayStep {
  readonly delayMilliseconds?: number;
  readonly event: GatewayEvent;
}

const localFakeSteps: readonly FakeGatewayStep[] = Object.freeze([
  Object.freeze({
    delayMilliseconds: generationTuning.fakeChunkDelayMilliseconds,
    event: Object.freeze({ text: "Esta es ", type: "content.delta" }),
  }),
  Object.freeze({
    delayMilliseconds: generationTuning.fakeChunkDelayMilliseconds,
    event: Object.freeze({
      text: "una respuesta simulada de Capstone Chat ",
      type: "content.delta",
    }),
  }),
  Object.freeze({
    delayMilliseconds: generationTuning.fakeChunkDelayMilliseconds,
    event: Object.freeze({ text: "para desarrollo local.", type: "content.delta" }),
  }),
  Object.freeze({
    event: Object.freeze({
      reason: "stop",
      type: "response.completed",
      usage: Object.freeze({ inputTokens: 12, outputTokens: 8 }),
    }),
  }),
]);

const localFakeCompactionSteps: readonly FakeGatewayStep[] = Object.freeze([
  Object.freeze({
    delayMilliseconds: generationTuning.fakeChunkDelayMilliseconds,
    event: Object.freeze({
      text: "Resumen simulado del contexto anterior.",
      type: "content.delta",
    }),
  }),
  Object.freeze({
    event: Object.freeze({
      reason: "stop",
      type: "response.completed",
      usage: Object.freeze({ inputTokens: 12, outputTokens: 6 }),
    }),
  }),
]);

export interface FakeGatewayScripts {
  readonly chat?: readonly FakeGatewayStep[];
  readonly compaction?: readonly FakeGatewayStep[];
  readonly resolve?:
    | ((request: GenerationRequest) => readonly FakeGatewayStep[] | undefined)
    | undefined;
}

function isStepArray(
  value: readonly FakeGatewayStep[] | FakeGatewayScripts,
): value is readonly FakeGatewayStep[] {
  return Array.isArray(value);
}

function abortError(reason: unknown): Error {
  if (reason instanceof Error) {
    return reason;
  }
  return new DOMException("The generation was aborted", "AbortError");
}

async function waitForDelay(delayMilliseconds: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(done, delayMilliseconds);

    function done(): void {
      signal.removeEventListener("abort", aborted);
      resolve();
    }

    function aborted(): void {
      clearTimeout(timeout);
      reject(abortError(signal.reason));
    }

    signal.addEventListener("abort", aborted, { once: true });
  });
}

export class FakeModelGateway implements ModelGateway {
  readonly #resolve:
    | ((request: GenerationRequest) => readonly FakeGatewayStep[] | undefined)
    | undefined;
  readonly #steps: Readonly<Record<GenerationPurpose, readonly FakeGatewayStep[]>>;

  constructor(scripts: readonly FakeGatewayStep[] | FakeGatewayScripts = {}) {
    if (isStepArray(scripts)) {
      this.#resolve = undefined;
      this.#steps = { chat: [...scripts], compaction: [...scripts] };
      return;
    }
    this.#resolve = scripts.resolve;
    this.#steps = {
      chat: [...(scripts.chat ?? localFakeSteps)],
      compaction: [...(scripts.compaction ?? localFakeCompactionSteps)],
    };
  }

  async *stream(request: GenerationRequest, signal: AbortSignal): AsyncIterable<GatewayEvent> {
    const steps = this.#resolve?.(request) ?? this.#steps[request.purpose];
    const transportClock = createGatewayTransportClock();
    let emittedVisibleContent = false;
    signal.throwIfAborted();
    yield* transportClock.publish({
      transportElapsedMilliseconds: transportClock.elapsedMilliseconds(),
      type: "response.headers",
    });
    for (const step of steps) {
      const delayMilliseconds = step.delayMilliseconds ?? 0;
      if (delayMilliseconds > 0) {
        await waitForDelay(delayMilliseconds, signal);
      }
      signal.throwIfAborted();
      const transportElapsedMilliseconds = transportClock.elapsedMilliseconds();
      if (step.event.type === "response.headers") {
        yield* transportClock.publish({
          ...step.event,
          transportElapsedMilliseconds,
        });
        continue;
      }
      if (
        step.event.type === "content.delta" &&
        !emittedVisibleContent &&
        step.event.text.length > 0
      ) {
        emittedVisibleContent = true;
        yield* transportClock.publish({
          ...step.event,
          transportElapsedMilliseconds,
        });
        continue;
      }
      if (step.event.type === "response.completed" || step.event.type === "response.failed") {
        yield* transportClock.publish({
          ...step.event,
          transportElapsedMilliseconds,
        });
        continue;
      }
      yield* transportClock.publish(step.event);
    }
  }
}

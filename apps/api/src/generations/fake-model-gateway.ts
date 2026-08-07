import type { GatewayEvent, GenerationRequest, ModelGateway } from "./model-gateway.js";
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
  readonly #steps: readonly FakeGatewayStep[];

  constructor(steps: readonly FakeGatewayStep[] = localFakeSteps) {
    this.#steps = [...steps];
  }

  async *stream(_request: GenerationRequest, signal: AbortSignal): AsyncIterable<GatewayEvent> {
    for (const step of this.#steps) {
      const delayMilliseconds = step.delayMilliseconds ?? 0;
      if (delayMilliseconds > 0) {
        await waitForDelay(delayMilliseconds, signal);
      }
      signal.throwIfAborted();
      yield step.event;
    }
  }
}

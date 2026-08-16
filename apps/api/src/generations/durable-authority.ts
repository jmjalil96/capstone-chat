import { isTerminalGenerationStatus } from "../database/generation-schema.js";
import type { DurableGenerationState } from "./service.js";

interface DurableGenerationAuthorityOptions {
  readonly intervalMilliseconds: number;
  readonly now?: (() => number) | undefined;
  readonly readState: () => Promise<DurableGenerationState | null>;
}

function isTerminal(state: DurableGenerationState | null): boolean {
  return state === null || isTerminalGenerationStatus(state.status);
}

function waitForNextRead(signal: AbortSignal, milliseconds: number): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    const timer = setTimeout(finish, milliseconds);
    const aborted = (): void => finish();

    function finish(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", aborted);
      resolve();
    }

    signal.addEventListener("abort", aborted, { once: true });
  });
}

/** One request-local fence for durable generation authority. */
export class DurableGenerationAuthority {
  readonly #controller = new AbortController();
  readonly #intervalMilliseconds: number;
  readonly #now: () => number;
  readonly #readState: () => Promise<DurableGenerationState | null>;
  #inFlight: Promise<DurableGenerationState | null> | null = null;
  #lastState: DurableGenerationState | null | undefined;
  #lastSuccessfulReadAt: number | null = null;
  #monitor: Promise<void> | null = null;
  #terminalObserved = false;

  constructor(options: DurableGenerationAuthorityOptions) {
    this.#intervalMilliseconds = options.intervalMilliseconds;
    this.#now = options.now ?? performance.now.bind(performance);
    this.#readState = options.readState;
  }

  async stateForEvent(force = false): Promise<DurableGenerationState | null> {
    if (this.#terminalObserved) {
      return this.#lastState ?? null;
    }
    if (force && this.#inFlight !== null) {
      // A lifecycle transition can commit while an earlier SELECT is still in flight. A forced
      // fence must therefore wait out that pre-barrier read and start one new coalesced read after
      // the caller's barrier unless the earlier read already discovered a sticky terminal state.
      await this.#inFlight.catch(() => undefined);
      if (this.#terminalObserved) {
        return this.#lastState ?? null;
      }
      return this.#refresh();
    }
    if (
      !force &&
      this.#lastState !== undefined &&
      this.#lastSuccessfulReadAt !== null &&
      this.#now() - this.#lastSuccessfulReadAt < this.#intervalMilliseconds
    ) {
      return this.#lastState;
    }
    return this.#refresh();
  }

  startMonitor(onTerminal: () => void): void {
    this.#monitor ??= this.#monitorState(onTerminal);
  }

  async stop(): Promise<void> {
    this.#controller.abort("generation-settled");
    await this.#monitor;
    await this.#inFlight?.catch(() => undefined);
  }

  #refresh(): Promise<DurableGenerationState | null> {
    if (this.#terminalObserved) {
      return Promise.resolve(this.#lastState ?? null);
    }
    if (this.#inFlight !== null) {
      return this.#inFlight;
    }

    const operation = this.#readState()
      .then((state) => {
        if (!this.#terminalObserved) {
          this.#lastState = state;
          this.#lastSuccessfulReadAt = this.#now();
          this.#terminalObserved = isTerminal(state);
        }
        return this.#lastState ?? null;
      })
      .finally(() => {
        if (this.#inFlight === operation) {
          this.#inFlight = null;
        }
      });
    this.#inFlight = operation;
    return operation;
  }

  async #monitorState(onTerminal: () => void): Promise<void> {
    const signal = this.#controller.signal;
    // A newly admitted request has no published provider event yet. Start at the first existing
    // polling boundary instead of adding an immediate database burst to serialized admission.
    await waitForNextRead(signal, this.#intervalMilliseconds);
    while (!signal.aborted) {
      const state = await this.#refresh().catch(() => undefined);
      if (state !== undefined && isTerminal(state)) {
        onTerminal();
        return;
      }
      await waitForNextRead(signal, this.#intervalMilliseconds);
    }
  }
}

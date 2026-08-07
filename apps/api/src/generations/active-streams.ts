export type StreamAbortReason = "cancelled" | "deleted" | "disconnect" | "shutdown";

export interface LocalStreamSnapshot {
  readonly content: string;
  readonly firstTokenAt: Date | null;
}

export interface LocalCancellationCapture {
  readonly snapshot: LocalStreamSnapshot;
  commit(): void;
  release(): void;
}

export interface ActiveStreamLease {
  readonly signal: AbortSignal;
  pendingCancellation(): Promise<boolean> | undefined;
  release(): void;
}

interface CancellationFence {
  readonly promise: Promise<boolean>;
  readonly resolve: (terminal: boolean) => void;
  readonly snapshot: LocalStreamSnapshot;
  participants: number;
}

interface ActiveStreamEntry {
  cancellation: CancellationFence | undefined;
  readonly controller: AbortController;
  readonly snapshot: (() => LocalStreamSnapshot) | undefined;
}

export class ActiveStreamRegistry {
  readonly #active = new Map<string, ActiveStreamEntry>();
  readonly #idleWaiters = new Set<() => void>();
  #accepting = true;

  get size(): number {
    return this.#active.size;
  }

  get isAccepting(): boolean {
    return this.#accepting;
  }

  beginDraining(): void {
    this.#accepting = false;
  }

  register(generationId: string, snapshot?: () => LocalStreamSnapshot): ActiveStreamLease {
    if (this.#active.has(generationId)) {
      throw new Error("Generation stream is already registered");
    }

    const entry: ActiveStreamEntry = {
      cancellation: undefined,
      controller: new AbortController(),
      snapshot,
    };
    this.#active.set(generationId, entry);
    if (!this.#accepting) {
      entry.controller.abort("shutdown" satisfies StreamAbortReason);
    }

    let released = false;
    return Object.freeze({
      pendingCancellation: () => entry.cancellation?.promise,
      signal: entry.controller.signal,
      release: () => {
        if (released) {
          return;
        }
        released = true;
        this.#settleCancellation(entry, false);
        if (this.#active.get(generationId) === entry) {
          this.#active.delete(generationId);
        }
        if (this.#active.size === 0) {
          for (const resolve of this.#idleWaiters) {
            resolve();
          }
          this.#idleWaiters.clear();
        }
      },
    });
  }

  captureCancellation(generationId: string): LocalCancellationCapture | undefined {
    const entry = this.#active.get(generationId);
    if (entry?.snapshot === undefined) {
      return undefined;
    }

    let fence = entry.cancellation;
    if (fence === undefined) {
      let resolve!: (terminal: boolean) => void;
      const promise = new Promise<boolean>((settle) => {
        resolve = settle;
      });
      fence = {
        participants: 0,
        promise,
        resolve,
        snapshot: entry.snapshot(),
      };
      entry.cancellation = fence;
    }
    fence.participants += 1;

    let settled = false;
    return Object.freeze({
      commit: () => {
        if (settled) {
          return;
        }
        settled = true;
        fence.participants -= 1;
        this.#settleCancellation(entry, true);
        if (!entry.controller.signal.aborted) {
          entry.controller.abort("cancelled" satisfies StreamAbortReason);
        }
      },
      release: () => {
        if (settled) {
          return;
        }
        settled = true;
        fence.participants -= 1;
        if (fence.participants === 0) {
          this.#settleCancellation(entry, false);
        }
      },
      snapshot: fence.snapshot,
    });
  }

  abort(generationId: string, reason: StreamAbortReason): boolean {
    const entry = this.#active.get(generationId);
    if (entry === undefined) {
      return false;
    }
    this.#settleCancellation(entry, true);
    if (!entry.controller.signal.aborted) {
      entry.controller.abort(reason);
    }
    return true;
  }

  abortAll(reason: StreamAbortReason): void {
    for (const entry of this.#active.values()) {
      this.#settleCancellation(entry, true);
      if (!entry.controller.signal.aborted) {
        entry.controller.abort(reason);
      }
    }
  }

  async waitForIdle(timeoutMilliseconds: number): Promise<boolean> {
    if (this.#active.size === 0) {
      return true;
    }

    let resolveIdle: (() => void) | undefined;
    const idle = new Promise<void>((resolve) => {
      resolveIdle = resolve;
      this.#idleWaiters.add(resolve);
    });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<false>((resolve) => {
      timeout = setTimeout(() => resolve(false), timeoutMilliseconds);
    });
    const result = await Promise.race([idle.then(() => true as const), timedOut]);
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
    if (resolveIdle !== undefined) {
      this.#idleWaiters.delete(resolveIdle);
    }
    return result;
  }

  #settleCancellation(entry: ActiveStreamEntry, terminal: boolean): void {
    const fence = entry.cancellation;
    if (fence === undefined) {
      return;
    }
    entry.cancellation = undefined;
    fence.resolve(terminal);
  }
}

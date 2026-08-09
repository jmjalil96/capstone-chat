import type { FastifyReply, FastifyRequest } from "fastify";

export type StreamingResponsePromotion<T> =
  | { readonly kind: "accepted"; readonly value: T }
  | { readonly kind: "closed" };

interface TrackedOrdinaryRequest {
  handlerSettled(): void;
  promote<T>(start: () => T): StreamingResponsePromotion<T>;
}

const trackedOrdinaryRequests = new WeakMap<object, TrackedOrdinaryRequest>();

export function promoteToStreamingResponse<T>(
  request: FastifyRequest,
  start: () => T,
): StreamingResponsePromotion<T> {
  const tracked = trackedOrdinaryRequests.get(request.raw);
  return tracked === undefined ? { kind: "accepted", value: start() } : tracked.promote(start);
}

interface ActiveRequest {
  readonly abort: () => void;
}

export class OrdinaryRequestDrain {
  readonly #active = new Set<ActiveRequest>();
  readonly #idleWaiters = new Set<() => void>();
  #accepting = true;
  #promotionsSealed = false;

  get isIdle(): boolean {
    return this.#active.size === 0;
  }

  beginDraining(): void {
    this.#accepting = false;
  }

  completeHandler(request: FastifyRequest): void {
    trackedOrdinaryRequests.get(request.raw)?.handlerSettled();
  }

  async drainAndSeal(timeoutMilliseconds: number): Promise<boolean> {
    const idle = await this.waitForIdle(timeoutMilliseconds);
    this.#promotionsSealed = true;
    return idle;
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

  track(request: FastifyRequest, reply: FastifyReply): boolean {
    if (!this.#accepting) {
      return false;
    }

    const activeRequest: ActiveRequest = {
      abort: () => reply.raw.destroy(),
    };
    this.#active.add(activeRequest);

    let handlerSettled = false;
    let released = false;
    let responseClosed = false;
    const release = (): void => {
      if (released) {
        return;
      }
      released = true;
      request.raw.removeListener("aborted", requestAborted);
      reply.raw.removeListener("close", responseFinishedOrClosed);
      reply.raw.removeListener("finish", release);
      trackedOrdinaryRequests.delete(request.raw);
      this.#active.delete(activeRequest);
      if (this.#active.size === 0) {
        for (const resolve of this.#idleWaiters) {
          resolve();
        }
        this.#idleWaiters.clear();
      }
    };

    const responseFinishedOrClosed = (): void => {
      responseClosed = true;
      if (handlerSettled || !request.raw.complete) {
        release();
      }
    };
    const requestAborted = (): void => {
      if (!request.raw.complete) {
        release();
        return;
      }
      responseFinishedOrClosed();
    };
    const tracked: TrackedOrdinaryRequest = {
      handlerSettled: () => {
        handlerSettled = true;
        if (responseClosed) {
          release();
        }
      },
      promote: <T>(start: () => T): StreamingResponsePromotion<T> => {
        if (released || this.#promotionsSealed) {
          release();
          return { kind: "closed" };
        }
        const value = start();
        release();
        return { kind: "accepted", value };
      },
    };

    trackedOrdinaryRequests.set(request.raw, tracked);
    request.raw.once("aborted", requestAborted);
    reply.raw.once("close", responseFinishedOrClosed);
    reply.raw.once("finish", release);
    return true;
  }

  abortAll(): void {
    for (const request of this.#active) {
      request.abort();
    }
  }
}

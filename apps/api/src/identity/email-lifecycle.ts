import { settleWithin } from "../lifecycle-timeout.js";
import type { EmailSender, EmailSenderKind, IdentityEmail } from "./email.js";

const lifecycleTiming = Object.freeze({
  abortWaitMilliseconds: 1_000,
  drainMilliseconds: 1_000,
});

export const emailShutdownMaximumMilliseconds =
  lifecycleTiming.drainMilliseconds + lifecycleTiming.abortWaitMilliseconds;

export abstract class LifecycleEmailSender implements EmailSender {
  abstract readonly kind: EmailSenderKind;

  readonly #abortController = new AbortController();
  readonly #active = new Set<Promise<void>>();
  #closePromise: Promise<void> | undefined;
  #closing = false;

  send(message: IdentityEmail): Promise<void> {
    if (this.#closing) {
      return Promise.reject(new Error("Transactional email delivery is shutting down"));
    }

    const operation = this.deliver(message, this.#abortController.signal);
    this.#active.add(operation);
    void operation.then(
      () => this.#active.delete(operation),
      () => this.#active.delete(operation),
    );
    return operation;
  }

  close(): Promise<void> {
    this.#closePromise ??= this.closeOnce();
    return this.#closePromise;
  }

  protected abstract deliver(message: IdentityEmail, signal: AbortSignal): Promise<void>;

  private async closeOnce(): Promise<void> {
    this.#closing = true;
    const pending = Promise.allSettled([...this.#active]);
    const drained = await settleWithin(pending, lifecycleTiming.drainMilliseconds);

    if (drained) {
      return;
    }

    this.#abortController.abort();
    await settleWithin(pending, lifecycleTiming.abortWaitMilliseconds);
  }
}

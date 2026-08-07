import { randomUUID } from "node:crypto";
import type { EmailDelivery } from "../config.js";
import { identitySecurity } from "./security.js";

export type EmailPurpose = "invitation" | "verification" | "password-reset";

export interface IdentityEmail {
  readonly purpose: EmailPurpose;
  readonly subject: string;
  readonly text: string;
  readonly to: string;
}

export interface DeliveredIdentityEmail extends IdentityEmail {
  readonly createdAt: string;
  readonly id: string;
}

export interface EmailSender {
  readonly kind: "disabled" | "fake";
  send(message: IdentityEmail): Promise<void>;
}

export class FakeEmailSender implements EmailSender {
  readonly kind = "fake" as const;
  readonly #messages: DeliveredIdentityEmail[] = [];
  readonly #retention: number;

  constructor(retention: number = identitySecurity.fakeMailboxRetention) {
    if (!Number.isSafeInteger(retention) || retention < 1) {
      throw new Error("Fake email retention must be a positive integer");
    }

    this.#retention = retention;
  }

  async send(message: IdentityEmail): Promise<void> {
    this.#messages.push(
      Object.freeze({
        ...message,
        createdAt: new Date().toISOString(),
        id: randomUUID(),
      }),
    );

    if (this.#messages.length > this.#retention) {
      this.#messages.splice(0, this.#messages.length - this.#retention);
    }
  }

  deliveries(): readonly DeliveredIdentityEmail[] {
    return this.#messages.map((message) => Object.freeze({ ...message }));
  }
}

export class DisabledEmailSender implements EmailSender {
  readonly kind = "disabled" as const;

  async send(_message: IdentityEmail): Promise<void> {
    throw new Error("Transactional email delivery is not configured");
  }
}

export function createEmailSender(delivery: EmailDelivery): EmailSender {
  return delivery === "fake" ? new FakeEmailSender() : new DisabledEmailSender();
}

export function dispatchIdentityEmail(
  sender: EmailSender,
  message: IdentityEmail,
  onFailure: (purpose: EmailPurpose, errorName: string) => void,
): void {
  void sender.send(message).catch((error: unknown) => {
    onFailure(message.purpose, error instanceof Error ? error.name : "UnknownError");
  });
}

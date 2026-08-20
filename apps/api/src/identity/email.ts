import { randomUUID } from "node:crypto";
import type { EmailDelivery } from "../config.js";
import { LifecycleEmailSender } from "./email-lifecycle.js";
import {
  type EmailDeliveryReport,
  ResendEmailSender,
  type ResendEmailSenderOptions,
} from "./resend-email.js";
import { identitySecurity } from "./security.js";

export type EmailPurpose = "invitation" | "verification" | "password-reset";

export interface IdentityEmail {
  readonly purpose: EmailPurpose;
  readonly html: string;
  readonly subject: string;
  readonly text: string;
  readonly to: string;
}

export interface DeliveredIdentityEmail extends IdentityEmail {
  readonly createdAt: string;
  readonly id: string;
}

export interface EmailSender {
  readonly kind: EmailSenderKind;
  close(): Promise<void>;
  send(message: IdentityEmail): Promise<void>;
}

export type EmailSenderKind = "disabled" | "fake" | "resend";

export class FakeEmailSender extends LifecycleEmailSender {
  readonly kind = "fake" as const;
  readonly #messages: DeliveredIdentityEmail[] = [];
  readonly #retention: number;

  constructor(retention: number = identitySecurity.fakeMailboxRetention) {
    super();
    if (!Number.isSafeInteger(retention) || retention < 1) {
      throw new Error("Fake email retention must be a positive integer");
    }

    this.#retention = retention;
  }

  protected async deliver(message: IdentityEmail, _signal: AbortSignal): Promise<void> {
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

export class DisabledEmailSender extends LifecycleEmailSender {
  readonly kind = "disabled" as const;

  protected async deliver(_message: IdentityEmail, _signal: AbortSignal): Promise<void> {
    throw new Error("Transactional email delivery is not configured");
  }
}

export interface EmailSenderFactoryOptions {
  readonly allowedRecipients?: readonly string[];
  readonly emailFrom?: string | null;
  readonly fetch?: typeof fetch;
  readonly onDeliveryReport?: (report: EmailDeliveryReport) => void;
  readonly resendApiKey?: string | null;
}

export function createEmailSender(
  delivery: EmailDelivery,
  options: EmailSenderFactoryOptions = {},
): EmailSender {
  if (delivery === "fake") {
    return new FakeEmailSender();
  }
  if (delivery === "disabled") {
    return new DisabledEmailSender();
  }

  if (options.resendApiKey === null || options.resendApiKey === undefined) {
    throw new Error("Resend API key is required for Resend email delivery");
  }
  if (options.emailFrom === null || options.emailFrom === undefined) {
    throw new Error("Email sender is required for Resend email delivery");
  }

  const resendOptions: ResendEmailSenderOptions = {
    apiKey: options.resendApiKey,
    from: options.emailFrom,
    ...(options.allowedRecipients === undefined
      ? {}
      : { allowedRecipients: options.allowedRecipients }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.onDeliveryReport === undefined
      ? {}
      : { onDeliveryReport: options.onDeliveryReport }),
  };
  return new ResendEmailSender(resendOptions);
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

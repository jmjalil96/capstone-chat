import { randomUUID } from "node:crypto";
import type { IdentityEmail } from "./email.js";
import { LifecycleEmailSender } from "./email-lifecycle.js";
import { normalizeEmail } from "./email-normalization.js";

const resendEndpoint = "https://api.resend.com/emails";
const resendUserAgent = "Capstone-Chat/1.0";
const responseBodyLimitBytes = 8 * 1024;
const requestTimeoutMilliseconds = 10_000;
const maximumReportedDurationMilliseconds = 10 * 60 * 1_000;
const resendMessageId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export type EmailDeliveryFailureCategory =
  | "authentication"
  | "network"
  | "provider"
  | "rate_limit"
  | "timeout"
  | "unknown";

export type EmailDeliveryReport =
  | Readonly<{
      durationMs: number;
      outcome: "sent";
      providerStatus: number;
    }>
  | Readonly<{
      category: EmailDeliveryFailureCategory;
      durationMs: number;
      outcome: "failed";
      providerStatus?: number;
    }>;

export class ResendEmailError extends Error {
  readonly category: EmailDeliveryFailureCategory;
  readonly durationMs: number;
  readonly providerStatus: number | undefined;

  constructor(input: {
    category: EmailDeliveryFailureCategory;
    durationMs: number;
    providerStatus?: number;
  }) {
    super("Transactional email delivery failed");
    this.name = "ResendEmailError";
    this.category = input.category;
    this.durationMs = input.durationMs;
    this.providerStatus = input.providerStatus;
  }
}

interface ProviderFailure {
  readonly category: EmailDeliveryFailureCategory;
  readonly providerStatus?: number;
}

export interface ResendEmailSenderOptions {
  readonly allowedRecipients?: readonly string[];
  readonly apiKey: string;
  readonly fetch?: typeof fetch;
  readonly from: string;
  readonly idempotencyKey?: () => string;
  readonly now?: () => number;
  readonly onDeliveryReport?: (report: EmailDeliveryReport) => void;
  readonly timeoutMilliseconds?: number;
}

export class EmailRecipientNotAllowedError extends Error {
  constructor() {
    super("Transactional email delivery is not permitted");
    this.name = "EmailRecipientNotAllowedError";
  }
}

function boundedDuration(startedAt: number, now: () => number): number {
  const duration = Math.round(now() - startedAt);
  return Math.min(maximumReportedDurationMilliseconds, Math.max(0, duration));
}

function report(
  listener: ((report: EmailDeliveryReport) => void) | undefined,
  value: EmailDeliveryReport,
): void {
  try {
    listener?.(value);
  } catch {
    // Operational reporting must never become an email-delivery dependency.
  }
}

function categoryForStatus(status: number): EmailDeliveryFailureCategory {
  if (status === 401 || status === 403) {
    return "authentication";
  }
  if (status === 429) {
    return "rate_limit";
  }
  return "provider";
}

function cancelResponseBody(response: Response): void {
  void response.body?.cancel().catch(() => {
    // The provider response is deliberately discarded and never becomes diagnostic output.
  });
}

function readStreamChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]> {
  if (signal.aborted) {
    return Promise.reject(signal.reason);
  }

  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener("abort", aborted, { once: true });
    void reader.read().then(
      (result) => {
        signal.removeEventListener("abort", aborted);
        resolve(result);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", aborted);
        reject(error);
      },
    );
  });
}

async function readBoundedResponse(response: Response, signal: AbortSignal): Promise<string> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (Number.isFinite(length) && length > responseBodyLimitBytes) {
      cancelResponseBody(response);
      throw { category: "provider", providerStatus: response.status } satisfies ProviderFailure;
    }
  }

  if (response.body === null) {
    return "";
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;

  try {
    while (true) {
      const result = await readStreamChunk(reader, signal);
      if (result.done) {
        break;
      }

      length += result.value.byteLength;
      if (length > responseBodyLimitBytes) {
        throw { category: "provider", providerStatus: response.status } satisfies ProviderFailure;
      }
      chunks.push(result.value);
    }
  } catch (error: unknown) {
    void reader.cancel().catch(() => {
      // The bounded reader has already rejected the provider response.
    });
    throw error;
  }

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function validProviderResponse(body: string): boolean {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return false;
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const id = (value as { id?: unknown }).id;
  return Object.keys(value).length === 1 && typeof id === "string" && resendMessageId.test(id);
}

function isJsonResponse(response: Response): boolean {
  return (
    response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ===
    "application/json"
  );
}

function isProviderFailure(value: unknown): value is ProviderFailure {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const category = (value as { category?: unknown }).category;
  return (
    category === "authentication" ||
    category === "network" ||
    category === "provider" ||
    category === "rate_limit" ||
    category === "timeout" ||
    category === "unknown"
  );
}

export class ResendEmailSender extends LifecycleEmailSender {
  readonly kind = "resend" as const;

  readonly #apiKey: string;
  readonly #allowedRecipients: ReadonlySet<string> | undefined;
  readonly #fetch: typeof fetch;
  readonly #from: string;
  readonly #idempotencyKey: () => string;
  readonly #now: () => number;
  readonly #onDeliveryReport: ((report: EmailDeliveryReport) => void) | undefined;
  readonly #timeoutMilliseconds: number;

  constructor(options: ResendEmailSenderOptions) {
    super();
    if (options.apiKey.length === 0 || options.from.length === 0) {
      throw new Error("Resend email configuration is incomplete");
    }

    this.#apiKey = options.apiKey;
    this.#allowedRecipients =
      options.allowedRecipients === undefined
        ? undefined
        : new Set(options.allowedRecipients.map((recipient) => normalizeEmail(recipient)));
    this.#fetch = options.fetch ?? fetch;
    this.#from = options.from;
    this.#idempotencyKey = options.idempotencyKey ?? randomUUID;
    this.#now = options.now ?? performance.now.bind(performance);
    this.#onDeliveryReport = options.onDeliveryReport;
    this.#timeoutMilliseconds = options.timeoutMilliseconds ?? requestTimeoutMilliseconds;
    if (!Number.isSafeInteger(this.#timeoutMilliseconds) || this.#timeoutMilliseconds < 1) {
      throw new Error("Resend email timeout must be a positive integer");
    }
  }

  protected async deliver(message: IdentityEmail, lifecycleSignal: AbortSignal): Promise<void> {
    if (
      this.#allowedRecipients !== undefined &&
      !this.#allowedRecipients.has(normalizeEmail(message.to))
    ) {
      throw new EmailRecipientNotAllowedError();
    }
    const startedAt = this.#now();
    const timeout = new AbortController();
    const timeoutHandle = setTimeout(() => timeout.abort(), this.#timeoutMilliseconds);
    timeoutHandle.unref();
    let providerStatus: number | undefined;
    const signal = AbortSignal.any([lifecycleSignal, timeout.signal]);

    try {
      const idempotencyKey = this.#idempotencyKey();
      if (!resendMessageId.test(idempotencyKey)) {
        throw { category: "unknown" } satisfies ProviderFailure;
      }

      const response = await this.#fetch(resendEndpoint, {
        body: JSON.stringify({
          from: this.#from,
          html: message.html,
          subject: message.subject,
          text: message.text,
          to: [message.to],
        }),
        headers: {
          accept: "application/json",
          authorization: `Bearer ${this.#apiKey}`,
          "content-type": "application/json",
          "idempotency-key": idempotencyKey,
          "user-agent": resendUserAgent,
        },
        method: "POST",
        redirect: "error",
        signal,
      });
      providerStatus = response.status;

      if (response.status !== 200) {
        cancelResponseBody(response);
        throw {
          category: categoryForStatus(response.status),
          providerStatus: response.status,
        } satisfies ProviderFailure;
      }

      if (!isJsonResponse(response)) {
        cancelResponseBody(response);
        throw { category: "provider", providerStatus: response.status } satisfies ProviderFailure;
      }

      const responseBody = await readBoundedResponse(response, signal);
      if (!validProviderResponse(responseBody)) {
        throw { category: "provider", providerStatus: response.status } satisfies ProviderFailure;
      }

      report(this.#onDeliveryReport, {
        durationMs: boundedDuration(startedAt, this.#now),
        outcome: "sent",
        providerStatus: response.status,
      });
    } catch (error: unknown) {
      const category = timeout.signal.aborted
        ? "timeout"
        : lifecycleSignal.aborted
          ? "unknown"
          : isProviderFailure(error)
            ? error.category
            : "network";
      const status = isProviderFailure(error) ? error.providerStatus : providerStatus;
      const sanitized = new ResendEmailError({
        category,
        durationMs: boundedDuration(startedAt, this.#now),
        ...(status === undefined ? {} : { providerStatus: status }),
      });
      report(this.#onDeliveryReport, {
        category: sanitized.category,
        durationMs: sanitized.durationMs,
        outcome: "failed",
        ...(sanitized.providerStatus === undefined
          ? {}
          : { providerStatus: sanitized.providerStatus }),
      });
      throw sanitized;
    } finally {
      clearTimeout(timeoutHandle);
    }
  }
}

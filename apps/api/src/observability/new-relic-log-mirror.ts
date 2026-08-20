import { API_ERROR_CODES } from "@capstone/protocol";
import { isConfigurationKey } from "../config.js";
import { type LogMirrorDropReason, telemetrySafeHttpRoutes } from "./telemetry-contract.js";

export const newRelicLogMirrorTuning = Object.freeze({
  batchMaximumBytes: 128 * 1_024,
  batchMaximumRecords: 64,
  deliveryAttempts: 3,
  flushIntervalMs: 1_000,
  maximumRecordBytes: 2_048,
  queueMaximumBytes: 1_024 * 1_024,
  queueMaximumRecords: 1_024,
  requestTimeoutMs: 3_000,
  retryBackoffMs: Object.freeze([250, 1_000]),
  shutdownTimeoutMs: 5_000,
});

function logApiEndpointFor(otlpEndpoint: string): string {
  if (otlpEndpoint === "https://otlp.nr-data.net") {
    return "https://log-api.newrelic.com/log/v1";
  }
  if (otlpEndpoint === "https://otlp.eu01.nr-data.net") {
    return "https://log-api.eu.newrelic.com/log/v1";
  }
  throw new Error("New Relic log mirror OTLP endpoint is invalid");
}
const safeIdentifierPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const safeMethods = new Set(["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]);
const safeLevels = new Set([10, 20, 30, 40, 50, 60]);
const safeOperations = new Set([
  "database-pool",
  "email-delivery",
  "export",
  "flush",
  "http-request",
  "readiness-authority",
  "shutdown",
]);
const safeSignals = new Set(["SIGINT", "SIGTERM"]);
const safeTelemetrySignals = new Set(["metrics", "traces"]);
const safePurposes = new Set(["invitation", "password-reset", "verification"]);
const safeHooks = new Set(["activation", "registration-link"]);
const safeCategories = new Set(["catalog-refresh", "reservation-reconciliation"]);
const safeClientErrorKinds = new Set([
  "render",
  "resource",
  "unhandled_error",
  "unhandled_rejection",
]);
const safeClientErrorRoutes = new Set(["admin", "chat", "identity", "unknown"]);
const safeReadinessStates = new Set(["ready", "unavailable"]);
const safeDatabaseStates = new Set(["down", "unknown", "up"]);
const safeErrorCodes = new Set<string>(Object.values(API_ERROR_CODES));
const safeErrorNames = new Set([
  "AbortError",
  "AggregateError",
  "ApplicationError",
  "ConfigurationError",
  "DatabaseError",
  "EmployeeAdministrationConflictError",
  "Error",
  "IdentityConflictError",
  "ModelPolicyConflictError",
  "RangeError",
  "RecoveryPreparationError",
  "SyntaxError",
  "TypeError",
  "UnknownError",
]);
const safeDatabaseSeverities = new Set([
  "DEBUG",
  "ERROR",
  "FATAL",
  "INFO",
  "LOG",
  "NOTICE",
  "PANIC",
  "WARNING",
]);
const databaseIdentifierPattern = /^[a-z_][a-z0-9_]{0,62}$/u;
const frameworkErrorCodePattern = /^(?:ERR|FST_ERR)_[A-Z0-9_]{1,55}$/u;
const sqlStatePattern = /^[0-9A-Z]{5}$/u;
const eventNames = new Map([
  ["api started", "api.started"],
  ["api started without application readiness", "api.started_unready"],
  ["application readiness validation failed", "api.readiness_failed"],
  ["client application failure reported", "client.failure_reported"],
  ["cost-control maintenance failed", "maintenance.failed"],
  ["graceful shutdown failed", "api.shutdown_failed"],
  ["identity email delivery failed", "identity.email_failed"],
  ["identity lifecycle hook failed", "identity.hook_failed"],
  ["idle database connection failed", "database.idle_connection_failed"],
  ["request completed", "http.request_completed"],
  ["request failed", "http.request_failed"],
  ["request rejected", "http.request_rejected"],
  ["shutdown requested", "api.shutdown_requested"],
  ["telemetry exporter operation failed", "telemetry.exporter_failed"],
  ["telemetry instrumentation failed", "telemetry.instrumentation_failed"],
]);

interface QueuedRecord {
  readonly bytes: number;
  readonly serialized: string;
}

export interface NewRelicLogMirrorStats {
  readonly droppedRecords: number;
  readonly queuedBytes: number;
  readonly queuedRecords: number;
}

export interface NewRelicLogMirror {
  forceFlush(): Promise<void>;
  shutdown(): Promise<void>;
  stats(): Readonly<NewRelicLogMirrorStats>;
  write(message: string): void;
}

export interface NewRelicLogMirrorOptions {
  readonly apiKey: string;
  readonly environment: "staging" | "production";
  readonly fetch?: typeof fetch;
  readonly onDrop?: ((reason: LogMirrorDropReason, count: number) => void) | undefined;
  readonly otlpEndpoint: string;
  readonly release: string;
  readonly stdout?: { write(message: string): unknown } | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 31 || codePoint === 127)) {
      return true;
    }
  }
  return false;
}

function safeInteger(value: unknown, minimum: number, maximum: number): number | undefined {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= minimum &&
    value <= maximum
    ? value
    : undefined;
}

function safeDuration(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 86_400_000
    ? value
    : undefined;
}

function allowlistedRecord(
  parsed: Record<string, unknown>,
  options: Pick<NewRelicLogMirrorOptions, "environment" | "release">,
): Readonly<Record<string, unknown>> {
  const record: Record<string, unknown> = {
    "deployment.environment": options.environment,
    "service.name": "capstone-chat-api",
    "service.version": options.release,
  };

  const level = safeInteger(parsed.level, 10, 60);
  if (level !== undefined && safeLevels.has(level)) {
    record.level = level;
  }
  const timestamp = safeInteger(parsed.time, 0, Number.MAX_SAFE_INTEGER);
  if (timestamp !== undefined) {
    record.timestamp = timestamp;
  }
  if (typeof parsed.msg === "string") {
    const event = eventNames.get(parsed.msg);
    if (event !== undefined) {
      record.event = event;
    }
  }
  if (typeof parsed.requestId === "string" && uuidPattern.test(parsed.requestId)) {
    record["request.id"] = parsed.requestId.toLowerCase();
  }
  if (typeof parsed.method === "string" && safeMethods.has(parsed.method)) {
    record["http.request.method"] = parsed.method;
  }
  if (typeof parsed.route === "string" && telemetrySafeHttpRoutes.has(parsed.route)) {
    record["http.route"] = parsed.route;
  }
  const statusCode = safeInteger(parsed.statusCode, 100, 599);
  if (statusCode !== undefined) {
    record["http.response.status_code"] = statusCode;
  }
  const responseTime = safeDuration(parsed.responseTime);
  if (responseTime !== undefined) {
    record["http.response.duration_ms"] = responseTime;
  }
  if (typeof parsed.operation === "string" && safeOperations.has(parsed.operation)) {
    record["capstone.operation"] = parsed.operation;
  }
  if (typeof parsed.signal === "string" && safeSignals.has(parsed.signal)) {
    record["process.signal"] = parsed.signal;
  }
  if (typeof parsed.signal === "string" && safeTelemetrySignals.has(parsed.signal)) {
    record["capstone.telemetry.signal"] = parsed.signal;
  }
  if (typeof parsed.purpose === "string" && safePurposes.has(parsed.purpose)) {
    record["capstone.identity.purpose"] = parsed.purpose;
  }
  if (typeof parsed.hook === "string" && safeHooks.has(parsed.hook)) {
    record["capstone.identity.hook"] = parsed.hook;
  }
  if (typeof parsed.category === "string" && safeCategories.has(parsed.category)) {
    record["capstone.maintenance.category"] = parsed.category;
  }
  if (typeof parsed.kind === "string" && safeClientErrorKinds.has(parsed.kind)) {
    record["capstone.client_error.kind"] = parsed.kind;
  }
  if (typeof parsed.route === "string" && safeClientErrorRoutes.has(parsed.route)) {
    record["capstone.client_error.route"] = parsed.route;
  }
  if (typeof parsed.readiness === "string" && safeReadinessStates.has(parsed.readiness)) {
    record["capstone.readiness"] = parsed.readiness;
  }
  if (typeof parsed.database === "string" && safeDatabaseStates.has(parsed.database)) {
    record["capstone.database"] = parsed.database;
  }
  if (typeof parsed.errorName === "string" && safeErrorNames.has(parsed.errorName)) {
    record["error.name"] = parsed.errorName;
  }
  if (
    typeof parsed.errorCode === "string" &&
    (safeErrorCodes.has(parsed.errorCode) ||
      sqlStatePattern.test(parsed.errorCode) ||
      frameworkErrorCodePattern.test(parsed.errorCode))
  ) {
    record["error.code"] = parsed.errorCode;
  }
  if (isConfigurationKey(parsed.configurationKey)) {
    record["capstone.configuration.key"] = parsed.configurationKey;
  }
  if (
    typeof parsed.databaseSeverity === "string" &&
    safeDatabaseSeverities.has(parsed.databaseSeverity)
  ) {
    record["db.postgresql.severity"] = parsed.databaseSeverity;
  }
  for (const [source, destination] of [
    ["databaseSchema", "db.namespace"],
    ["databaseTable", "db.collection.name"],
    ["databaseColumn", "db.postgresql.column"],
    ["databaseConstraint", "db.postgresql.constraint"],
    ["databaseRoutine", "db.postgresql.routine"],
  ] as const) {
    const value = parsed[source];
    if (typeof value === "string" && databaseIdentifierPattern.test(value)) {
      record[destination] = value;
    }
  }

  return Object.freeze(record);
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref();
  });
}

export function createNewRelicLogMirror(options: NewRelicLogMirrorOptions): NewRelicLogMirror {
  if (!safeIdentifierPattern.test(options.release)) {
    throw new Error("New Relic log mirror release is invalid");
  }
  if (
    options.apiKey.length === 0 ||
    options.apiKey.trim() !== options.apiKey ||
    containsControlCharacter(options.apiKey)
  ) {
    throw new Error("New Relic log mirror API key is invalid");
  }
  const logApiEndpoint = logApiEndpointFor(options.otlpEndpoint);

  const send = options.fetch ?? globalThis.fetch;
  const stdout = options.stdout ?? process.stdout;
  const queue: QueuedRecord[] = [];
  let queueBytes = 0;
  let droppedRecords = 0;
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let activeFlush: Promise<void> | undefined;
  let activeController: AbortController | undefined;
  let stopped = false;
  let shutdownDeadline: number | undefined;
  let shutdownPromise: Promise<void> | undefined;

  function drop(reason: LogMirrorDropReason, count = 1): void {
    droppedRecords += count;
    try {
      options.onDrop?.(reason, count);
    } catch {
      // Telemetry reporting cannot recurse through or disable the log mirror.
    }
  }

  function clearFlushTimer(): void {
    if (flushTimer !== undefined) {
      clearTimeout(flushTimer);
      flushTimer = undefined;
    }
  }

  function scheduleFlush(): void {
    if (stopped || flushTimer !== undefined || activeFlush !== undefined || queue.length === 0) {
      return;
    }
    flushTimer = setTimeout(() => {
      flushTimer = undefined;
      void flush();
    }, newRelicLogMirrorTuning.flushIntervalMs);
    flushTimer.unref();
  }

  function enqueue(serialized: string): void {
    const bytes = Buffer.byteLength(serialized, "utf8");
    if (bytes > newRelicLogMirrorTuning.maximumRecordBytes) {
      drop("oversize");
      return;
    }

    while (
      queue.length > 0 &&
      (queue.length >= newRelicLogMirrorTuning.queueMaximumRecords ||
        queueBytes + bytes > newRelicLogMirrorTuning.queueMaximumBytes)
    ) {
      const removed = queue.shift();
      if (removed !== undefined) {
        queueBytes -= removed.bytes;
        drop("overflow");
      }
    }
    if (
      queue.length >= newRelicLogMirrorTuning.queueMaximumRecords ||
      queueBytes + bytes > newRelicLogMirrorTuning.queueMaximumBytes
    ) {
      drop("overflow");
      return;
    }

    queue.push({ bytes, serialized });
    queueBytes += bytes;
    scheduleFlush();
  }

  function ingest(line: string): void {
    if (line.length === 0) {
      return;
    }
    if (Buffer.byteLength(line, "utf8") > newRelicLogMirrorTuning.maximumRecordBytes) {
      drop("oversize");
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      drop("invalid");
      return;
    }
    if (!isRecord(parsed)) {
      drop("invalid");
      return;
    }
    const serialized = JSON.stringify(allowlistedRecord(parsed, options));
    try {
      stdout.write(`${serialized}\n`);
    } catch {
      // A logging destination cannot make an application request fail.
    }
    if (!stopped) {
      enqueue(serialized);
    }
  }

  function takeBatch(): QueuedRecord[] {
    const batch: QueuedRecord[] = [];
    let payloadBytes = 2;
    while (batch.length < newRelicLogMirrorTuning.batchMaximumRecords && queue.length > 0) {
      const next = queue[0];
      if (next === undefined) {
        break;
      }
      const nextPayloadBytes = payloadBytes + next.bytes + (batch.length === 0 ? 0 : 1);
      if (nextPayloadBytes > newRelicLogMirrorTuning.batchMaximumBytes) {
        break;
      }
      queue.shift();
      queueBytes -= next.bytes;
      batch.push(next);
      payloadBytes = nextPayloadBytes;
    }
    return batch;
  }

  function remainingShutdownMilliseconds(): number | undefined {
    return shutdownDeadline === undefined ? undefined : Math.max(0, shutdownDeadline - Date.now());
  }

  async function post(payload: string): Promise<boolean> {
    for (let attempt = 0; attempt < newRelicLogMirrorTuning.deliveryAttempts; attempt += 1) {
      const remaining = remainingShutdownMilliseconds();
      if (remaining !== undefined && remaining <= 0) {
        return false;
      }
      const timeoutMs = Math.max(
        1,
        Math.min(newRelicLogMirrorTuning.requestTimeoutMs, remaining ?? Number.POSITIVE_INFINITY),
      );
      const controller = new AbortController();
      activeController = controller;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const request = send(logApiEndpoint, {
          body: payload,
          headers: {
            "Api-Key": options.apiKey,
            "Content-Type": "application/json",
          },
          method: "POST",
          redirect: "error",
          signal: controller.signal,
        });
        const response = await Promise.race([
          request,
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(() => {
              controller.abort();
              reject(new Error("New Relic log request timed out"));
            }, timeoutMs);
            timeout.unref();
          }),
        ]);
        const accepted = response.ok;
        try {
          await response.body?.cancel();
        } catch {
          // Diagnostic response bodies are never inspected and cannot block delivery or retry.
        }
        if (accepted) {
          return true;
        }
      } catch {
        // Retry only within the fixed attempt and shutdown budgets.
      } finally {
        if (timeout !== undefined) {
          clearTimeout(timeout);
        }
        if (activeController === controller) {
          activeController = undefined;
        }
      }

      const backoff = newRelicLogMirrorTuning.retryBackoffMs[attempt];
      if (backoff === undefined) {
        break;
      }
      const remainingBeforeBackoff = remainingShutdownMilliseconds();
      if (remainingBeforeBackoff !== undefined && remainingBeforeBackoff <= backoff) {
        return false;
      }
      await wait(backoff);
    }
    return false;
  }

  async function drain(): Promise<void> {
    while (queue.length > 0) {
      const batch = takeBatch();
      if (batch.length === 0) {
        const stuck = queue.shift();
        if (stuck !== undefined) {
          queueBytes -= stuck.bytes;
          drop("oversize");
        }
        continue;
      }
      const delivered = await post(`[${batch.map((record) => record.serialized).join(",")}]`);
      if (!delivered) {
        drop(stopped ? "shutdown" : "delivery", batch.length);
      }
      if (remainingShutdownMilliseconds() === 0) {
        break;
      }
    }
  }

  function flush(): Promise<void> {
    clearFlushTimer();
    activeFlush ??= drain().finally(() => {
      activeFlush = undefined;
      scheduleFlush();
    });
    return activeFlush;
  }

  const mirror: NewRelicLogMirror = {
    forceFlush: flush,
    shutdown(): Promise<void> {
      shutdownPromise ??= (async () => {
        stopped = true;
        clearFlushTimer();
        shutdownDeadline = Date.now() + newRelicLogMirrorTuning.shutdownTimeoutMs;
        const operation = flush();
        let timeout: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          operation,
          new Promise<void>((resolve) => {
            timeout = setTimeout(() => {
              activeController?.abort();
              resolve();
            }, newRelicLogMirrorTuning.shutdownTimeoutMs);
            timeout.unref();
          }),
        ]);
        if (timeout !== undefined) {
          clearTimeout(timeout);
        }
        if (queue.length > 0) {
          drop("shutdown", queue.length);
          queue.length = 0;
          queueBytes = 0;
        }
      })();
      return shutdownPromise;
    },
    stats(): Readonly<NewRelicLogMirrorStats> {
      return Object.freeze({
        droppedRecords,
        queuedBytes: queueBytes,
        queuedRecords: queue.length,
      });
    },
    write(message: string): void {
      for (const line of message.split("\n")) {
        ingest(line);
      }
    },
  };

  return Object.freeze(mirror);
}

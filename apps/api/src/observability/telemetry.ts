import type { GenerationModelTier } from "@capstone/protocol";
import {
  type Attributes,
  type Counter,
  type Gauge,
  type Histogram,
  SpanKind,
  SpanStatusCode,
  type Tracer,
  type UpDownCounter,
} from "@opentelemetry/api";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  AggregationTemporality,
  AggregationType,
  createAllowListAttributesProcessor,
  MeterProvider,
  PeriodicExportingMetricReader,
  type PushMetricExporter,
  type ViewOptions,
} from "@opentelemetry/sdk-metrics";
import { BatchSpanProcessor, type SpanExporter } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import {
  type ApplicationTelemetry,
  type DatabasePoolSnapshot,
  type EmailDeliveryTelemetry,
  type HttpTelemetryInput,
  type LogMirrorDropReason,
  type ModelCallSettlement,
  type ModelCallStart,
  type ModelCallTelemetry,
  type TelemetryContextMode,
  type TelemetryEnvironment,
  type TelemetryOutcome,
  type TelemetryPurpose,
  telemetryMetrics,
  telemetrySafeHttpRoutes,
  telemetryTuning,
} from "./telemetry-contract.js";

export interface TelemetryExporterFailure {
  readonly operation: "export" | "flush" | "shutdown";
  readonly signal: "metrics" | "traces";
}

export interface ApplicationTelemetryOptions {
  readonly endpoint: string | null;
  readonly environment: TelemetryEnvironment;
  readonly headers: Readonly<Record<string, string>>;
  readonly onExporterFailure?: ((failure: TelemetryExporterFailure) => void) | undefined;
  readonly release: string;
}

export interface TelemetryExporterOverrides {
  readonly metrics: PushMetricExporter;
  readonly traces: SpanExporter;
}

const healthRoutes = new Set(["/api/health/live", "/api/health/ready"]);
const safeMethods = new Set(["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]);
const safeIdentifierPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function reportExporterFailure(
  callback: ApplicationTelemetryOptions["onExporterFailure"],
  failure: TelemetryExporterFailure,
): void {
  try {
    callback?.(failure);
  } catch {
    // Operational reporting cannot become an application dependency.
  }
}

function wrapTraceExporter(
  exporter: SpanExporter,
  callback: ApplicationTelemetryOptions["onExporterFailure"],
): SpanExporter {
  return {
    export(spans, resultCallback): void {
      exporter.export(spans, (result) => {
        if (result.code !== 0) {
          reportExporterFailure(callback, { operation: "export", signal: "traces" });
        }
        resultCallback(result);
      });
    },
    forceFlush: () => exporter.forceFlush?.() ?? Promise.resolve(),
    shutdown: () => exporter.shutdown(),
  };
}

function wrapMetricExporter(
  exporter: PushMetricExporter,
  callback: ApplicationTelemetryOptions["onExporterFailure"],
): PushMetricExporter {
  return {
    export(metrics, resultCallback): void {
      exporter.export(metrics, (result) => {
        if (result.code !== 0) {
          reportExporterFailure(callback, { operation: "export", signal: "metrics" });
        }
        resultCallback(result);
      });
    },
    forceFlush: () => exporter.forceFlush(),
    selectAggregationTemporality: (instrumentType) =>
      exporter.selectAggregationTemporality?.(instrumentType) ?? AggregationTemporality.CUMULATIVE,
    shutdown: () => exporter.shutdown(),
  };
}

function exporterUrl(endpoint: string, signal: "metrics" | "traces"): string {
  return new URL(`v1/${signal}`, `${endpoint.replace(/\/+$/u, "")}/`).href;
}

function metricViews(): ViewOptions[] {
  return Object.values(telemetryMetrics).map((definition) => ({
    aggregationCardinalityLimit: telemetryTuning.metricCardinalityLimit,
    attributesProcessors: [createAllowListAttributesProcessor([...definition.attributes])],
    instrumentName: definition.name,
    ...(!("boundaries" in definition) || definition.boundaries === undefined
      ? {}
      : {
          aggregation: {
            options: { boundaries: [...definition.boundaries], recordMinMax: true },
            type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM,
          } as const,
        }),
  }));
}

function boundedNumber(value: number, maximum = 86_400_000): number {
  return Number.isFinite(value) ? Math.min(Math.max(value, 0), maximum) : 0;
}

function boundedCount(value: bigint | number | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const numeric = typeof value === "bigint" ? Number(value) : value;
  return Number.isSafeInteger(numeric) && numeric >= 0 ? numeric : undefined;
}

function safeCost(value: string | undefined): { attribute: string; metric: number } | undefined {
  if (value === undefined || !/^(?:0|[1-9]\d*)(?:\.\d{1,24})?$/u.test(value)) {
    return undefined;
  }
  const metric = Number(value);
  return Number.isFinite(metric) && metric >= 0 ? { attribute: value, metric } : undefined;
}

function safeTier(value: GenerationModelTier): "balanced" | "fast" | "pro" | "unknown" {
  return value === "fast" || value === "balanced" || value === "pro" ? value : "unknown";
}

function safePurpose(value: TelemetryPurpose): TelemetryPurpose | "unknown" {
  return value === "chat" || value === "compaction" || value === "title" ? value : "unknown";
}

function safeOutcome(value: TelemetryOutcome): TelemetryOutcome | "unknown" {
  return value === "cancelled" ||
    value === "completed" ||
    value === "failed" ||
    value === "incomplete" ||
    value === "rejected"
    ? value
    : "unknown";
}

function safeContextMode(value: TelemetryContextMode): TelemetryContextMode | "unknown" {
  return value === "full" || value === "compacted" || value === "fallback" ? value : "unknown";
}

function httpMethod(method: string): string {
  const normalized = method.toUpperCase();
  return safeMethods.has(normalized) ? normalized : "OTHER";
}

function httpRoute(route: string | undefined): string {
  return route !== undefined && telemetrySafeHttpRoutes.has(route) ? route : "unmatched";
}

function safeLogMirrorDropReason(reason: LogMirrorDropReason): LogMirrorDropReason {
  return reason === "delivery" ||
    reason === "invalid" ||
    reason === "overflow" ||
    reason === "oversize" ||
    reason === "shutdown"
    ? reason
    : "invalid";
}

function statusCode(value: number): number {
  return Number.isInteger(value) && value >= 100 && value <= 599 ? value : 500;
}

function statusFamily(code: number): "1xx" | "2xx" | "3xx" | "4xx" | "5xx" {
  return `${Math.floor(code / 100)}xx` as "1xx" | "2xx" | "3xx" | "4xx" | "5xx";
}

function requestId(value: string): string {
  return safeIdentifierPattern.test(value) ? value : "unknown";
}

function commonGenerationAttributes(
  tier: GenerationModelTier,
  purpose: TelemetryPurpose,
  outcome?: TelemetryOutcome,
): Attributes {
  return {
    "capstone.model.tier": safeTier(tier),
    "capstone.generation.purpose": safePurpose(purpose),
    ...(outcome === undefined ? {} : { "capstone.outcome": safeOutcome(outcome) }),
  };
}

function noOpModelCall(): ModelCallTelemetry {
  return Object.freeze({
    cancelRequested() {},
    firstToken() {},
    requestSent() {},
    responseStarted() {},
    settle() {},
  });
}

function noOpTelemetry(): ApplicationTelemetry {
  return Object.freeze({
    changeActiveEmployeeStreams() {},
    changeActiveProviderCalls() {},
    forceFlush: async () => undefined,
    observeDatabasePool() {},
    recordBudgetRejection() {},
    recordCancellation() {},
    recordClientError() {},
    recordCompaction() {},
    recordContextDecision() {},
    recordEmailDelivery() {},
    recordGeneration() {},
    recordHttpRequest() {},
    recordLogMirrorDrop() {},
    recordReconciliation() {},
    recordReservationSettlement() {},
    recordResponseStarted() {},
    recordSettlement() {},
    shutdown: async () => undefined,
    startDatabasePoolObservation: () => () => undefined,
    startModelCall: noOpModelCall,
  });
}

async function settleBounded(
  operation: Promise<void>,
  timeoutMs: number,
  onFailure: () => void,
): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("Telemetry operation timed out")), timeoutMs);
      }),
    ]);
  } catch {
    onFailure();
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

export function createApplicationTelemetry(
  options: ApplicationTelemetryOptions,
  exporterOverrides?: TelemetryExporterOverrides,
): ApplicationTelemetry {
  if (options.endpoint === null && exporterOverrides === undefined) {
    return noOpTelemetry();
  }
  if (!safeIdentifierPattern.test(options.release)) {
    throw new Error("Telemetry release is invalid");
  }

  const resource = resourceFromAttributes({
    "deployment.environment": options.environment,
    "service.name": "capstone-chat-api",
    "service.version": options.release,
  });
  const traceExporter = wrapTraceExporter(
    exporterOverrides?.traces ??
      new OTLPTraceExporter({
        concurrencyLimit: telemetryTuning.exporterConcurrency,
        headers: { ...options.headers },
        timeoutMillis: telemetryTuning.exporterTimeoutMs,
        url: exporterUrl(options.endpoint ?? "", "traces"),
      }),
    options.onExporterFailure,
  );
  const metricExporter = wrapMetricExporter(
    exporterOverrides?.metrics ??
      new OTLPMetricExporter({
        concurrencyLimit: telemetryTuning.exporterConcurrency,
        headers: { ...options.headers },
        timeoutMillis: telemetryTuning.exporterTimeoutMs,
        url: exporterUrl(options.endpoint ?? "", "metrics"),
      }),
    options.onExporterFailure,
  );
  const traceProvider = new NodeTracerProvider({
    forceFlushTimeoutMillis: telemetryTuning.shutdownTimeoutMs,
    resource,
    spanLimits: {
      attributeCountLimit: 24,
      attributePerEventCountLimit: 0,
      attributeValueLengthLimit: 128,
      eventCountLimit: 8,
      linkCountLimit: 0,
    },
    spanProcessors: [
      new BatchSpanProcessor(traceExporter, {
        exportTimeoutMillis: telemetryTuning.exporterTimeoutMs,
        maxExportBatchSize: telemetryTuning.spanExportBatchSize,
        maxQueueSize: telemetryTuning.spanQueueSize,
        scheduledDelayMillis: telemetryTuning.spanExportDelayMs,
      }),
    ],
  });
  const metricReader = new PeriodicExportingMetricReader({
    cardinalityLimits: { default: telemetryTuning.metricCardinalityLimit },
    exporter: metricExporter,
    exportIntervalMillis: telemetryTuning.metricExportIntervalMs,
    exportTimeoutMillis: telemetryTuning.exporterTimeoutMs,
    maxExportBatchSize: telemetryTuning.metricExportBatchSize,
  });
  const meterProvider = new MeterProvider({
    readers: [metricReader],
    resource,
    views: metricViews(),
  });
  const tracer = traceProvider.getTracer("capstone-chat-api", options.release);
  const meter = meterProvider.getMeter("capstone-chat-api", options.release);
  const counters = {
    budgetRejections: meter.createCounter(
      telemetryMetrics.budgetRejections.name,
      telemetryMetrics.budgetRejections,
    ),
    clientErrors: meter.createCounter(
      telemetryMetrics.clientErrors.name,
      telemetryMetrics.clientErrors,
    ),
    compactions: meter.createCounter(
      telemetryMetrics.compactions.name,
      telemetryMetrics.compactions,
    ),
    contextDecisions: meter.createCounter(
      telemetryMetrics.contextDecisions.name,
      telemetryMetrics.contextDecisions,
    ),
    emailDeliveries: meter.createCounter(
      telemetryMetrics.emailDeliveries.name,
      telemetryMetrics.emailDeliveries,
    ),
    generations: meter.createCounter(
      telemetryMetrics.generations.name,
      telemetryMetrics.generations,
    ),
    httpRequests: meter.createCounter(
      telemetryMetrics.httpRequests.name,
      telemetryMetrics.httpRequests,
    ),
    logMirrorDrops: meter.createCounter(
      telemetryMetrics.logMirrorDrops.name,
      telemetryMetrics.logMirrorDrops,
    ),
    reconciliationClaims: meter.createCounter(
      telemetryMetrics.reconciliationClaims.name,
      telemetryMetrics.reconciliationClaims,
    ),
    reconciliationErrors: meter.createCounter(
      telemetryMetrics.reconciliationErrors.name,
      telemetryMetrics.reconciliationErrors,
    ),
    reservationSettlements: meter.createCounter(
      telemetryMetrics.reservationSettlements.name,
      telemetryMetrics.reservationSettlements,
    ),
    tokens: meter.createCounter(telemetryMetrics.tokens.name, telemetryMetrics.tokens),
  } satisfies Record<string, Counter>;
  const histograms = {
    cancellationDuration: meter.createHistogram(
      telemetryMetrics.cancellationDuration.name,
      telemetryMetrics.cancellationDuration,
    ),
    emailDeliveryDuration: meter.createHistogram(
      telemetryMetrics.emailDeliveryDuration.name,
      telemetryMetrics.emailDeliveryDuration,
    ),
    generationCost: meter.createHistogram(
      telemetryMetrics.generationCost.name,
      telemetryMetrics.generationCost,
    ),
    generationDuration: meter.createHistogram(
      telemetryMetrics.generationDuration.name,
      telemetryMetrics.generationDuration,
    ),
    httpDuration: meter.createHistogram(
      telemetryMetrics.httpDuration.name,
      telemetryMetrics.httpDuration,
    ),
    providerDuration: meter.createHistogram(
      telemetryMetrics.providerDuration.name,
      telemetryMetrics.providerDuration,
    ),
    providerFirstToken: meter.createHistogram(
      telemetryMetrics.providerFirstToken.name,
      telemetryMetrics.providerFirstToken,
    ),
    providerHeaders: meter.createHistogram(
      telemetryMetrics.providerHeaders.name,
      telemetryMetrics.providerHeaders,
    ),
    reconciliationLag: meter.createHistogram(
      telemetryMetrics.reconciliationLag.name,
      telemetryMetrics.reconciliationLag,
    ),
    responseStarted: meter.createHistogram(
      telemetryMetrics.responseStarted.name,
      telemetryMetrics.responseStarted,
    ),
    settlementDuration: meter.createHistogram(
      telemetryMetrics.settlementDuration.name,
      telemetryMetrics.settlementDuration,
    ),
  } satisfies Record<string, Histogram>;
  const gauges = {
    databasePoolIdle: meter.createGauge(
      telemetryMetrics.databasePoolIdle.name,
      telemetryMetrics.databasePoolIdle,
    ),
    databasePoolTotal: meter.createGauge(
      telemetryMetrics.databasePoolTotal.name,
      telemetryMetrics.databasePoolTotal,
    ),
    databasePoolWaiting: meter.createGauge(
      telemetryMetrics.databasePoolWaiting.name,
      telemetryMetrics.databasePoolWaiting,
    ),
  } satisfies Record<string, Gauge>;
  const active = {
    employeeStreams: meter.createUpDownCounter(
      telemetryMetrics.activeEmployeeStreams.name,
      telemetryMetrics.activeEmployeeStreams,
    ),
    providerCalls: meter.createUpDownCounter(
      telemetryMetrics.activeProviderCalls.name,
      telemetryMetrics.activeProviderCalls,
    ),
  } satisfies Record<string, UpDownCounter>;
  const observationTimers = new Set<ReturnType<typeof setInterval>>();
  let closed = false;
  let shutdownPromise: Promise<void> | undefined;

  function recordModelTokens(
    input: ModelCallStart,
    result: ModelCallSettlement,
    span: ReturnType<Tracer["startSpan"]>,
  ): void {
    for (const [kind, rawValue] of [
      ["cached", result.cachedTokens],
      ["completion", result.completionTokens],
      ["prompt", result.promptTokens],
      ["reasoning", result.reasoningTokens],
    ] as const) {
      const value = boundedCount(rawValue);
      if (value === undefined) {
        continue;
      }
      span.setAttribute(`capstone.tokens.${kind}`, value);
      counters.tokens.add(value, {
        ...commonGenerationAttributes(input.tier, input.purpose, result.outcome),
        "capstone.token.kind": kind,
      });
    }
  }

  const telemetry: ApplicationTelemetry = {
    changeActiveEmployeeStreams(tier, delta): void {
      if (!closed) {
        active.employeeStreams.add(delta, { "capstone.model.tier": safeTier(tier) });
      }
    },
    changeActiveProviderCalls(purpose, delta): void {
      if (!closed) {
        active.providerCalls.add(delta, {
          "capstone.generation.purpose": safePurpose(purpose),
        });
      }
    },
    async forceFlush(): Promise<void> {
      if (closed) {
        return;
      }
      await Promise.all([
        settleBounded(traceProvider.forceFlush(), telemetryTuning.shutdownTimeoutMs, () =>
          reportExporterFailure(options.onExporterFailure, {
            operation: "flush",
            signal: "traces",
          }),
        ),
        settleBounded(meterProvider.forceFlush(), telemetryTuning.shutdownTimeoutMs, () =>
          reportExporterFailure(options.onExporterFailure, {
            operation: "flush",
            signal: "metrics",
          }),
        ),
      ]);
    },
    observeDatabasePool(snapshot): void {
      if (closed) {
        return;
      }
      gauges.databasePoolTotal.record(boundedNumber(snapshot.totalCount, 10_000));
      gauges.databasePoolIdle.record(boundedNumber(snapshot.idleCount, 10_000));
      gauges.databasePoolWaiting.record(boundedNumber(snapshot.waitingCount, 10_000));
    },
    recordBudgetRejection(tier, purpose): void {
      if (!closed) {
        counters.budgetRejections.add(1, commonGenerationAttributes(tier, purpose));
      }
    },
    recordCancellation(tier, purpose, outcome, durationMs): void {
      if (!closed) {
        histograms.cancellationDuration.record(
          boundedNumber(durationMs),
          commonGenerationAttributes(tier, purpose, outcome),
        );
      }
    },
    recordClientError(kind, route): void {
      if (!closed) {
        const safeKind =
          kind === "render" ||
          kind === "resource" ||
          kind === "unhandled_error" ||
          kind === "unhandled_rejection"
            ? kind
            : "unhandled_error";
        const safeRoute =
          route === "identity" || route === "chat" || route === "admin" || route === "unknown"
            ? route
            : "unknown";
        counters.clientErrors.add(1, {
          "capstone.client_error.kind": safeKind,
          "capstone.client_error.route": safeRoute,
        });
      }
    },
    recordCompaction(tier, outcome): void {
      if (!closed) {
        counters.compactions.add(1, {
          "capstone.model.tier": safeTier(tier),
          "capstone.outcome": safeOutcome(outcome),
        });
      }
    },
    recordContextDecision(tier, mode): void {
      if (!closed) {
        counters.contextDecisions.add(1, {
          "capstone.context.mode": safeContextMode(mode),
          "capstone.model.tier": safeTier(tier),
        });
      }
    },
    recordEmailDelivery(report: EmailDeliveryTelemetry): void {
      if (closed) {
        return;
      }
      const category =
        report.category === "authentication" ||
        report.category === "network" ||
        report.category === "provider" ||
        report.category === "rate_limit" ||
        report.category === "timeout"
          ? report.category
          : "unknown";
      const providerStatus = report.providerStatus;
      const providerStatusFamily =
        providerStatus !== undefined &&
        Number.isInteger(providerStatus) &&
        providerStatus >= 100 &&
        providerStatus <= 599
          ? statusFamily(providerStatus)
          : "none";
      const attributes = {
        "capstone.email.category": category,
        "capstone.email.outcome": report.outcome === "sent" ? "sent" : "failed",
        "capstone.email.status_family": providerStatusFamily,
      };
      counters.emailDeliveries.add(1, attributes);
      histograms.emailDeliveryDuration.record(boundedNumber(report.durationMs), attributes);
    },
    recordGeneration(tier, purpose, outcome, durationMs): void {
      if (!closed) {
        const attributes = commonGenerationAttributes(tier, purpose, outcome);
        counters.generations.add(1, attributes);
        histograms.generationDuration.record(boundedNumber(durationMs), attributes);
      }
    },
    recordHttpRequest(input: HttpTelemetryInput): void {
      if (closed) {
        return;
      }
      const code = statusCode(input.statusCode);
      const route = httpRoute(input.route);
      const method = httpMethod(input.method);
      const outcome = code < 400 ? "success" : "failure";
      const durationMs = boundedNumber(input.durationMs);
      const attributes = {
        "capstone.outcome": outcome,
        "capstone.status_family": statusFamily(code),
        "http.request.method": method,
        "http.route": route,
      };
      counters.httpRequests.add(1, attributes);
      histograms.httpDuration.record(durationMs, attributes);

      if (healthRoutes.has(route) && code >= 200 && code < 300) {
        return;
      }
      const endedAt = Date.now();
      const span = tracer.startSpan("capstone.http.request", {
        attributes: {
          ...attributes,
          "capstone.request_id": requestId(input.requestId),
          "http.response.status_code": code,
          "service.version": options.release,
        },
        kind: SpanKind.SERVER,
        startTime: endedAt - durationMs,
      });
      span.setStatus({ code: code >= 400 ? SpanStatusCode.ERROR : SpanStatusCode.OK });
      span.end(endedAt);
    },
    recordLogMirrorDrop(reason, count): void {
      const bounded = boundedCount(count);
      if (!closed && bounded !== undefined && bounded > 0) {
        counters.logMirrorDrops.add(bounded, {
          "capstone.log_mirror.reason": safeLogMirrorDropReason(reason),
        });
      }
    },
    recordReconciliation(input): void {
      if (closed) {
        return;
      }
      const claimed = boundedCount(input.claimed) ?? 0;
      const settled = Math.min(boundedCount(input.settled) ?? 0, claimed);
      const errors = boundedCount(input.errors) ?? 0;
      if (settled > 0) {
        counters.reconciliationClaims.add(settled, { "capstone.outcome": "settled" });
      }
      if (claimed > settled) {
        counters.reconciliationClaims.add(claimed - settled, { "capstone.outcome": "deferred" });
      }
      if (errors > 0) {
        counters.reconciliationErrors.add(errors);
      }
      histograms.reconciliationLag.record(boundedNumber(input.oldestDueLagMs));
    },
    recordReservationSettlement(outcome): void {
      if (!closed) {
        const safe =
          outcome === "actual" || outcome === "estimated" || outcome === "expired"
            ? outcome
            : "estimated";
        counters.reservationSettlements.add(1, { "capstone.outcome": safe });
      }
    },
    recordResponseStarted(tier, purpose, durationMs): void {
      if (!closed) {
        histograms.responseStarted.record(
          boundedNumber(durationMs),
          commonGenerationAttributes(tier, purpose),
        );
      }
    },
    recordSettlement(tier, purpose, outcome, durationMs): void {
      if (!closed) {
        histograms.settlementDuration.record(
          boundedNumber(durationMs),
          commonGenerationAttributes(tier, purpose, outcome),
        );
      }
    },
    async shutdown(): Promise<void> {
      shutdownPromise ??= (async () => {
        for (const timer of observationTimers) {
          clearInterval(timer);
        }
        observationTimers.clear();
        await telemetry.forceFlush();
        closed = true;
        await Promise.all([
          settleBounded(traceProvider.shutdown(), telemetryTuning.shutdownTimeoutMs, () =>
            reportExporterFailure(options.onExporterFailure, {
              operation: "shutdown",
              signal: "traces",
            }),
          ),
          settleBounded(meterProvider.shutdown(), telemetryTuning.shutdownTimeoutMs, () =>
            reportExporterFailure(options.onExporterFailure, {
              operation: "shutdown",
              signal: "metrics",
            }),
          ),
        ]);
      })();
      return shutdownPromise;
    },
    startDatabasePoolObservation(snapshot: () => DatabasePoolSnapshot): () => void {
      if (closed) {
        return () => undefined;
      }
      telemetry.observeDatabasePool(snapshot());
      const timer = setInterval(() => {
        if (!closed) {
          telemetry.observeDatabasePool(snapshot());
        }
      }, telemetryTuning.poolObservationIntervalMs);
      timer.unref();
      observationTimers.add(timer);
      let stopped = false;
      return () => {
        if (!stopped) {
          stopped = true;
          clearInterval(timer);
          observationTimers.delete(timer);
        }
      };
    },
    startModelCall(input: ModelCallStart): ModelCallTelemetry {
      if (closed) {
        return noOpModelCall();
      }
      const span = tracer.startSpan("capstone.model.call", {
        attributes: {
          "capstone.context.mode": safeContextMode(input.contextMode),
          ...(uuidPattern.test(input.generationId)
            ? { "capstone.generation_id": input.generationId }
            : {}),
          "capstone.generation.purpose": safePurpose(input.purpose),
          "capstone.model.tier": safeTier(input.tier),
          "capstone.privacy_policy.version": input.privacyPolicyVersion,
          "service.version": options.release,
        },
        kind: SpanKind.CLIENT,
      });
      let settled = false;
      const generationAttributes = commonGenerationAttributes(input.tier, input.purpose);

      return Object.freeze({
        cancelRequested(): void {
          if (!settled) {
            span.addEvent("cancel.requested");
          }
        },
        firstToken(durationMs: number): void {
          if (!settled) {
            span.addEvent("first.token");
            const duration = boundedNumber(durationMs);
            span.setAttribute("capstone.timing.first_token_ms", duration);
            histograms.providerFirstToken.record(duration, generationAttributes);
          }
        },
        requestSent(): void {
          if (!settled) {
            span.addEvent("request.sent");
          }
        },
        responseStarted(durationMs: number): void {
          if (!settled) {
            span.addEvent("response.started");
            const duration = boundedNumber(durationMs);
            span.setAttribute("capstone.timing.response_headers_ms", duration);
            histograms.providerHeaders.record(duration, generationAttributes);
          }
        },
        settle(result: ModelCallSettlement): void {
          if (settled) {
            return;
          }
          settled = true;
          const outcome = safeOutcome(result.outcome);
          const duration = boundedNumber(result.providerDurationMs);
          span.addEvent("settled");
          span.setAttribute("capstone.outcome", outcome);
          span.setAttribute("capstone.timing.provider_duration_ms", duration);
          histograms.providerDuration.record(
            duration,
            commonGenerationAttributes(input.tier, input.purpose, result.outcome),
          );
          recordModelTokens(input, result, span);
          const cost = safeCost(result.costUsd);
          if (cost !== undefined) {
            span.setAttribute("capstone.cost_usd", cost.attribute);
            histograms.generationCost.record(
              cost.metric,
              commonGenerationAttributes(input.tier, input.purpose, result.outcome),
            );
          }
          span.setStatus({
            code:
              result.outcome === "completed" || result.outcome === "cancelled"
                ? SpanStatusCode.OK
                : SpanStatusCode.ERROR,
          });
          span.end();
        },
      });
    },
  };

  return Object.freeze(telemetry);
}

import type { ClientErrorKind, ClientErrorRoute, GenerationModelTier } from "@capstone/protocol";

export type TelemetryEnvironment = "development" | "production" | "test";
export type TelemetryPurpose = "chat" | "compaction";
export type TelemetryContextMode = "compacted" | "fallback" | "full";
export type TelemetryOutcome = "cancelled" | "completed" | "failed" | "incomplete" | "rejected";

export const telemetryTuning = Object.freeze({
  exporterConcurrency: 1,
  exporterTimeoutMs: 3_000,
  metricCardinalityLimit: 256,
  metricExportBatchSize: 64,
  metricExportIntervalMs: 10_000,
  poolObservationIntervalMs: 15_000,
  shutdownTimeoutMs: 5_000,
  spanExportBatchSize: 64,
  spanExportDelayMs: 1_000,
  spanQueueSize: 256,
});

export const telemetryHistogramBoundaries = Object.freeze({
  costUsd: Object.freeze([0, 0.001, 0.01, 0.05, 0.1, 0.5, 1, 5]),
  durationMs: Object.freeze([5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 30_000]),
  lagMs: Object.freeze([1_000, 5_000, 15_000, 30_000, 60_000, 300_000, 900_000]),
});

interface MetricDefinition {
  readonly attributes: readonly string[];
  readonly boundaries?: readonly number[] | undefined;
  readonly name: string;
  readonly unit: "1" | "USD" | "ms";
}

export const telemetryMetrics = Object.freeze({
  activeEmployeeStreams: {
    attributes: ["capstone.model.tier"],
    name: "capstone.generation.active_employee_streams",
    unit: "1",
  },
  activeProviderCalls: {
    attributes: ["capstone.generation.purpose"],
    name: "capstone.generation.active_provider_calls",
    unit: "1",
  },
  budgetRejections: {
    attributes: ["capstone.model.tier", "capstone.generation.purpose"],
    name: "capstone.budget.rejections",
    unit: "1",
  },
  cancellationDuration: {
    attributes: ["capstone.model.tier", "capstone.generation.purpose", "capstone.outcome"],
    boundaries: telemetryHistogramBoundaries.durationMs,
    name: "capstone.generation.cancellation_duration",
    unit: "ms",
  },
  clientErrors: {
    attributes: ["capstone.client_error.kind", "capstone.client_error.route"],
    name: "capstone.client_errors",
    unit: "1",
  },
  compactions: {
    attributes: ["capstone.model.tier", "capstone.outcome"],
    name: "capstone.compaction.workflows",
    unit: "1",
  },
  contextDecisions: {
    attributes: ["capstone.context.mode", "capstone.model.tier"],
    name: "capstone.context.decisions",
    unit: "1",
  },
  databasePoolIdle: {
    attributes: [],
    name: "capstone.database.pool.idle",
    unit: "1",
  },
  databasePoolTotal: {
    attributes: [],
    name: "capstone.database.pool.total",
    unit: "1",
  },
  databasePoolWaiting: {
    attributes: [],
    name: "capstone.database.pool.waiting",
    unit: "1",
  },
  emailDeliveryDuration: {
    attributes: [
      "capstone.email.outcome",
      "capstone.email.category",
      "capstone.email.status_family",
    ],
    boundaries: telemetryHistogramBoundaries.durationMs,
    name: "capstone.identity.email_delivery_duration",
    unit: "ms",
  },
  emailDeliveries: {
    attributes: [
      "capstone.email.outcome",
      "capstone.email.category",
      "capstone.email.status_family",
    ],
    name: "capstone.identity.email_deliveries",
    unit: "1",
  },
  generationCost: {
    attributes: ["capstone.model.tier", "capstone.generation.purpose", "capstone.outcome"],
    boundaries: telemetryHistogramBoundaries.costUsd,
    name: "capstone.generation.cost",
    unit: "USD",
  },
  generationDuration: {
    attributes: ["capstone.model.tier", "capstone.generation.purpose", "capstone.outcome"],
    boundaries: telemetryHistogramBoundaries.durationMs,
    name: "capstone.generation.workflow_duration",
    unit: "ms",
  },
  generations: {
    attributes: ["capstone.model.tier", "capstone.generation.purpose", "capstone.outcome"],
    name: "capstone.generation.workflows",
    unit: "1",
  },
  httpDuration: {
    attributes: ["http.request.method", "http.route", "capstone.status_family", "capstone.outcome"],
    boundaries: telemetryHistogramBoundaries.durationMs,
    name: "capstone.http.server.duration",
    unit: "ms",
  },
  httpRequests: {
    attributes: ["http.request.method", "http.route", "capstone.status_family", "capstone.outcome"],
    name: "capstone.http.server.requests",
    unit: "1",
  },
  providerDuration: {
    attributes: ["capstone.model.tier", "capstone.generation.purpose", "capstone.outcome"],
    boundaries: telemetryHistogramBoundaries.durationMs,
    name: "capstone.model.provider_duration",
    unit: "ms",
  },
  providerFirstToken: {
    attributes: ["capstone.model.tier", "capstone.generation.purpose"],
    boundaries: telemetryHistogramBoundaries.durationMs,
    name: "capstone.model.first_token_duration",
    unit: "ms",
  },
  providerHeaders: {
    attributes: ["capstone.model.tier", "capstone.generation.purpose"],
    boundaries: telemetryHistogramBoundaries.durationMs,
    name: "capstone.model.response_headers_duration",
    unit: "ms",
  },
  reconciliationClaims: {
    attributes: ["capstone.outcome"],
    name: "capstone.reconciliation.claims",
    unit: "1",
  },
  reconciliationErrors: {
    attributes: [],
    name: "capstone.reconciliation.errors",
    unit: "1",
  },
  reconciliationLag: {
    attributes: [],
    boundaries: telemetryHistogramBoundaries.lagMs,
    name: "capstone.reconciliation.oldest_due_lag",
    unit: "ms",
  },
  reservationSettlements: {
    attributes: ["capstone.outcome"],
    name: "capstone.budget.reservation_settlements",
    unit: "1",
  },
  responseStarted: {
    attributes: ["capstone.model.tier", "capstone.generation.purpose"],
    boundaries: telemetryHistogramBoundaries.durationMs,
    name: "capstone.generation.response_started_duration",
    unit: "ms",
  },
  settlementDuration: {
    attributes: ["capstone.model.tier", "capstone.generation.purpose", "capstone.outcome"],
    boundaries: telemetryHistogramBoundaries.durationMs,
    name: "capstone.generation.settlement_duration",
    unit: "ms",
  },
  tokens: {
    attributes: [
      "capstone.model.tier",
      "capstone.generation.purpose",
      "capstone.outcome",
      "capstone.token.kind",
    ],
    name: "capstone.generation.tokens",
    unit: "1",
  },
} satisfies Readonly<Record<string, MetricDefinition>>);

export interface HttpTelemetryInput {
  readonly durationMs: number;
  readonly method: string;
  readonly requestId: string;
  readonly route: string | undefined;
  readonly statusCode: number;
}

export interface ModelCallStart {
  readonly contextMode: TelemetryContextMode;
  readonly generationId: string;
  readonly privacyPolicyVersion: "not_applicable" | "openrouter-privacy-v1";
  readonly purpose: TelemetryPurpose;
  readonly tier: GenerationModelTier;
}

export interface ModelCallSettlement {
  readonly cachedTokens?: bigint | number | undefined;
  readonly completionTokens?: bigint | number | undefined;
  readonly costUsd?: string | undefined;
  readonly outcome: TelemetryOutcome;
  readonly promptTokens?: bigint | number | undefined;
  readonly providerDurationMs: number;
  readonly reasoningTokens?: bigint | number | undefined;
}

export interface ModelCallTelemetry {
  cancelRequested(): void;
  firstToken(durationMs: number): void;
  requestSent(): void;
  responseStarted(durationMs: number): void;
  settle(result: ModelCallSettlement): void;
}

export interface DatabasePoolSnapshot {
  readonly idleCount: number;
  readonly totalCount: number;
  readonly waitingCount: number;
}

export interface EmailDeliveryTelemetry {
  readonly category?:
    | "authentication"
    | "network"
    | "provider"
    | "rate_limit"
    | "timeout"
    | "unknown"
    | undefined;
  readonly durationMs: number;
  readonly outcome: "failed" | "sent";
  readonly providerStatus?: number | undefined;
}

export interface ApplicationTelemetry {
  changeActiveEmployeeStreams(tier: GenerationModelTier, delta: -1 | 1): void;
  changeActiveProviderCalls(purpose: TelemetryPurpose, delta: -1 | 1): void;
  forceFlush(): Promise<void>;
  recordBudgetRejection(tier: GenerationModelTier, purpose: TelemetryPurpose): void;
  recordCancellation(
    tier: GenerationModelTier,
    purpose: TelemetryPurpose,
    outcome: TelemetryOutcome,
    durationMs: number,
  ): void;
  recordClientError(kind: ClientErrorKind, route: ClientErrorRoute): void;
  recordCompaction(tier: GenerationModelTier, outcome: TelemetryOutcome): void;
  recordContextDecision(tier: GenerationModelTier, mode: TelemetryContextMode): void;
  recordEmailDelivery(report: EmailDeliveryTelemetry): void;
  recordGeneration(
    tier: GenerationModelTier,
    purpose: TelemetryPurpose,
    outcome: TelemetryOutcome,
    durationMs: number,
  ): void;
  recordHttpRequest(input: HttpTelemetryInput): void;
  recordReconciliation(input: {
    readonly claimed: number;
    readonly errors: number;
    readonly oldestDueLagMs: number;
    readonly settled: number;
  }): void;
  recordReservationSettlement(outcome: "actual" | "estimated" | "expired"): void;
  recordResponseStarted(
    tier: GenerationModelTier,
    purpose: TelemetryPurpose,
    durationMs: number,
  ): void;
  recordSettlement(
    tier: GenerationModelTier,
    purpose: TelemetryPurpose,
    outcome: TelemetryOutcome,
    durationMs: number,
  ): void;
  observeDatabasePool(snapshot: DatabasePoolSnapshot): void;
  shutdown(): Promise<void>;
  startDatabasePoolObservation(snapshot: () => DatabasePoolSnapshot): () => void;
  startModelCall(input: ModelCallStart): ModelCallTelemetry;
}

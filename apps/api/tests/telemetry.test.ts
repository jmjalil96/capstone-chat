import {
  AggregationTemporality,
  InMemoryMetricExporter,
  type ResourceMetrics,
} from "@opentelemetry/sdk-metrics";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { afterEach, describe, expect, it } from "vitest";
import {
  createApplicationTelemetry,
  type TelemetryExporterOverrides,
} from "../src/observability/telemetry.js";
import {
  telemetryHistogramBoundaries,
  telemetryMetrics,
  telemetrySafeHttpRoutes,
} from "../src/observability/telemetry-contract.js";

let shutdownTelemetry: (() => Promise<void>) | undefined;

afterEach(async () => {
  await shutdownTelemetry?.();
  shutdownTelemetry = undefined;
});

function inMemoryExporters(): {
  readonly metrics: InMemoryMetricExporter;
  readonly overrides: TelemetryExporterOverrides;
  readonly traces: InMemorySpanExporter;
} {
  const metrics = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const traces = new InMemorySpanExporter();
  return { metrics, overrides: { metrics, traces }, traces };
}

function metricNames(exports: readonly ResourceMetrics[]): string[] {
  return exports.flatMap((resource) =>
    resource.scopeMetrics.flatMap((scope) => scope.metrics.map((metric) => metric.descriptor.name)),
  );
}

describe("content-free application telemetry", () => {
  it("exports closed HTTP/model metadata and keeps successful probes out of traces", async () => {
    const exporters = inMemoryExporters();
    const telemetry = createApplicationTelemetry(
      {
        endpoint: null,
        environment: "test",
        headers: {},
        release: "release-abc123",
      },
      exporters.overrides,
    );
    shutdownTelemetry = () => telemetry.shutdown();

    telemetry.recordHttpRequest({
      durationMs: 7,
      method: "GET",
      requestId: "request-live",
      route: "/api/health/live",
      statusCode: 200,
    });
    telemetry.recordHttpRequest({
      durationMs: 11,
      method: "GET",
      requestId: "request-ready",
      route: "/api/health/ready",
      statusCode: 503,
    });
    telemetry.recordHttpRequest({
      durationMs: 13,
      method: "GET",
      requestId: "PRIVATE REQUEST CANARY",
      route: "/api/private/conversation/CANARY?query=CANARY",
      statusCode: 500,
    });
    const call = telemetry.startModelCall({
      contextMode: "compacted",
      generationId: "11111111-1111-4111-8111-111111111111",
      privacyPolicyVersion: "openrouter-privacy-v1",
      purpose: "chat",
      tier: "balanced",
    });
    call.requestSent();
    call.responseStarted(20);
    call.firstToken(40);
    call.settle({
      cachedTokens: 2,
      completionTokens: 5,
      costUsd: "0.00125",
      outcome: "completed",
      promptTokens: 10,
      providerDurationMs: 100,
      reasoningTokens: 1,
    });
    call.settle({ outcome: "failed", providerDurationMs: 999 });
    telemetry.recordClientError("render", "chat");
    telemetry.recordLogMirrorDrop("overflow", 3);
    telemetry.recordEmailDelivery({
      category: "rate_limit",
      durationMs: 50,
      outcome: "failed",
      providerStatus: 429,
    });

    await telemetry.forceFlush();

    const spans = exporters.traces.getFinishedSpans();
    expect(spans.map((span) => span.name)).toEqual([
      "capstone.http.request",
      "capstone.http.request",
      "capstone.model.call",
    ]);
    expect(spans.some((span) => span.attributes["capstone.request_id"] === "request-live")).toBe(
      false,
    );
    const failedProbe = spans.find(
      (span) => span.attributes["capstone.request_id"] === "request-ready",
    );
    expect(failedProbe?.attributes).toEqual({
      "capstone.outcome": "failure",
      "capstone.request_id": "request-ready",
      "capstone.status_family": "5xx",
      "http.request.method": "GET",
      "http.response.status_code": 503,
      "http.route": "/api/health/ready",
      "service.version": "release-abc123",
    });
    const modelSpan = spans.find((span) => span.name === "capstone.model.call");
    expect(modelSpan?.events.map((event) => event.name)).toEqual([
      "request.sent",
      "response.started",
      "first.token",
      "settled",
    ]);
    expect(modelSpan?.attributes).toMatchObject({
      "capstone.context.mode": "compacted",
      "capstone.cost_usd": "0.00125",
      "capstone.generation.purpose": "chat",
      "capstone.generation_id": "11111111-1111-4111-8111-111111111111",
      "capstone.model.tier": "balanced",
      "capstone.outcome": "completed",
      "capstone.privacy_policy.version": "openrouter-privacy-v1",
      "capstone.tokens.completion": 5,
      "capstone.tokens.prompt": 10,
    });

    const metricExports = exporters.metrics.getMetrics();
    expect(metricNames(metricExports)).toEqual(
      expect.arrayContaining([
        telemetryMetrics.clientErrors.name,
        telemetryMetrics.emailDeliveries.name,
        telemetryMetrics.httpDuration.name,
        telemetryMetrics.httpRequests.name,
        telemetryMetrics.logMirrorDrops.name,
        telemetryMetrics.providerFirstToken.name,
        telemetryMetrics.tokens.name,
      ]),
    );
    const snapshot = JSON.stringify({
      metrics: metricExports.flatMap((resource) =>
        resource.scopeMetrics.flatMap((scope) =>
          scope.metrics.map((metric) => ({
            attributes: metric.dataPoints.map((point) => point.attributes),
            name: metric.descriptor.name,
          })),
        ),
      ),
      spans: spans.map((span) => ({
        attributes: span.attributes,
        events: span.events.map((event) => ({ attributes: event.attributes, name: event.name })),
        name: span.name,
      })),
    });
    expect(snapshot).not.toMatch(/PRIVATE|query=|conversation\/CANARY/iu);
    expect(snapshot).not.toMatch(/message|stack|response\.body|request\.body/iu);
  });

  it("declares explicit histogram bounds and low-cardinality label allowlists", () => {
    expect(telemetryHistogramBoundaries.durationMs).toEqual([
      5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 30_000,
    ]);
    expect(telemetryMetrics.httpDuration).toMatchObject({
      attributes: [
        "http.request.method",
        "http.route",
        "capstone.status_family",
        "capstone.outcome",
      ],
      unit: "ms",
    });
    expect(
      Object.values(telemetryMetrics).flatMap((definition) => definition.attributes),
    ).not.toEqual(
      expect.arrayContaining([
        "user.id",
        "conversation.id",
        "model.id",
        "provider",
        "url.full",
        "url.query",
      ]),
    );
    for (const route of [
      "/api/admin/answer-reports",
      "/api/admin/answer-reports/:reportId",
      "/api/conversations/:conversationId/answer-report-states",
      "/api/conversations/:conversationId/messages/:messageId/report",
    ]) {
      expect(telemetrySafeHttpRoutes.has(route)).toBe(true);
    }
  });

  it("uses an inert implementation when OTLP is disabled", async () => {
    const telemetry = createApplicationTelemetry({
      endpoint: null,
      environment: "development",
      headers: {},
      release: "local",
    });

    expect(() =>
      telemetry.recordHttpRequest({
        durationMs: 1,
        method: "GET",
        requestId: "request",
        route: "/api/session",
        statusCode: 200,
      }),
    ).not.toThrow();
    await expect(telemetry.forceFlush()).resolves.toBeUndefined();
    await expect(telemetry.shutdown()).resolves.toBeUndefined();
  });
});

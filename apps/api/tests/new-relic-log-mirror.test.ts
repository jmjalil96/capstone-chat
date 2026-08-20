import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createNewRelicLogMirror as createMirror,
  newRelicLogMirrorTuning,
} from "../src/observability/new-relic-log-mirror.js";
import type { LogMirrorDropReason } from "../src/observability/telemetry-contract.js";

const release = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function createNewRelicLogMirror(
  options: Omit<Parameters<typeof createMirror>[0], "otlpEndpoint"> & {
    readonly otlpEndpoint?: string;
  },
): ReturnType<typeof createMirror> {
  return createMirror({ otlpEndpoint: "https://otlp.nr-data.net", ...options });
}

function successfulFetch(): ReturnType<typeof vi.fn<typeof fetch>> {
  return vi.fn<typeof fetch>(async () => new Response(null, { status: 202 }));
}

function logLine(overrides: Readonly<Record<string, unknown>> = {}): string {
  return `${JSON.stringify({
    level: 30,
    method: "GET",
    msg: "request completed",
    requestId: "11111111-1111-4111-8111-111111111111",
    responseTime: 12.5,
    route: "/api/session",
    statusCode: 200,
    time: 1_800_000_000_000,
    ...overrides,
  })}\n`;
}

function maximalAllowlistedLogLine(): string {
  const databaseIdentifier = `a${"b".repeat(62)}`;
  return logLine({
    category: "reservation-reconciliation",
    configurationKey: "CAPSTONE_BOOTSTRAP_MIGRATION_DATABASE_URL",
    database: "unknown",
    databaseColumn: databaseIdentifier,
    databaseConstraint: databaseIdentifier,
    databaseRoutine: databaseIdentifier,
    databaseSchema: databaseIdentifier,
    databaseSeverity: "WARNING",
    databaseTable: databaseIdentifier,
    errorCode: `FST_ERR_${"A".repeat(48)}`,
    errorName: "EmployeeAdministrationConflictError",
    hook: "registration-link",
    kind: "unhandled_rejection",
    level: 60,
    method: "DELETE",
    msg: "request failed",
    operation: "readiness-authority",
    purpose: "password-reset",
    readiness: "unavailable",
    requestId: "ffffffff-ffff-8fff-bfff-ffffffffffff",
    responseTime: 86_400_000,
    route: "/api/conversations/:conversationId/responses/:generationId/cancel",
    signal: "SIGTERM",
    statusCode: 599,
    time: Number.MAX_SAFE_INTEGER,
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("bounded New Relic log mirror", () => {
  it("writes and sends only the explicit content-free field allowlist", async () => {
    const fetch = successfulFetch();
    const stdout: string[] = [];
    const mirror = createNewRelicLogMirror({
      apiKey: "new-relic-license-key",
      environment: "production",
      fetch,
      release,
      stdout: { write: (message) => stdout.push(message) },
    });

    mirror.write(
      logLine({
        authorization: "Bearer PRIVATE_AUTH_CANARY",
        configurationKey: "DATABASE_URL",
        cookie: "PRIVATE_COOKIE_CANARY",
        databaseConstraint: "messages_pkey",
        databaseSeverity: "ERROR",
        errorCode: "23505",
        errorName: "Error",
        prompt: "PRIVATE_PROMPT_CANARY",
        response: "PRIVATE_RESPONSE_CANARY",
        stack: "PRIVATE_STACK_CANARY",
        url: "https://chat.capstone.com.ec/private?query=PRIVATE_URL_CANARY",
      }),
    );
    await mirror.forceFlush();

    expect(fetch).toHaveBeenCalledOnce();
    const [endpoint, request] = fetch.mock.calls[0] ?? [];
    expect(endpoint).toBe("https://log-api.newrelic.com/log/v1");
    expect(request).toMatchObject({
      headers: {
        "Api-Key": "new-relic-license-key",
        "Content-Type": "application/json",
      },
      method: "POST",
      redirect: "error",
    });
    const payload = JSON.parse(String(request?.body)) as Record<string, unknown>[];
    expect(payload).toEqual([
      {
        "deployment.environment": "production",
        "capstone.configuration.key": "DATABASE_URL",
        "db.postgresql.constraint": "messages_pkey",
        "db.postgresql.severity": "ERROR",
        "error.code": "23505",
        "error.name": "Error",
        event: "http.request_completed",
        "http.request.method": "GET",
        "http.response.duration_ms": 12.5,
        "http.response.status_code": 200,
        "http.route": "/api/session",
        level: 30,
        "request.id": "11111111-1111-4111-8111-111111111111",
        "service.name": "capstone-chat-api",
        "service.version": release,
        timestamp: 1_800_000_000_000,
      },
    ]);
    const exported = `${stdout.join("")}\n${String(request?.body)}`;
    expect(exported).not.toMatch(/PRIVATE_|authorization|cookie|prompt|response"|stack/iu);
    expect(exported).not.toContain("https://chat.capstone.com.ec/private");
    await mirror.shutdown();
  });

  it("exports report endpoints only as bounded route templates", async () => {
    const fetch = successfulFetch();
    const mirror = createNewRelicLogMirror({
      apiKey: "new-relic-license-key",
      environment: "production",
      fetch,
      release,
      stdout: { write: () => undefined },
    });
    const routes = [
      "/api/admin/answer-reports",
      "/api/admin/answer-reports/:reportId",
      "/api/conversations/:conversationId/answer-report-states",
      "/api/conversations/:conversationId/messages/:messageId/report",
    ];
    for (const route of routes) {
      mirror.write(
        logLine({
          note: "PRIVATE_REPORT_NOTE_CANARY",
          prompt: "PRIVATE_REPORT_PROMPT_CANARY",
          response: "PRIVATE_REPORT_ANSWER_CANARY",
          route,
        }),
      );
    }
    await mirror.forceFlush();

    const payload = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)) as Array<
      Record<string, unknown>
    >;
    expect(payload.map((record) => record["http.route"])).toEqual(routes);
    expect(JSON.stringify(payload)).not.toMatch(/PRIVATE_REPORT_/gu);
    await mirror.shutdown();
  });

  it("keeps the log destination in the selected New Relic account region", async () => {
    const fetch = successfulFetch();
    const mirror = createNewRelicLogMirror({
      apiKey: "new-relic-license-key",
      environment: "production",
      fetch,
      otlpEndpoint: "https://otlp.eu01.nr-data.net",
      release,
      stdout: { write: () => undefined },
    });

    mirror.write(logLine());
    await mirror.forceFlush();

    expect(fetch.mock.calls[0]?.[0]).toBe("https://log-api.eu.newrelic.com/log/v1");
    await mirror.shutdown();
  });

  it("labels staging records without weakening the regional destination", async () => {
    const fetch = successfulFetch();
    const mirror = createNewRelicLogMirror({
      apiKey: "new-relic-license-key",
      environment: "staging",
      fetch,
      otlpEndpoint: "https://otlp.eu01.nr-data.net",
      release,
      stdout: { write: () => undefined },
    });

    mirror.write(logLine());
    await mirror.forceFlush();

    expect(fetch.mock.calls[0]?.[0]).toBe("https://log-api.eu.newrelic.com/log/v1");
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toMatchObject([
      { "deployment.environment": "staging" },
    ]);
    await mirror.shutdown();
  });

  it("rejects an unsupported New Relic account region", () => {
    expect(() =>
      createNewRelicLogMirror({
        apiKey: "new-relic-license-key",
        environment: "production",
        otlpEndpoint: "https://otlp.staging.nr-data.net",
        release,
        stdout: { write: () => undefined },
      }),
    ).toThrow("OTLP endpoint is invalid");
  });

  it("rejects arbitrary values placed in diagnostic fields", async () => {
    const fetch = successfulFetch();
    const mirror = createNewRelicLogMirror({
      apiKey: "new-relic-license-key",
      environment: "production",
      fetch,
      release,
      stdout: { write: () => undefined },
    });

    mirror.write(
      logLine({
        configurationKey: "PRIVATE_CONFIGURATION_CANARY",
        databaseConstraint: "PRIVATE_DATABASE_CANARY",
        databaseSeverity: "PRIVATE_SEVERITY_CANARY",
        errorCode: "PRIVATE_ERROR_CANARY",
        errorName: "PrivatePromptError",
      }),
    );
    await mirror.forceFlush();

    expect(String(fetch.mock.calls[0]?.[1]?.body)).not.toMatch(/PRIVATE|PrivatePrompt/gu);
    await mirror.shutdown();
  });

  it("rejects malformed and oversized input before enqueueing", () => {
    const drops: [LogMirrorDropReason, number][] = [];
    const mirror = createNewRelicLogMirror({
      apiKey: "new-relic-license-key",
      environment: "production",
      onDrop: (reason, count) => drops.push([reason, count]),
      release,
      stdout: { write: () => undefined },
    });

    mirror.write("not-json\n");
    mirror.write(
      `${JSON.stringify({ msg: "x".repeat(newRelicLogMirrorTuning.maximumRecordBytes) })}\n`,
    );

    expect(mirror.stats()).toEqual({ droppedRecords: 2, queuedBytes: 0, queuedRecords: 0 });
    expect(drops).toEqual([
      ["invalid", 1],
      ["oversize", 1],
    ]);
  });

  it("drops the oldest record at the exact queue-count boundary", async () => {
    vi.useFakeTimers();
    const fetch = successfulFetch();
    const drops: [LogMirrorDropReason, number][] = [];
    const mirror = createNewRelicLogMirror({
      apiKey: "new-relic-license-key",
      environment: "production",
      fetch,
      onDrop: (reason, count) => drops.push([reason, count]),
      release,
      stdout: { write: () => undefined },
    });

    for (let index = 0; index <= newRelicLogMirrorTuning.queueMaximumRecords; index += 1) {
      const suffix = index.toString(16).padStart(12, "0");
      mirror.write(logLine({ requestId: `11111111-1111-4111-8111-${suffix}` }));
    }

    expect(mirror.stats().queuedRecords).toBe(newRelicLogMirrorTuning.queueMaximumRecords);
    expect(drops).toEqual([["overflow", 1]]);
    await mirror.forceFlush();
    expect(fetch).toHaveBeenCalledTimes(
      newRelicLogMirrorTuning.queueMaximumRecords / newRelicLogMirrorTuning.batchMaximumRecords,
    );
    const firstPayload = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)) as Record<
      string,
      unknown
    >[];
    expect(firstPayload).toHaveLength(newRelicLogMirrorTuning.batchMaximumRecords);
    expect(firstPayload[0]?.["request.id"]).toBe("11111111-1111-4111-8111-000000000001");
    for (const call of fetch.mock.calls) {
      expect(Buffer.byteLength(String(call[1]?.body), "utf8")).toBeLessThanOrEqual(
        newRelicLogMirrorTuning.batchMaximumBytes,
      );
    }
    await mirror.shutdown();
  });

  it("drops at the exact queue-byte boundary with maximal allowlisted records", async () => {
    vi.useFakeTimers();
    const fetch = successfulFetch();
    const drops: [LogMirrorDropReason, number][] = [];
    const mirror = createNewRelicLogMirror({
      apiKey: "new-relic-license-key",
      environment: "production",
      fetch,
      onDrop: (reason, count) => drops.push([reason, count]),
      release,
      stdout: { write: () => undefined },
    });
    const line = maximalAllowlistedLogLine();
    mirror.write(line);
    const recordBytes = mirror.stats().queuedBytes;
    const byteCapacity = Math.floor(newRelicLogMirrorTuning.queueMaximumBytes / recordBytes);
    expect(byteCapacity).toBeLessThan(newRelicLogMirrorTuning.queueMaximumRecords);
    expect(
      2 +
        newRelicLogMirrorTuning.batchMaximumRecords * recordBytes +
        (newRelicLogMirrorTuning.batchMaximumRecords - 1),
    ).toBeLessThanOrEqual(newRelicLogMirrorTuning.batchMaximumBytes);

    for (let index = 1; index < byteCapacity; index += 1) {
      mirror.write(line);
    }
    expect(mirror.stats()).toEqual({
      droppedRecords: 0,
      queuedBytes: byteCapacity * recordBytes,
      queuedRecords: byteCapacity,
    });

    mirror.write(line);
    expect(mirror.stats()).toEqual({
      droppedRecords: 1,
      queuedBytes: byteCapacity * recordBytes,
      queuedRecords: byteCapacity,
    });
    expect(drops).toEqual([["overflow", 1]]);

    await mirror.forceFlush();
    expect(fetch).toHaveBeenCalledTimes(
      Math.ceil(byteCapacity / newRelicLogMirrorTuning.batchMaximumRecords),
    );
    for (const call of fetch.mock.calls) {
      expect(Buffer.byteLength(String(call[1]?.body), "utf8")).toBeLessThanOrEqual(
        newRelicLogMirrorTuning.batchMaximumBytes,
      );
      const payload = JSON.parse(String(call[1]?.body)) as unknown[];
      expect(payload.length).toBeGreaterThan(0);
      expect(payload.length).toBeLessThanOrEqual(newRelicLogMirrorTuning.batchMaximumRecords);
    }
    await mirror.shutdown();
  });

  it("uses one request at a time and exactly three bounded delivery attempts", async () => {
    vi.useFakeTimers();
    let active = 0;
    let maximumActive = 0;
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      active -= 1;
      throw new Error("synthetic New Relic outage");
    });
    const drops: [LogMirrorDropReason, number][] = [];
    const mirror = createNewRelicLogMirror({
      apiKey: "new-relic-license-key",
      environment: "production",
      fetch,
      onDrop: (reason, count) => drops.push([reason, count]),
      release,
      stdout: { write: () => undefined },
    });
    mirror.write(logLine());

    const flushing = mirror.forceFlush();
    await vi.runAllTimersAsync();
    await flushing;

    expect(fetch).toHaveBeenCalledTimes(newRelicLogMirrorTuning.deliveryAttempts);
    expect(maximumActive).toBe(1);
    expect(drops).toEqual([["delivery", 1]]);
    await mirror.shutdown();
  });

  it.each([
    [202, 1],
    [503, newRelicLogMirrorTuning.deliveryAttempts],
  ])("cancels every %i response body without reading it", async (status, attempts) => {
    vi.useFakeTimers();
    const cancel = vi.fn(async () => undefined);
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      const response = new Response(null, { status });
      Object.defineProperty(response, "body", { value: { cancel } });
      return response;
    });
    const mirror = createNewRelicLogMirror({
      apiKey: "new-relic-license-key",
      environment: "production",
      fetch,
      release,
      stdout: { write: () => undefined },
    });
    mirror.write(logLine());

    const flushing = mirror.forceFlush();
    await vi.runAllTimersAsync();
    await flushing;

    expect(fetch).toHaveBeenCalledTimes(attempts);
    expect(cancel).toHaveBeenCalledTimes(attempts);
    await mirror.shutdown();
  });

  it("times out each ordinary delivery attempt at three seconds", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn<typeof globalThis.fetch>(
      async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        }),
    );
    const drops: [LogMirrorDropReason, number][] = [];
    const mirror = createNewRelicLogMirror({
      apiKey: "new-relic-license-key",
      environment: "production",
      fetch,
      onDrop: (reason, count) => drops.push([reason, count]),
      release,
      stdout: { write: () => undefined },
    });
    mirror.write(logLine());

    const flushing = mirror.forceFlush();
    await vi.runAllTimersAsync();
    await flushing;

    expect(fetch).toHaveBeenCalledTimes(newRelicLogMirrorTuning.deliveryAttempts);
    expect(drops).toEqual([["delivery", 1]]);
    await mirror.shutdown();
  });

  it("bounds a stalled shutdown to five seconds and drops without throwing", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn<typeof globalThis.fetch>(() => new Promise<Response>(() => undefined));
    const drops: [LogMirrorDropReason, number][] = [];
    const mirror = createNewRelicLogMirror({
      apiKey: "new-relic-license-key",
      environment: "production",
      fetch,
      onDrop: (reason, count) => drops.push([reason, count]),
      release,
      stdout: { write: () => undefined },
    });
    mirror.write(logLine());

    const shutdown = mirror.shutdown();
    await vi.advanceTimersByTimeAsync(newRelicLogMirrorTuning.shutdownTimeoutMs);
    await expect(shutdown).resolves.toBeUndefined();

    expect(fetch.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(fetch.mock.calls.length).toBeLessThanOrEqual(newRelicLogMirrorTuning.deliveryAttempts);
    expect(drops.some(([reason]) => reason === "shutdown")).toBe(true);
    expect(mirror.stats().queuedRecords).toBe(0);
  });
});

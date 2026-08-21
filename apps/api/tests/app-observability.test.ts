import { describe, expect, it, vi } from "vitest";
import { createApplication } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import type { AppDatabase, AppTransaction } from "../src/database/database.js";
import type { DatabasePool } from "../src/database/pool.js";
import { LoadModelGateway } from "../src/load/load-gateway.js";
import type { ModelPolicyService } from "../src/model-policy/service.js";
import type { ApplicationTelemetry } from "../src/observability/telemetry-contract.js";
import { testEffectiveParameters } from "./support/generation.js";

function createDatabase(): AppDatabase {
  const transaction = {
    execute: vi.fn(async () => ({ rows: [{ requestCount: 1 }] })),
  } as unknown as AppTransaction;

  return {
    transaction: async <T>(work: (current: AppTransaction) => Promise<T>): Promise<T> =>
      work(transaction),
  } as unknown as AppDatabase;
}

function createTelemetry(input: { readonly events: string[]; readonly poolSnapshots: unknown[] }) {
  const recordClientError = vi.fn();
  const recordHttpRequest = vi.fn();
  const shutdown = vi.fn(async () => {
    input.events.push("telemetry:shutdown");
  });
  const stopPoolObservation = vi.fn();
  const telemetry = {
    changeActiveEmployeeStreams() {},
    changeActiveProviderCalls() {},
    forceFlush: async () => undefined,
    observeDatabasePool() {},
    recordBudgetRejection() {},
    recordCancellation() {},
    recordClientError,
    recordCompaction() {},
    recordContextDecision() {},
    recordEmailDelivery() {},
    recordGeneration() {},
    recordHttpRequest,
    recordLogMirrorDrop() {},
    recordReconciliation() {},
    recordReservationSettlement() {},
    recordResponseStarted() {},
    recordSettlement() {},
    shutdown,
    startDatabasePoolObservation(snapshot) {
      input.poolSnapshots.push(snapshot());
      return stopPoolObservation;
    },
    startModelCall: () => ({
      cancelRequested() {},
      firstToken() {},
      requestSent() {},
      responseStarted() {},
      settle() {},
    }),
  } satisfies ApplicationTelemetry;

  return { recordClientError, recordHttpRequest, shutdown, stopPoolObservation, telemetry };
}

describe("application observability composition", () => {
  it.each(["staging", "production"] as const)(
    "requires the same OpenRouter readiness authority in %s",
    async (applicationEnvironment) => {
      const origin =
        applicationEnvironment === "staging"
          ? "https://staging.chat.capstone.com.ec"
          : "https://chat.capstone.com.ec";
      const config = {
        ...loadConfig({
          BETTER_AUTH_SECRET: "hosted-readiness-secret-with-at-least-thirty-two-characters",
          CAPSTONE_ENVIRONMENT: applicationEnvironment,
          ...(applicationEnvironment === "staging"
            ? { CAPSTONE_STAGING_EMAIL_RECIPIENTS: "qa@capstone.com.ec" }
            : {}),
          DATABASE_URL:
            "postgresql://app:secret@database.internal:5432/capstone?sslmode=verify-full",
          DEPLOYMENT_REVISION: "a".repeat(40),
          EMAIL_DELIVERY: "resend",
          EMAIL_FROM:
            applicationEnvironment === "staging"
              ? "Capstone Chat Staging <no-reply@staging.mail.capstone.com.ec>"
              : "Capstone Chat <no-reply@mail.capstone.com.ec>",
          HOST: "0.0.0.0",
          MODEL_GATEWAY: "openrouter",
          NODE_ENV: "production",
          OPENROUTER_API_KEY: "test-openrouter-key-never-sent",
          OTEL_EXPORTER_OTLP_ENDPOINT: "https://otlp.nr-data.net",
          OTEL_EXPORTER_OTLP_HEADERS: "api-key=test-license-key-never-sent",
          PUBLIC_ORIGIN: origin,
          RESEND_API_KEY: "test-resend-key-never-sent",
        }),
        webAssetsDirectory: null,
      };
      const assertRuntimeMode = vi.fn(async () => undefined);
      const pool = {
        end: vi.fn(async () => undefined),
        query: vi.fn(async () => ({ rows: [{ result: 1 }] })),
      } satisfies DatabasePool;
      const application = createApplication(config, {
        database: createDatabase(),
        loggerStream: { write() {} },
        logMirror: null,
        modelPolicy: { assertRuntimeMode } as unknown as ModelPolicyService,
        pool,
        telemetry: createTelemetry({ events: [], poolSnapshots: [] }).telemetry,
      });

      await expect(application.lifecycle.initialize()).resolves.toEqual({
        database: "up",
        status: "ready",
      });
      expect(assertRuntimeMode).toHaveBeenCalledWith("openrouter");
      await application.shutdown();
    },
  );

  it("runs local readiness and deterministic generation without a provider client", async () => {
    const config = {
      ...loadConfig({ NODE_ENV: "test" }),
      webAssetsDirectory: null,
    };
    const pool = {
      end: vi.fn(async () => undefined),
      query: vi.fn(async () => ({ rows: [{ result: 1 }] })),
    } satisfies DatabasePool;
    const events: string[] = [];
    const telemetry = createTelemetry({ events, poolSnapshots: [] }).telemetry;
    const assertRuntimeMode = vi.fn(async () => undefined);
    const dependencies = {
      database: createDatabase(),
      logMirror: null,
      modelPolicy: { assertRuntimeMode } as unknown as ModelPolicyService,
      pool,
      telemetry,
    };

    const gateway = new LoadModelGateway();
    const application = createApplication(config, { ...dependencies, modelGateway: gateway });
    await expect(application.lifecycle.initialize()).resolves.toEqual({
      database: "up",
      status: "ready",
    });
    expect(assertRuntimeMode).not.toHaveBeenCalled();

    const gatewayEvents = [];
    for await (const event of gateway.stream(
      {
        effectiveParameters: testEffectiveParameters(),
        history: [],
        message: { role: "user", text: "not-a-load-canary" },
        modelTier: "balanced",
        purpose: "chat",
        systemPrompt: { text: "Synthetic system prompt", version: "test" },
      },
      new AbortController().signal,
    )) {
      gatewayEvents.push(event);
    }
    expect(gatewayEvents.map(({ type }) => type)).toEqual(["response.headers", "response.failed"]);
    expect(gatewayEvents.at(-1)).toMatchObject({
      errorCode: "GENERATION_FAILED",
      providerErrorType: "invalid_prompt",
      type: "response.failed",
    });
    await application.shutdown();
  });

  it("wires bounded reports and closes telemetry after the database pool", async () => {
    const config = loadConfig({ NODE_ENV: "test" });
    const events: string[] = [];
    const poolSnapshots: unknown[] = [];
    let finishPoolEnd: (() => void) | undefined;
    const pool = {
      end: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            events.push("pool:end");
            finishPoolEnd = resolve;
          }),
      ),
      idleCount: 3,
      query: vi.fn(async () => ({ rows: [{ result: 1 }] })),
      totalCount: 5,
      waitingCount: 1,
    } satisfies DatabasePool & {
      readonly idleCount: number;
      readonly totalCount: number;
      readonly waitingCount: number;
    };
    const observed = createTelemetry({ events, poolSnapshots });
    const logMirror = {
      forceFlush: vi.fn(async () => undefined),
      shutdown: vi.fn(async () => {
        events.push("log-mirror:shutdown");
      }),
      stats: () => ({ droppedRecords: 0, queuedBytes: 0, queuedRecords: 0 }),
      write: vi.fn(),
    };
    const application = createApplication(config, {
      database: createDatabase(),
      logMirror,
      pool,
      telemetry: observed.telemetry,
    });

    expect(poolSnapshots).toEqual([{ idleCount: 3, totalCount: 5, waitingCount: 1 }]);

    const health = await application.server.inject({ method: "GET", url: "/api/health/live" });
    expect(health.statusCode).toBe(200);
    expect(observed.recordHttpRequest).toHaveBeenCalledWith(
      expect.objectContaining({ method: "GET", route: "/api/health/live", statusCode: 200 }),
    );

    const report = await application.server.inject({
      headers: { origin: config.publicOrigin },
      method: "POST",
      payload: { kind: "render", release: config.deploymentRevision, route: "chat" },
      url: "/api/client-errors",
    });
    expect(report.statusCode).toBe(204);
    expect(observed.recordClientError).toHaveBeenCalledWith("render", "chat");

    const shuttingDown = application.shutdown();
    await vi.waitFor(() => expect(pool.end).toHaveBeenCalledOnce());
    expect(observed.stopPoolObservation).toHaveBeenCalledOnce();
    expect(observed.shutdown).not.toHaveBeenCalled();

    finishPoolEnd?.();
    await shuttingDown;

    expect(events).toEqual(["pool:end", "log-mirror:shutdown", "telemetry:shutdown"]);
    expect(logMirror.shutdown).toHaveBeenCalledOnce();
    expect(application.lifecycle.phase).toBe("stopped");
  });

  it("keeps HTTP handling and shutdown available when instrumentation throws", async () => {
    const config = loadConfig({ NODE_ENV: "test" });
    const events: string[] = [];
    const observed = createTelemetry({ events, poolSnapshots: [] });
    const pool = {
      end: vi.fn(async () => undefined),
      idleCount: 1,
      query: vi.fn(async () => ({ rows: [{ result: 1 }] })),
      totalCount: 1,
      waitingCount: 0,
    } satisfies DatabasePool & {
      readonly idleCount: number;
      readonly totalCount: number;
      readonly waitingCount: number;
    };
    const application = createApplication(config, {
      database: createDatabase(),
      pool,
      telemetry: {
        ...observed.telemetry,
        recordHttpRequest() {
          throw new Error("Synthetic telemetry failure");
        },
        startDatabasePoolObservation() {
          throw new Error("Synthetic telemetry failure");
        },
      },
    });

    const health = await application.server.inject({ method: "GET", url: "/api/health/live" });
    expect(health.statusCode).toBe(200);
    await expect(application.shutdown()).resolves.toBeUndefined();
    expect(pool.end).toHaveBeenCalledOnce();
    expect(observed.shutdown).toHaveBeenCalledOnce();
  });
});

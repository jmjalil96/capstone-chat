import { describe, expect, it, vi } from "vitest";
import { createApplication } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import type { AppDatabase, AppTransaction } from "../src/database/database.js";
import type { DatabasePool } from "../src/database/pool.js";
import type { ApplicationTelemetry } from "../src/observability/telemetry-contract.js";

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
    const application = createApplication(config, {
      database: createDatabase(),
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

    expect(events).toEqual(["pool:end", "telemetry:shutdown"]);
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

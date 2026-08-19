import { describe, expect, it, vi } from "vitest";
import { createApplication } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import type { AppDatabase, AppTransaction } from "../src/database/database.js";
import type { DatabasePool } from "../src/database/pool.js";
import type { ModelPolicyService } from "../src/model-policy/service.js";
import type { ApplicationTelemetry } from "../src/observability/telemetry-contract.js";
import { telemetrySafeHttpRoutes } from "../src/observability/telemetry-contract.js";

// The allowlist caps metric and log-mirror label cardinality: `telemetry.ts` reports an
// unlisted route as "unmatched" and `new-relic-log-mirror.ts` drops its `http.route`
// field entirely. Both fail silently, so a route added without its allowlist entry loses
// observability without breaking anything. Assert the contract against the routes Fastify
// actually registers instead of a hand-maintained sample.

function createDatabase(): AppDatabase {
  const transaction = {
    execute: vi.fn(async () => ({ rows: [] })),
  } as unknown as AppTransaction;

  return {
    transaction: async <T>(work: (current: AppTransaction) => Promise<T>): Promise<T> =>
      work(transaction),
  } as unknown as AppDatabase;
}

function createTelemetry(): ApplicationTelemetry {
  return {
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
    startDatabasePoolObservation: () => () => {},
    startModelCall: () => ({
      cancelRequested() {},
      firstToken() {},
      requestSent() {},
      responseStarted() {},
      settle() {},
    }),
  } satisfies ApplicationTelemetry;
}

async function registeredApiRoutes(): Promise<readonly string[]> {
  const config = {
    ...loadConfig({
      BETTER_AUTH_SECRET: "telemetry-route-coverage-auth-secret-at-least-32",
      DATABASE_URL: "postgresql://app:secret@database.internal:5432/capstone",
      EMAIL_DELIVERY: "fake",
      LOG_LEVEL: "silent",
      MODEL_GATEWAY: "fake",
      NODE_ENV: "test",
      PUBLIC_ORIGIN: "http://127.0.0.1:4173",
    }),
    webAssetsDirectory: null,
  };
  const pool = {
    end: vi.fn(async () => undefined),
    query: vi.fn(async () => ({ rows: [{ result: 1 }] })),
  } satisfies DatabasePool;
  const application = createApplication(config, {
    database: createDatabase(),
    logMirror: null,
    modelPolicy: {
      assertRuntimeMode: vi.fn(async () => undefined),
    } as unknown as ModelPolicyService,
    pool,
    telemetry: createTelemetry(),
  });

  await application.server.ready();
  const printed = application.server.printRoutes({ commonPrefix: false });
  await application.shutdown();

  return parsePrintedRoutes(printed);
}

// `printRoutes` renders a tree whose children carry only their own path segment, so a
// nested route has to be rebuilt from its ancestors. An `onRoute` hook cannot replace
// this: it only observes routes registered after the hook itself, and `createApplication`
// registers every route before it returns.
function parsePrintedRoutes(printed: string): readonly string[] {
  const segments: string[] = [];
  const routes: string[] = [];

  for (const line of printed.split("\n")) {
    if (line.trim().length === 0) {
      continue;
    }
    const depth = (line.match(/[│ ]{4}/g) ?? []).length;
    const cleaned = line.replace(/^[│ ]*(?:├──|└──)\s?/u, "");
    const methods = /\((.*)\)\s*$/u.exec(cleaned)?.[1];
    segments[depth] = cleaned.replace(/\s*\(.*\)\s*$/u, "");
    segments.length = depth + 1;
    if (methods !== undefined) {
      routes.push(segments.join(""));
    }
  }

  return routes;
}

describe("telemetry route coverage", () => {
  it("lists every registered /api route in the telemetry allowlist", async () => {
    const routes = await registeredApiRoutes();
    const apiRoutes = routes.filter((route) => route.startsWith("/api"));

    expect(apiRoutes.length).toBeGreaterThan(0);

    const missing = apiRoutes.filter((route) => !telemetrySafeHttpRoutes.has(route)).sort();
    expect(missing).toEqual([]);
  });

  it("keeps the allowlist free of routes the application no longer registers", async () => {
    const routes = new Set(await registeredApiRoutes());
    // Routes registered only under other configurations: the mailbox needs
    // NODE_ENV=development (development-mailbox.ts), and Better Auth's wildcard is
    // rendered by printRoutes as its expanded children rather than "/api/auth/*".
    const conditional = new Set(["/api/auth/*", "/api/dev/mailbox"]);
    const stale = [...telemetrySafeHttpRoutes]
      .filter((route) => route.startsWith("/api"))
      .filter((route) => !routes.has(route) && !conditional.has(route))
      .sort();

    expect(stale).toEqual([]);
  });
});

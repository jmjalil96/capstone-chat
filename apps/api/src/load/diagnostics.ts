import { monitorEventLoopDelay } from "node:perf_hooks";
import type { FastifyInstance } from "fastify";
import type { DatabasePool } from "../database/pool.js";
import type { ActiveStreamRegistry } from "../generations/active-streams.js";

const sampleIntervalMilliseconds = 50;

interface ObservedPool extends DatabasePool {
  readonly idleCount?: unknown;
  readonly totalCount?: unknown;
  readonly waitingCount?: unknown;
}

interface ProcessSample {
  readonly heapUsedBytes: number;
  readonly rssBytes: number;
}

interface DatabaseChallenge {
  readonly first: number;
  readonly second: number;
}

type GarbageCollectedGlobal = typeof globalThis & { readonly gc?: () => void };

export function hasExplicitGarbageCollector(): boolean {
  return typeof (globalThis as GarbageCollectedGlobal).gc === "function";
}

function collectGarbage(): void {
  const collect = (globalThis as GarbageCollectedGlobal).gc;
  if (collect === undefined) {
    return;
  }
  collect();
  collect();
}

function processSample(): ProcessSample {
  const memory = process.memoryUsage();
  return { heapUsedBytes: memory.heapUsed, rssBytes: memory.rss };
}

function poolCount(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function databaseChallenge(value: unknown): DatabaseChallenge | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const candidate = value as Partial<DatabaseChallenge>;
  if (
    typeof candidate.first !== "number" ||
    !Number.isInteger(candidate.first) ||
    candidate.first < -2_147_483_648 ||
    candidate.first > 2_147_483_647 ||
    typeof candidate.second !== "number" ||
    !Number.isInteger(candidate.second) ||
    candidate.second < -2_147_483_648 ||
    candidate.second > 2_147_483_647
  ) {
    return null;
  }
  return { first: candidate.first, second: candidate.second };
}

function challengeWasAcquired(value: unknown): boolean {
  if (typeof value !== "object" || value === null) {
    throw new Error("The load database challenge returned an invalid result");
  }
  const rows = (value as { readonly rows?: unknown }).rows;
  if (!Array.isArray(rows) || typeof rows[0] !== "object" || rows[0] === null) {
    throw new Error("The load database challenge returned an invalid result");
  }
  const acquired = (rows[0] as { readonly acquired?: unknown }).acquired;
  if (typeof acquired !== "boolean") {
    throw new Error("The load database challenge returned an invalid result");
  }
  return acquired;
}

export function registerLoadDiagnostics(
  server: FastifyInstance,
  pool: DatabasePool,
  streams: ActiveStreamRegistry,
): void {
  const observedPool = pool as ObservedPool;
  const eventLoop = monitorEventLoopDelay({ resolution: 10 });
  eventLoop.enable();
  let baseline = processSample();
  let cpuBaseline = process.cpuUsage();
  let elapsedBaseline = process.hrtime.bigint();
  let peakHeapUsedBytes = baseline.heapUsedBytes;
  let peakRssBytes = baseline.rssBytes;
  let peakPoolWaiting = poolCount(observedPool.waitingCount);
  let peakActiveStreams = streams.size;

  function sample(): ProcessSample {
    const current = processSample();
    peakHeapUsedBytes = Math.max(peakHeapUsedBytes, current.heapUsedBytes);
    peakRssBytes = Math.max(peakRssBytes, current.rssBytes);
    peakPoolWaiting = Math.max(peakPoolWaiting, poolCount(observedPool.waitingCount));
    peakActiveStreams = Math.max(peakActiveStreams, streams.size);
    return current;
  }

  function snapshot(collectIdleGarbage = false) {
    if (collectIdleGarbage) {
      // Explicit collection is load-harness-only. It removes V8 scheduling noise without hiding
      // sockets, timers, buffers, or other objects that remain reachable after an idle period.
      collectGarbage();
    }
    const current = sample();
    const elapsedMicroseconds = Number(process.hrtime.bigint() - elapsedBaseline) / 1_000;
    const cpu = process.cpuUsage(cpuBaseline);
    return Object.freeze({
      baseline,
      cpu: Object.freeze({
        utilizationPercent:
          elapsedMicroseconds <= 0
            ? 0
            : Number((((cpu.system + cpu.user) / elapsedMicroseconds) * 100).toFixed(2)),
      }),
      current,
      eventLoop: Object.freeze({
        maximumDelayMilliseconds: Number((eventLoop.max / 1_000_000).toFixed(2)),
        p99DelayMilliseconds: Number((eventLoop.percentile(99) / 1_000_000).toFixed(2)),
      }),
      loadHarnessVersion: 1,
      peak: Object.freeze({ heapUsedBytes: peakHeapUsedBytes, rssBytes: peakRssBytes }),
      pool: Object.freeze({
        idle: poolCount(observedPool.idleCount),
        peakWaiting: peakPoolWaiting,
        total: poolCount(observedPool.totalCount),
        waiting: poolCount(observedPool.waitingCount),
      }),
      streams: Object.freeze({ active: streams.size, peakActive: peakActiveStreams }),
    });
  }

  function reset() {
    eventLoop.reset();
    collectGarbage();
    baseline = processSample();
    cpuBaseline = process.cpuUsage();
    elapsedBaseline = process.hrtime.bigint();
    peakHeapUsedBytes = baseline.heapUsedBytes;
    peakRssBytes = baseline.rssBytes;
    peakPoolWaiting = poolCount(observedPool.waitingCount);
    peakActiveStreams = streams.size;
    return snapshot();
  }

  const sampleTimer = setInterval(sample, sampleIntervalMilliseconds);
  sampleTimer.unref();

  server.get("/__load/metrics", (_request, reply) => {
    void reply.header("cache-control", "no-store");
    return snapshot();
  });
  server.post("/__load/metrics/idle", (_request, reply) => {
    void reply.header("cache-control", "no-store");
    return snapshot(true);
  });
  server.post("/__load/metrics/reset", (_request, reply) => {
    void reply.header("cache-control", "no-store");
    return reset();
  });
  server.post("/__load/database-challenge", async (request, reply) => {
    void reply.header("cache-control", "no-store");
    const challenge = databaseChallenge(request.body);
    if (challenge === null) {
      return reply.code(400).send({ loadHarnessVersion: 1, matched: false });
    }
    const lock = `${challenge.first}, ${challenge.second}`;
    // The transaction-scoped probe releases itself immediately when the target points elsewhere.
    // It conflicts with the harness's held session lock only when both connections reach this DB.
    const acquired = challengeWasAcquired(
      await pool.query(`SELECT pg_try_advisory_xact_lock(${lock}) AS acquired`),
    );
    return { loadHarnessVersion: 1, matched: !acquired };
  });
  server.addHook("onClose", (_instance, done) => {
    clearInterval(sampleTimer);
    eventLoop.disable();
    done();
  });
}

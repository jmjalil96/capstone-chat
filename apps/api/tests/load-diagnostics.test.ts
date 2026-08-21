import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import type { DatabasePool } from "../src/database/pool.js";
import { ActiveStreamRegistry } from "../src/generations/active-streams.js";
import { registerLoadDiagnostics } from "../src/load/diagnostics.js";

class ObservablePool implements DatabasePool {
  challengeAcquired = false;
  idleCount = 2;
  totalCount = 3;
  waitingCount = 1;

  async end(): Promise<void> {}

  async query(queryText: string): Promise<unknown> {
    if (queryText.startsWith("SELECT pg_try_advisory_xact_lock")) {
      return { rows: [{ acquired: this.challengeAcquired }] };
    }
    throw new Error("Unexpected diagnostics query");
  }
}

const applications: ReturnType<typeof Fastify>[] = [];

afterEach(async () => {
  await Promise.all(applications.splice(0).map((application) => application.close()));
});

describe("load diagnostics", () => {
  it("reports and resets bounded target-process, event-loop, and pool measurements", async () => {
    const application = Fastify();
    const pool = new ObservablePool();
    const streams = new ActiveStreamRegistry();
    applications.push(application);
    const secret = "diagnostics-secret-with-at-least-32-characters";
    const headers = { authorization: `Bearer ${secret}` };
    registerLoadDiagnostics(application, pool, streams, secret);

    await expect(
      application.inject({ method: "GET", url: "/__load/metrics" }),
    ).resolves.toMatchObject({ statusCode: 404 });
    await expect(
      application.inject({
        headers: { authorization: "Bearer wrong-secret-with-at-least-32-characters" },
        method: "GET",
        url: "/__load/metrics",
      }),
    ).resolves.toMatchObject({ statusCode: 404 });

    const lease = streams.register("generation-one");

    pool.waitingCount = 4;
    await new Promise<void>((resolve) => setTimeout(resolve, 70));
    const measured = await application.inject({ headers, method: "GET", url: "/__load/metrics" });
    expect(measured.statusCode).toBe(200);
    expect(measured.headers["cache-control"]).toBe("no-store");
    expect(measured.json()).toMatchObject({
      cpu: { utilizationPercent: expect.any(Number) },
      eventLoop: {
        maximumDelayMilliseconds: expect.any(Number),
        p99DelayMilliseconds: expect.any(Number),
      },
      loadHarnessVersion: 1,
      pool: { idle: 2, peakWaiting: 4, total: 3, waiting: 4 },
      streams: { active: 1, peakActive: 1 },
    });

    lease.release();
    pool.waitingCount = 0;
    const reset = await application.inject({
      headers,
      method: "POST",
      url: "/__load/metrics/reset",
    });
    expect(reset.statusCode).toBe(200);
    expect(reset.json()).toMatchObject({
      pool: { peakWaiting: 0, waiting: 0 },
      streams: { active: 0, peakActive: 0 },
    });

    const challenge = await application.inject({
      method: "POST",
      headers,
      payload: { first: 123, second: -456 },
      url: "/__load/database-challenge",
    });
    expect(challenge.statusCode).toBe(200);
    expect(challenge.json()).toEqual({ loadHarnessVersion: 1, matched: true });

    pool.challengeAcquired = true;
    const mismatch = await application.inject({
      method: "POST",
      headers,
      payload: { first: 123, second: -456 },
      url: "/__load/database-challenge",
    });
    expect(mismatch.statusCode).toBe(200);
    expect(mismatch.json()).toEqual({ loadHarnessVersion: 1, matched: false });

    const invalidChallenge = await application.inject({
      method: "POST",
      headers,
      payload: { first: "123", second: 456 },
      url: "/__load/database-challenge",
    });
    expect(invalidChallenge.statusCode).toBe(400);
    expect(invalidChallenge.json()).toEqual({ loadHarnessVersion: 1, matched: false });
  });
});

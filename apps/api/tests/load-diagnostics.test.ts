import { request as httpRequest } from "node:http";
import { TypeBoxValidatorCompiler } from "@fastify/type-provider-typebox";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DatabasePool } from "../src/database/pool.js";
import { ActiveStreamRegistry } from "../src/generations/active-streams.js";
import type { ResponseStreamCoordinator } from "../src/generations/response-stream.js";
import {
  ResponseUpdatesRequestAborted,
  type ResponseUpdatesService,
} from "../src/generations/response-updates.js";
import type { GenerationService } from "../src/generations/service.js";
import type { ActorResolver, RequestActor } from "../src/identity/authorization.js";
import { registerLoadDiagnostics } from "../src/load/diagnostics.js";
import { registerResponseRoutes } from "../src/routes/responses.js";

const conversationId = "11111111-1111-4111-8111-111111111111";
const generationId = "22222222-2222-4222-8222-222222222222";
const actor: RequestActor = Object.freeze({
  employee: Object.freeze({ email: "member@example.test", id: "member", name: "Member" }),
  role: "member",
  session: Object.freeze({
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 60_000),
    id: "member-session",
  }),
  workspace: Object.freeze({ id: conversationId, identity: "synthetic", name: "Synthetic" }),
});
const resolveActor: ActorResolver = async () => ({
  actor,
  authenticationHeaders: new Headers(),
});

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
      updates: { active: 0, peakActive: 0 },
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
      updates: { active: 0, peakActive: 0 },
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

  it("releases an active updates request after a real client socket abort", async () => {
    const application = Fastify({ logger: false }).setValidatorCompiler(TypeBoxValidatorCompiler);
    const pool = new ObservablePool();
    const streams = new ActiveStreamRegistry();
    const entered = Promise.withResolvers<void>();
    const aborted = Promise.withResolvers<void>();
    const readUpdates = vi.fn<ResponseUpdatesService["readUpdates"]>(
      async (_actor, _conversationId, _generationId, _cursor, options) => {
        const signal = options?.signal;
        if (signal === undefined) {
          throw new Error("The updates route did not provide its downstream signal");
        }
        entered.resolve();
        await new Promise<void>((resolve) => {
          if (signal.aborted) {
            resolve();
            return;
          }
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
        aborted.resolve();
        throw new ResponseUpdatesRequestAborted();
      },
    );
    registerResponseRoutes(application, {
      generations: {} as GenerationService,
      registry: streams,
      resolveActor,
      streams: {} as ResponseStreamCoordinator,
      updates: { readUpdates },
    });
    const secret = "diagnostics-secret-with-at-least-32-characters";
    const headers = { authorization: `Bearer ${secret}` };
    registerLoadDiagnostics(application, pool, streams, secret);
    applications.push(application);

    const address = await application.listen({ host: "127.0.0.1", port: 0 });
    const request = httpRequest(
      `${address}/api/conversations/${conversationId}/responses/${generationId}/updates`,
      { headers: { "content-type": "application/json" }, method: "POST" },
    );
    request.on("error", () => undefined);
    try {
      request.end(JSON.stringify({ cursor: null }));
      await entered.promise;
      const active = await application.inject({ headers, method: "GET", url: "/__load/metrics" });
      expect(active.json()).toMatchObject({ updates: { active: 1, peakActive: 1 } });

      request.destroy();
      await expect(
        Promise.race([
          aborted.promise.then(() => true),
          new Promise<false>((resolve) => setTimeout(() => resolve(false), 1_000)),
        ]),
      ).resolves.toBe(true);
      const idle = await application.inject({ headers, method: "GET", url: "/__load/metrics" });
      expect(idle.json()).toMatchObject({ updates: { active: 0, peakActive: 1 } });
      expect(readUpdates).toHaveBeenCalledOnce();
    } finally {
      request.destroy();
    }
  });
});

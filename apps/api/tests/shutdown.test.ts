import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { createApplication } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import type { DatabasePool } from "../src/database/pool.js";
import { ActiveStreamRegistry } from "../src/generations/active-streams.js";
import type { ModelGateway } from "../src/generations/model-gateway.js";
import { systemPrompt } from "../src/generations/prompt.js";
import type {
  DurableGenerationState,
  GenerationService,
  StartedResponse,
} from "../src/generations/service.js";
import { generationTuning } from "../src/generations/settings.js";
import type { EmailSender } from "../src/identity/email.js";
import type { CostControlMaintenance } from "../src/model-policy/maintenance.js";
import type { ApplicationTelemetry } from "../src/observability/telemetry-contract.js";
import { httpServerTuning } from "../src/security/http.js";
import { applicationShutdownBudget } from "../src/shutdown-budget.js";
import { testEffectiveParameters } from "./support/generation.js";

const completingResponse: StartedResponse = {
  admittedAt: new Date(),
  conversationId: "00000000-0000-4000-8000-000000000011",
  generationId: "00000000-0000-4000-8000-000000000012",
  messageId: "00000000-0000-4000-8000-000000000013",
  request: {
    effectiveParameters: testEffectiveParameters(),
    history: [],
    message: { role: "user", text: "complete-during-drain" },
    modelTier: "balanced",
    purpose: "chat",
    systemPrompt,
  },
  revision: 1,
  userMessageId: "00000000-0000-4000-8000-000000000014",
};

const stalledResponse: StartedResponse = {
  admittedAt: new Date(),
  conversationId: "00000000-0000-4000-8000-000000000021",
  generationId: "00000000-0000-4000-8000-000000000022",
  messageId: "00000000-0000-4000-8000-000000000023",
  request: {
    effectiveParameters: testEffectiveParameters(),
    history: [],
    message: { role: "user", text: "stall-until-shutdown" },
    modelTier: "balanced",
    purpose: "chat",
    systemPrompt,
  },
  revision: 1,
  userMessageId: "00000000-0000-4000-8000-000000000024",
};

interface MutableGeneration {
  content: string;
  firstTokenAt: Date | null;
  state: DurableGenerationState;
}

async function streamEvents(response: Response): Promise<readonly Record<string, unknown>[]> {
  return (await response.text())
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function shutdownResourceSpies() {
  const closeEmail = vi.fn(async () => undefined);
  const shutdownTelemetry = vi.fn(async () => undefined);
  return {
    closeEmail,
    emailSender: {
      close: closeEmail,
      kind: "disabled",
      send: vi.fn(async () => undefined),
    } satisfies EmailSender,
    shutdownTelemetry,
    telemetry: { shutdown: shutdownTelemetry } as unknown as ApplicationTelemetry,
  };
}

describe("graceful shutdown", () => {
  it("keeps the process alive through a bounded failed SIGTERM shutdown", async () => {
    const childPath = fileURLToPath(new URL("./support/shutdown-signal-child.ts", import.meta.url));
    const child = spawn(process.execPath, ["--import", "tsx", childPath], {
      env: { ...process.env, NODE_ENV: "test" },
      stdio: ["ignore", "pipe", "ignore"],
    });
    const startedAt = Date.now();
    let output = "";
    child.stdout.setEncoding("utf8");
    let signalled = false;
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
      if (!signalled && output.includes("ready\n")) {
        signalled = true;
        child.kill("SIGTERM");
      }
    });

    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => resolve({ code, signal }));
      },
    );

    expect(result).toEqual({ code: 1, signal: null });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(
      applicationShutdownBudget.databasePoolShutdownMaximumMilliseconds,
    );
  }, 15_000);

  it("fits every bounded shutdown phase inside the production platform delay", () => {
    expect(applicationShutdownBudget).toEqual({
      applicationMaximumMilliseconds: 294_000,
      databasePoolShutdownMaximumMilliseconds: 2_000,
      emailShutdownMaximumMilliseconds: 2_000,
      finalResourceMaximumMilliseconds: 2_000,
      forcedStreamCleanupMilliseconds: 30_000,
      httpAndMaintenanceMaximumMilliseconds: 275_000,
      logMirrorShutdownMaximumMilliseconds: 6_000,
      ordinaryDrainMilliseconds: 5_000,
      platformDelayMilliseconds: 300_000,
      platformHeadroomMilliseconds: 6_000,
      streamDrainMilliseconds: 240_000,
      telemetryShutdownMaximumMilliseconds: 11_000,
      workFenceMaximumMilliseconds: 275_000,
    });
    expect(applicationShutdownBudget.applicationMaximumMilliseconds).toBeLessThan(
      applicationShutdownBudget.platformDelayMilliseconds,
    );
  });

  it("bounds stalled process-owned resources inside the production shutdown maximum", async () => {
    const never = () => new Promise<never>(() => undefined);
    const closeEmail = vi.fn(never);
    const endPool = vi.fn(never);
    const stopMaintenance = vi.fn(never);
    const shutdownLogMirror = vi.fn(never);
    const shutdownTelemetry = vi.fn(never);
    const application = createApplication(loadConfig({ NODE_ENV: "test" }), {
      emailSender: {
        close: closeEmail,
        kind: "disabled",
        send: vi.fn(async () => undefined),
      },
      maintenance: {
        runOnce: vi.fn(async () => ({
          catalogRefresh: null,
          namingReconciliation: null,
          reconciliation: null,
        })),
        start: vi.fn(),
        stop: stopMaintenance,
      },
      logMirror: {
        forceFlush: vi.fn(async () => undefined),
        shutdown: shutdownLogMirror,
        stats: () => ({ droppedRecords: 0, queuedBytes: 0, queuedRecords: 0 }),
        write: vi.fn(),
      },
      pool: {
        end: endPool,
        query: vi.fn(async () => ({ rows: [{ result: 1 }] })),
      },
      telemetry: { shutdown: shutdownTelemetry } as unknown as ApplicationTelemetry,
    });

    vi.useFakeTimers();
    try {
      const startedAt = Date.now();
      const shutdown = application.shutdown();
      const rejected = expect(shutdown).rejects.toThrow("application shutdown failed");

      await vi.advanceTimersByTimeAsync(
        applicationShutdownBudget.httpAndMaintenanceMaximumMilliseconds,
      );
      expect(closeEmail).toHaveBeenCalledOnce();
      expect(endPool).toHaveBeenCalledOnce();
      expect(shutdownTelemetry).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(applicationShutdownBudget.finalResourceMaximumMilliseconds);
      expect(shutdownLogMirror).toHaveBeenCalledOnce();
      expect(shutdownTelemetry).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(
        applicationShutdownBudget.logMirrorShutdownMaximumMilliseconds,
      );
      expect(shutdownTelemetry).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(
        applicationShutdownBudget.telemetryShutdownMaximumMilliseconds,
      );
      await rejected;

      expect(Date.now() - startedAt).toBe(applicationShutdownBudget.applicationMaximumMilliseconds);
      expect(application.lifecycle.phase).toBe("stopped");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets a valid ordinary request finish during its short drain", async () => {
    const pool: DatabasePool = {
      end: vi.fn(async () => undefined),
      query: vi.fn(async () => ({ rows: [{ result: 1 }] })),
    };
    const application = createApplication(loadConfig({ NODE_ENV: "test" }), { pool });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    application.server.get("/api/test/ordinary-drain", async () => {
      entered.resolve();
      await release.promise;
      return { drained: true };
    });
    await application.server.listen({ host: "127.0.0.1", port: 0 });
    await application.lifecycle.initialize();
    const address = application.server.server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Synthetic shutdown listener did not expose a port");
    }

    const responsePromise = fetch(`http://127.0.0.1:${address.port}/api/test/ordinary-drain`, {
      headers: { connection: "close" },
    });
    await entered.promise;
    const shutdown = application.shutdown();
    expect(application.lifecycle.phase).toBe("draining");
    release.resolve();

    const response = await responsePromise;
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ drained: true });
    await expect(shutdown).resolves.toBeUndefined();
    expect(pool.end).toHaveBeenCalledOnce();
  });

  it("fences a response promoted after shutdown behind its terminal write", async () => {
    const routeEntered = Promise.withResolvers<void>();
    const releaseRoute = Promise.withResolvers<void>();
    const terminalWriteEntered = Promise.withResolvers<void>();
    const releaseTerminalWrite = Promise.withResolvers<void>();
    let state: DurableGenerationState = {
      assistantMessageId: completingResponse.messageId,
      conversationId: completingResponse.conversationId,
      errorCode: null,
      reason: null,
      revision: completingResponse.revision,
      status: "active",
    };
    const generations = {
      checkpoint: vi.fn(async () => false),
      readState: vi.fn(async () => ({ ...state })),
      terminalize: vi.fn(
        async (_generationId: string, input: Parameters<GenerationService["terminalize"]>[1]) => {
          terminalWriteEntered.resolve();
          await releaseTerminalWrite.promise;
          state = {
            assistantMessageId: state.assistantMessageId,
            conversationId: state.conversationId,
            errorCode: input.errorCode,
            reason: input.reason,
            revision: (state.revision ?? 0) + 1,
            status: input.status,
          };
          return { ...state, won: true };
        },
      ),
    } as unknown as GenerationService;
    const gateway: ModelGateway = {
      async *stream(_request, signal) {
        signal.throwIfAborted();
        yield {
          reason: "stop",
          type: "response.completed",
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    };
    const streamRegistry = new ActiveStreamRegistry();
    const end = vi.fn(async () => {
      expect(streamRegistry.size).toBe(0);
      expect(state).toMatchObject({
        errorCode: "STREAM_INTERRUPTED",
        reason: "error",
        status: "failed",
      });
    });
    const pool: DatabasePool = {
      end,
      query: vi.fn(async () => ({ rows: [{ result: 1 }] })),
    };
    const application = createApplication(loadConfig({ NODE_ENV: "test" }), {
      generations,
      modelGateway: gateway,
      pool,
      streamRegistry,
    });
    application.server.get("/api/test/promote-during-shutdown", async (request, reply) => {
      routeEntered.resolve();
      await releaseRoute.promise;
      await application.responseStreams.stream(completingResponse, request, reply);
    });
    await application.server.listen({ host: "127.0.0.1", port: 0 });
    await application.lifecycle.initialize();
    const address = application.server.server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Synthetic shutdown listener did not expose a port");
    }

    const responsePromise = fetch(
      `http://127.0.0.1:${address.port}/api/test/promote-during-shutdown`,
      {
        headers: { connection: "close" },
      },
    );
    await routeEntered.promise;
    const shutdown = application.shutdown();
    releaseRoute.resolve();
    await terminalWriteEntered.promise;

    expect(streamRegistry.size).toBe(1);
    expect(end).not.toHaveBeenCalled();
    releaseTerminalWrite.resolve();

    const response = await responsePromise;
    expect(response.status).toBe(200);
    await response.text();
    await expect(shutdown).resolves.toBeUndefined();
    expect(generations.terminalize).toHaveBeenCalledOnce();
    expect(end).toHaveBeenCalledOnce();
  });

  it("seals a force-closed ordinary handler against post-deadline stream work", async () => {
    const routeEntered = Promise.withResolvers<void>();
    const releaseRoute = Promise.withResolvers<void>();
    const routeFinished = Promise.withResolvers<void>();
    const generations = {
      checkpoint: vi.fn(async () => false),
      readState: vi.fn(async () => null),
      terminalize: vi.fn(),
    } as unknown as GenerationService;
    const gateway: ModelGateway = {
      async *stream() {
        yield {
          reason: "stop",
          type: "response.completed",
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    };
    const streamRegistry = new ActiveStreamRegistry();
    const pool: DatabasePool = {
      end: vi.fn(async () => undefined),
      query: vi.fn(async () => ({ rows: [{ result: 1 }] })),
    };
    const application = createApplication(loadConfig({ NODE_ENV: "test" }), {
      generations,
      modelGateway: gateway,
      pool,
      streamRegistry,
    });
    application.server.get("/api/test/promote-after-deadline", async (request, reply) => {
      routeEntered.resolve();
      try {
        await releaseRoute.promise;
        await application.responseStreams.stream(stalledResponse, request, reply);
      } finally {
        routeFinished.resolve();
      }
    });
    await application.server.listen({ host: "127.0.0.1", port: 0 });
    await application.lifecycle.initialize();
    const address = application.server.server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Synthetic shutdown listener did not expose a port");
    }

    const responsePromise = fetch(
      `http://127.0.0.1:${address.port}/api/test/promote-after-deadline`,
      {
        headers: { connection: "close" },
      },
    ).catch(() => undefined);
    await routeEntered.promise;

    vi.useFakeTimers();
    let fakeTimers = true;
    let shutdown: Promise<void>;
    try {
      shutdown = application.shutdown();
      await vi.advanceTimersByTimeAsync(httpServerTuning.ordinaryDrainMilliseconds);
      expect(pool.end).not.toHaveBeenCalled();
      releaseRoute.resolve();
      await routeFinished.promise;
      await vi.advanceTimersByTimeAsync(0);
      vi.useRealTimers();
      fakeTimers = false;
      await shutdown;
    } finally {
      if (fakeTimers) {
        vi.useRealTimers();
      }
    }
    await responsePromise;
    expect(application.lifecycle.phase).toBe("stopped");
    expect(pool.end).toHaveBeenCalledOnce();
    expect(streamRegistry.size).toBe(0);
    expect(generations.checkpoint).not.toHaveBeenCalled();
    expect(generations.readState).not.toHaveBeenCalled();
    expect(generations.terminalize).not.toHaveBeenCalled();
  });

  it("keeps a force-closed ordinary handler ahead of database shutdown", async () => {
    const routeEntered = Promise.withResolvers<void>();
    const releaseRoute = Promise.withResolvers<void>();
    const lateQueryEntered = Promise.withResolvers<void>();
    const releaseLateQuery = Promise.withResolvers<void>();
    const routeFinished = Promise.withResolvers<void>();
    const end = vi.fn(async () => undefined);
    const query = vi.fn(async (queryText: string) => {
      if (queryText === "SELECT 1") {
        return { rows: [{ result: 1 }] };
      }
      lateQueryEntered.resolve();
      await releaseLateQuery.promise;
      return { rows: [{ result: 2 }] };
    });
    const pool: DatabasePool = { end, query };
    const application = createApplication(loadConfig({ NODE_ENV: "test" }), { pool });
    application.server.get("/api/test/late-ordinary-database", async () => {
      routeEntered.resolve();
      try {
        await releaseRoute.promise;
        await pool.query("select 2");
        return { completed: true };
      } finally {
        routeFinished.resolve();
      }
    });
    await application.server.listen({ host: "127.0.0.1", port: 0 });
    await application.lifecycle.initialize();
    const address = application.server.server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Synthetic shutdown listener did not expose a port");
    }
    const responsePromise = fetch(
      `http://127.0.0.1:${address.port}/api/test/late-ordinary-database`,
      {
        headers: { connection: "close" },
      },
    ).catch(() => undefined);
    await routeEntered.promise;

    vi.useFakeTimers();
    let fakeTimers = true;
    let shutdown: Promise<void>;
    try {
      shutdown = application.shutdown();
      await vi.advanceTimersByTimeAsync(httpServerTuning.ordinaryDrainMilliseconds);
      expect(end).not.toHaveBeenCalled();
      vi.useRealTimers();
      fakeTimers = false;

      releaseRoute.resolve();
      await lateQueryEntered.promise;
      expect(end).not.toHaveBeenCalled();
      releaseLateQuery.resolve();
      await routeFinished.promise;
      await shutdown;
    } finally {
      releaseRoute.resolve();
      releaseLateQuery.resolve();
      if (fakeTimers) {
        vi.useRealTimers();
      }
    }
    await responsePromise;
    expect(query).toHaveBeenCalledWith("select 2");
    expect(end).toHaveBeenCalledOnce();
    expect(application.lifecycle.phase).toBe("stopped");
  });

  it("fails closed when a force-closed ordinary handler misses its cleanup fence", async () => {
    const routeEntered = Promise.withResolvers<void>();
    const releaseRoute = Promise.withResolvers<void>();
    const routeFinished = Promise.withResolvers<void>();
    const end = vi.fn(async () => undefined);
    const pool: DatabasePool = {
      end,
      query: vi.fn(async () => ({ rows: [{ result: 1 }] })),
    };
    const resources = shutdownResourceSpies();
    const application = createApplication(loadConfig({ NODE_ENV: "test" }), {
      emailSender: resources.emailSender,
      pool,
      telemetry: resources.telemetry,
    });
    application.server.get("/api/test/stuck-ordinary-handler", async () => {
      routeEntered.resolve();
      try {
        await releaseRoute.promise;
        return { completed: true };
      } finally {
        routeFinished.resolve();
      }
    });
    await application.server.listen({ host: "127.0.0.1", port: 0 });
    await application.lifecycle.initialize();
    const address = application.server.server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Synthetic shutdown listener did not expose a port");
    }
    const responsePromise = fetch(
      `http://127.0.0.1:${address.port}/api/test/stuck-ordinary-handler`,
      {
        headers: { connection: "close" },
      },
    ).catch(() => undefined);
    await routeEntered.promise;

    vi.useFakeTimers();
    try {
      const shutdown = application.shutdown();
      const rejected = expect(shutdown).rejects.toThrow(
        "Application shutdown could not fence in-flight work",
      );
      await vi.advanceTimersByTimeAsync(httpServerTuning.ordinaryDrainMilliseconds);
      await vi.advanceTimersByTimeAsync(httpServerTuning.shutdownCleanupMilliseconds);
      await rejected;
      expect(end).not.toHaveBeenCalled();
      expect(resources.closeEmail).not.toHaveBeenCalled();
      expect(resources.shutdownTelemetry).not.toHaveBeenCalled();
      expect(application.lifecycle.phase).toBe("draining");
    } finally {
      releaseRoute.resolve();
      vi.useRealTimers();
    }
    await routeFinished.promise;
    await responsePromise;
  });

  it("leaves process-owned resources open when an aborted stream misses the final fence", async () => {
    const end = vi.fn(async () => undefined);
    const pool: DatabasePool = {
      end,
      query: vi.fn(async () => ({ rows: [{ result: 1 }] })),
    };
    const streamRegistry = new ActiveStreamRegistry();
    const stalledLease = streamRegistry.register("00000000-0000-4000-8000-000000000099");
    const resources = shutdownResourceSpies();
    const application = createApplication(loadConfig({ NODE_ENV: "test" }), {
      emailSender: resources.emailSender,
      pool,
      streamRegistry,
      telemetry: resources.telemetry,
    });

    vi.useFakeTimers();
    try {
      const shutdown = application.shutdown();
      const rejected = expect(shutdown).rejects.toThrow(
        "Application shutdown could not fence in-flight work",
      );
      await vi.advanceTimersByTimeAsync(generationTuning.gracefulDrainMilliseconds);
      expect(stalledLease.signal.aborted).toBe(true);
      expect(stalledLease.signal.reason).toBe("shutdown");
      expect(end).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(httpServerTuning.shutdownCleanupMilliseconds);
      await rejected;
      expect(end).not.toHaveBeenCalled();
      expect(resources.closeEmail).not.toHaveBeenCalled();
      expect(resources.shutdownTelemetry).not.toHaveBeenCalled();
      expect(application.lifecycle.phase).toBe("draining");
    } finally {
      stalledLease.release();
      vi.useRealTimers();
    }
  });

  it("bounds a partial ordinary request without shortening the stream drain", async () => {
    const pool: DatabasePool = {
      end: vi.fn(async () => undefined),
      query: vi.fn(async () => ({ rows: [{ result: 1 }] })),
    };
    const streamRegistry = new ActiveStreamRegistry();
    const activeStream = streamRegistry.register("00000000-0000-4000-8000-000000000001");
    const application = createApplication(loadConfig({ NODE_ENV: "test" }), {
      pool,
      streamRegistry,
    });
    const partialRequestEntered = Promise.withResolvers<void>();
    application.server.post(
      "/api/test/partial-request",
      {
        onRequest: (_request, _reply, done) => {
          partialRequestEntered.resolve();
          done();
        },
      },
      async () => ({ unexpected: true }),
    );
    expect(application.server.server.requestTimeout).toBe(15_000);
    await application.server.listen({ host: "127.0.0.1", port: 0 });
    await application.lifecycle.initialize();
    const address = application.server.server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Synthetic shutdown listener did not expose a port");
    }

    const socket = createConnection({ host: "127.0.0.1", port: address.port });
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    socket.write(
      [
        "POST /api/test/partial-request HTTP/1.1",
        `Host: 127.0.0.1:${address.port}`,
        "Content-Type: application/json",
        "Content-Length: 100",
        "Connection: keep-alive",
        "",
        "{",
      ].join("\r\n"),
    );
    await partialRequestEntered.promise;

    const socketClosed = new Promise<void>((resolve) => socket.once("close", resolve));
    vi.useFakeTimers();
    let fakeTimers = true;
    let shutdown: Promise<void>;
    try {
      shutdown = application.shutdown();
      await vi.advanceTimersByTimeAsync(httpServerTuning.ordinaryDrainMilliseconds);
      expect(activeStream.signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(generationTuning.gracefulDrainMilliseconds - 1);
      expect(activeStream.signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(activeStream.signal.aborted).toBe(true);
      vi.useRealTimers();
      fakeTimers = false;
      await socketClosed;
      activeStream.release();
    } finally {
      activeStream.release();
      if (fakeTimers) {
        vi.useRealTimers();
      }
    }
    await expect(shutdown).resolves.toBeUndefined();
    expect(application.lifecycle.phase).toBe("stopped");
    expect(pool.end).toHaveBeenCalledOnce();
  });

  it("stops HTTP and closes the database pool once", async () => {
    let maintenanceStopped = false;
    const maintenance: CostControlMaintenance = {
      runOnce: vi.fn(async () => ({
        catalogRefresh: null,
        namingReconciliation: null,
        reconciliation: null,
      })),
      start: vi.fn(),
      stop: vi.fn(async () => {
        maintenanceStopped = true;
      }),
    };
    const end = vi.fn(async () => {
      expect(maintenanceStopped).toBe(true);
    });
    const pool: DatabasePool = {
      end,
      query: vi.fn(async () => ({ rows: [{ result: 1 }] })),
    };
    const application = createApplication(loadConfig({ NODE_ENV: "test" }), {
      maintenance,
      pool,
    });

    await application.server.listen({ host: "127.0.0.1", port: 0 });
    await application.lifecycle.initialize();
    expect(application.server.server.listening).toBe(true);

    await Promise.all([application.shutdown(), application.shutdown()]);

    expect(application.server.server.listening).toBe(false);
    expect(application.lifecycle.phase).toBe("stopped");
    expect(maintenance.stop).toHaveBeenCalledTimes(1);
    expect(maintenanceStopped).toBe(true);
    expect(end).toHaveBeenCalledTimes(1);
  });

  it("drains one HTTP stream and interrupts another before closing its database pool", async () => {
    const completeDuringDrain = Promise.withResolvers<void>();
    const completingGatewayEntered = Promise.withResolvers<void>();
    const completingTerminalized = Promise.withResolvers<void>();
    const stalledGatewayBlocked = Promise.withResolvers<void>();
    const visiblePartial = "Respuesta parcial visible. ".repeat(48);
    let stalledSignal: AbortSignal | undefined;
    const memory = new Map<string, MutableGeneration>([
      [
        completingResponse.generationId,
        {
          content: "",
          firstTokenAt: null,
          state: {
            assistantMessageId: completingResponse.messageId,
            conversationId: completingResponse.conversationId,
            errorCode: null,
            reason: null,
            revision: completingResponse.revision,
            status: "active",
          },
        },
      ],
      [
        stalledResponse.generationId,
        {
          content: "",
          firstTokenAt: null,
          state: {
            assistantMessageId: stalledResponse.messageId,
            conversationId: stalledResponse.conversationId,
            errorCode: null,
            reason: null,
            revision: stalledResponse.revision,
            status: "active",
          },
        },
      ],
    ]);
    const requiredGeneration = (generationId: string): MutableGeneration => {
      const generation = memory.get(generationId);
      if (generation === undefined) {
        throw new Error("Unknown synthetic shutdown generation");
      }
      return generation;
    };
    const generations = {
      checkpoint: async (generationId: string, content: string, firstTokenAt: Date | null) => {
        const generation = requiredGeneration(generationId);
        if (generation.state.status !== "active") {
          return false;
        }
        generation.content = content;
        generation.firstTokenAt ??= firstTokenAt;
        return true;
      },
      readState: async (generationId: string) => ({
        ...requiredGeneration(generationId).state,
      }),
      terminalize: async (
        generationId: string,
        input: Parameters<GenerationService["terminalize"]>[1],
      ) => {
        const generation = requiredGeneration(generationId);
        if (generation.state.status !== "active") {
          return { ...generation.state, won: false };
        }
        generation.content = input.content;
        generation.firstTokenAt ??= input.firstTokenAt;
        generation.state = {
          assistantMessageId: generation.state.assistantMessageId,
          conversationId: generation.state.conversationId,
          errorCode: input.errorCode,
          reason: input.reason,
          revision: (generation.state.revision ?? 0) + 1,
          status: input.status,
        };
        if (generationId === completingResponse.generationId) {
          completingTerminalized.resolve();
        }
        return { ...generation.state, won: true };
      },
    } as unknown as GenerationService;
    const gateway: ModelGateway = {
      async *stream(request, signal) {
        if (request.message.text === completingResponse.request.message.text) {
          completingGatewayEntered.resolve();
          await completeDuringDrain.promise;
          signal.throwIfAborted();
          yield { text: "Respuesta completada durante el drenaje.", type: "content.delta" };
          yield {
            reason: "stop",
            type: "response.completed",
            usage: { inputTokens: 4, outputTokens: 5 },
          };
          return;
        }

        stalledSignal = signal;
        yield { text: visiblePartial, type: "content.delta" };
        stalledGatewayBlocked.resolve();
        signal.throwIfAborted();
        await new Promise<never>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new DOMException("Synthetic stalled stream aborted", "AbortError")),
            { once: true },
          );
        });
      },
    };
    const streamRegistry = new ActiveStreamRegistry();
    const end = vi.fn(async () => {
      expect(streamRegistry.size).toBe(0);
      expect(requiredGeneration(completingResponse.generationId).state.status).toBe("completed");
      expect(requiredGeneration(stalledResponse.generationId).state).toMatchObject({
        errorCode: "STREAM_INTERRUPTED",
        reason: "error",
        status: "incomplete",
      });
    });
    const pool: DatabasePool = {
      end,
      query: vi.fn(async () => ({ rows: [{ result: 1 }] })),
    };
    const application = createApplication(loadConfig({ NODE_ENV: "test" }), {
      generations,
      modelGateway: gateway,
      pool,
      streamRegistry,
    });
    application.server.get("/api/test/shutdown-stream/:kind", async (request, reply) => {
      const { kind } = request.params as { readonly kind: string };
      await application.responseStreams.stream(
        kind === "completing" ? completingResponse : stalledResponse,
        request,
        reply,
      );
    });
    await application.server.listen({ host: "127.0.0.1", port: 0 });
    await application.lifecycle.initialize();
    const address = application.server.server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Synthetic shutdown listener did not expose a port");
    }
    const baseUrl = `http://127.0.0.1:${address.port}/api/test/shutdown-stream`;
    const [completingHttpResponse, stalledHttpResponse] = await Promise.all([
      fetch(`${baseUrl}/completing`, { headers: { connection: "close" } }),
      fetch(`${baseUrl}/stalled`, { headers: { connection: "close" } }),
    ]);
    expect(completingHttpResponse.ok).toBe(true);
    expect(stalledHttpResponse.ok).toBe(true);
    await Promise.all([completingGatewayEntered.promise, stalledGatewayBlocked.promise]);
    expect(streamRegistry.size).toBe(2);
    const completingEventsPromise = streamEvents(completingHttpResponse);
    const stalledEventsPromise = streamEvents(stalledHttpResponse);

    vi.useFakeTimers();
    let shutdown: Promise<void>;
    try {
      shutdown = application.shutdown();
      expect(streamRegistry.isAccepting).toBe(false);
      completeDuringDrain.resolve();
      await completingTerminalized.promise;
      const completingEvents = await completingEventsPromise;
      expect(completingEvents.map((event) => event.type)).toEqual([
        "response.started",
        "content.delta",
        "response.completed",
      ]);
      expect(streamRegistry.size).toBe(1);

      await vi.advanceTimersByTimeAsync(generationTuning.gracefulDrainMilliseconds);
      expect(streamRegistry.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
    await shutdown;
    const stalledEvents = await stalledEventsPromise;
    expect(stalledEvents.map((event) => event.type)).toEqual(["response.started", "content.delta"]);

    const interrupted = requiredGeneration(stalledResponse.generationId);
    expect(stalledSignal?.aborted).toBe(true);
    expect(stalledSignal?.reason).toBe("shutdown");
    expect(interrupted.content).toBe(visiblePartial);
    expect(interrupted.firstTokenAt).toBeInstanceOf(Date);
    expect(interrupted.state).toMatchObject({
      errorCode: "STREAM_INTERRUPTED",
      reason: "error",
      revision: 2,
      status: "incomplete",
    });
    expect(end).toHaveBeenCalledOnce();
  });
});

import { randomUUID } from "node:crypto";
import { TypeBoxValidatorCompiler } from "@fastify/type-provider-typebox";
import Fastify, { LogController } from "fastify";
import type { ApiConfig } from "./config.js";
import { createDatabasePool, type DatabasePool } from "./database/pool.js";
import { registerErrorHandling } from "./errors.js";
import { createApplicationLifecycle } from "./lifecycle.js";
import { registerHealthRoutes } from "./routes/health.js";

export interface ApplicationDependencies {
  readonly pool?: DatabasePool;
  readonly requestIdFactory?: () => string;
}

export function createApplication(config: ApiConfig, dependencies: ApplicationDependencies = {}) {
  const requestIdFactory = dependencies.requestIdFactory ?? randomUUID;
  const server = Fastify({
    genReqId: () => requestIdFactory(),
    logger: {
      level: config.logLevel,
      redact: {
        censor: "[Redacted]",
        paths: ["req.headers.authorization", "req.headers.cookie"],
      },
    },
    logController: new LogController({
      disableRequestLogging: false,
      requestIdLogLabel: "requestId",
    }),
  }).setValidatorCompiler(TypeBoxValidatorCompiler);
  const pool =
    dependencies.pool ??
    createDatabasePool(config.databaseUrl, (error) => {
      server.log.error({ errorName: error.name }, "idle database connection failed");
    });
  const lifecycle = createApplicationLifecycle(pool);

  server.addHook("onSend", (request, reply, payload, done) => {
    void reply.header("x-request-id", request.id);
    done(null, payload);
  });

  registerErrorHandling(server);
  registerHealthRoutes(server, lifecycle);

  let shutdownPromise: Promise<void> | undefined;

  function shutdown(): Promise<void> {
    shutdownPromise ??= (async () => {
      lifecycle.beginDraining();
      let closeError: unknown;

      try {
        await server.close();
      } catch (error: unknown) {
        closeError = error;
      }

      try {
        await pool.end();
      } catch (error: unknown) {
        if (closeError !== undefined) {
          throw new AggregateError([closeError, error], "application shutdown failed");
        }

        throw error;
      } finally {
        lifecycle.markStopped();
      }

      if (closeError !== undefined) {
        throw closeError;
      }
    })();

    return shutdownPromise;
  }

  return {
    lifecycle,
    pool,
    server,
    shutdown,
  } as const;
}

export type ApiApplication = ReturnType<typeof createApplication>;

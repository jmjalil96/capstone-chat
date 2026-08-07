import { randomUUID } from "node:crypto";
import { TypeBoxValidatorCompiler } from "@fastify/type-provider-typebox";
import Fastify, { LogController } from "fastify";
import type { Pool } from "pg";
import { type Authentication, createAuthentication } from "./auth/authentication.js";
import type { ApiConfig } from "./config.js";
import { createCursorCodec } from "./conversations/cursor.js";
import { type ConversationService, createConversationService } from "./conversations/service.js";
import { type AppDatabase, createDatabase } from "./database/database.js";
import { createDatabasePool, type DatabasePool } from "./database/pool.js";
import { registerErrorHandling } from "./errors.js";
import { ActiveStreamRegistry } from "./generations/active-streams.js";
import { FakeModelGateway } from "./generations/fake-model-gateway.js";
import type { ModelGateway } from "./generations/model-gateway.js";
import {
  createResponseStreamCoordinator,
  type ResponseStreamCoordinator,
} from "./generations/response-stream.js";
import { createGenerationService, type GenerationService } from "./generations/service.js";
import { generationTuning } from "./generations/settings.js";
import { createActorResolver } from "./identity/authorization.js";
import { createEmailSender, type EmailSender, FakeEmailSender } from "./identity/email.js";
import { createIdentityService, type IdentityService } from "./identity/service.js";
import { createApplicationLifecycle } from "./lifecycle.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerConversationRoutes } from "./routes/conversations.js";
import { registerDevelopmentMailboxRoute } from "./routes/development-mailbox.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerResponseRoutes } from "./routes/responses.js";
import { registerSessionRoute } from "./routes/session.js";
import { applySecurityHeaders, enforceCapstoneMutationBoundary } from "./security/http.js";

export interface ApplicationDependencies {
  readonly authentication?: Authentication;
  readonly conversations?: ConversationService;
  readonly database?: AppDatabase;
  readonly emailSender?: EmailSender;
  readonly generations?: GenerationService;
  readonly identity?: IdentityService;
  readonly loggerStream?: { write(message: string): void };
  readonly modelGateway?: ModelGateway;
  readonly pool?: DatabasePool;
  readonly requestIdFactory?: () => string;
  readonly responseStreams?: ResponseStreamCoordinator;
  readonly streamRegistry?: ActiveStreamRegistry;
}

export function createApplication(config: ApiConfig, dependencies: ApplicationDependencies = {}) {
  const requestIdFactory = dependencies.requestIdFactory ?? randomUUID;
  const modelGateway = dependencies.modelGateway ?? new FakeModelGateway();
  if (config.nodeEnv === "production" && modelGateway instanceof FakeModelGateway) {
    throw new Error("FakeModelGateway is prohibited in production");
  }
  const server = Fastify({
    bodyLimit: 64 * 1024,
    genReqId: () => requestIdFactory(),
    logger: {
      level: config.logLevel,
      redact: {
        censor: "[Redacted]",
        paths: ["req.headers.authorization", "req.headers.cookie"],
      },
      ...(dependencies.loggerStream === undefined ? {} : { stream: dependencies.loggerStream }),
    },
    logController: new LogController({
      disableRequestLogging: true,
      requestIdLogLabel: "requestId",
    }),
    trustProxy: config.trustProxy,
  }).setValidatorCompiler(TypeBoxValidatorCompiler);
  const pool =
    dependencies.pool ??
    createDatabasePool(config.databaseUrl, (error) => {
      server.log.error({ errorName: error.name }, "idle database connection failed");
    });
  const lifecycle = createApplicationLifecycle(pool);
  const database = dependencies.database ?? createDatabase(pool as Pool);
  const emailSender = dependencies.emailSender ?? createEmailSender(config.emailDelivery);
  const identity = dependencies.identity ?? createIdentityService(database);
  const authentication =
    dependencies.authentication ??
    createAuthentication({
      config,
      database,
      emailSender,
      events: {
        emailDeliveryFailed(purpose, errorName) {
          server.log.warn({ errorName, purpose }, "identity email delivery failed");
        },
        identityHookFailed(hook, errorName) {
          server.log.error({ errorName, hook }, "identity lifecycle hook failed");
        },
      },
      identity,
    });
  const resolveActor = createActorResolver(authentication, identity);
  const conversations =
    dependencies.conversations ??
    createConversationService(database, createCursorCodec(config.authSecret));
  const generations = dependencies.generations ?? createGenerationService(database);
  const streamRegistry = dependencies.streamRegistry ?? new ActiveStreamRegistry();
  const responseStreams =
    dependencies.responseStreams ??
    createResponseStreamCoordinator({
      gateway: modelGateway,
      generations,
      registry: streamRegistry,
    });

  server.addHook("preValidation", (request, _reply, done) => {
    try {
      enforceCapstoneMutationBoundary(request, config);
      done();
    } catch (error: unknown) {
      done(error as Error);
    }
  });

  server.addHook("onSend", (request, reply, payload, done) => {
    void reply.header("x-request-id", request.id);
    if (request.url.startsWith("/api/conversations") || request.url.startsWith("/api/drafts")) {
      void reply.header("cache-control", "no-store");
    }
    applySecurityHeaders(reply);
    done(null, payload);
  });

  server.addHook("onResponse", (request, reply, done) => {
    request.log.info(
      {
        method: request.method,
        responseTime: reply.elapsedTime,
        route: request.routeOptions.url,
        statusCode: reply.statusCode,
      },
      "request completed",
    );
    done();
  });

  registerErrorHandling(server);
  registerHealthRoutes(server, lifecycle);
  registerAuthRoutes(server, { authentication, config });
  registerSessionRoute(server, resolveActor);
  registerConversationRoutes(server, { conversations, resolveActor });
  registerResponseRoutes(server, {
    generations,
    registry: streamRegistry,
    resolveActor,
    streams: responseStreams,
  });
  if (emailSender instanceof FakeEmailSender) {
    registerDevelopmentMailboxRoute(server, config, emailSender);
  }

  let shutdownPromise: Promise<void> | undefined;

  function shutdown(): Promise<void> {
    shutdownPromise ??= (async () => {
      lifecycle.beginDraining();
      streamRegistry.beginDraining();
      let closeError: unknown;
      const closePromise = server.close().catch((error: unknown) => {
        closeError = error;
      });

      if (!(await streamRegistry.waitForIdle(generationTuning.gracefulDrainMilliseconds))) {
        streamRegistry.abortAll("shutdown");
        await streamRegistry.waitForIdle(generationTuning.backpressureTimeoutMilliseconds);
      }
      await closePromise;

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
    authentication,
    conversations,
    database,
    emailSender,
    generations,
    identity,
    lifecycle,
    modelGateway,
    pool,
    responseStreams,
    server,
    shutdown,
    streamRegistry,
  } as const;
}

export type ApiApplication = ReturnType<typeof createApplication>;

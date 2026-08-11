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
import { ApplicationError, registerErrorHandling } from "./errors.js";
import { ActiveStreamRegistry } from "./generations/active-streams.js";
import {
  createGenerationAdministrationService,
  type GenerationAdministrationService,
} from "./generations/administration.js";
import {
  type CompactionService,
  createCompactionService,
} from "./generations/compaction-service.js";
import { FakeModelGateway } from "./generations/fake-model-gateway.js";
import type { ModelGateway } from "./generations/model-gateway.js";
import {
  createResponseStreamCoordinator,
  type ResponseStreamCoordinator,
} from "./generations/response-stream.js";
import { createGenerationService, type GenerationService } from "./generations/service.js";
import { generationTuning } from "./generations/settings.js";
import { OrdinaryRequestDrain } from "./http-request-drain.js";
import {
  createEmployeeAdministrationService,
  type EmployeeAdministrationService,
} from "./identity/administration.js";
import { createActorResolver } from "./identity/authorization.js";
import { createEmailSender, type EmailSender, FakeEmailSender } from "./identity/email.js";
import { createIdentityService, type IdentityService } from "./identity/service.js";
import { createApplicationLifecycle } from "./lifecycle.js";
import { settleWithin } from "./lifecycle-timeout.js";
import { type BudgetService, createBudgetService } from "./model-policy/budget-service.js";
import { refreshClaimedCatalog } from "./model-policy/catalog-refresh.js";
import {
  type CostControlMaintenance,
  type CostControlMaintenanceOptions,
  createCostControlMaintenance,
} from "./model-policy/maintenance.js";
import { createModelPolicyService, type ModelPolicyService } from "./model-policy/service.js";
import { createUsageService, type UsageService } from "./model-policy/usage-service.js";
import { createClientErrorRateLimiter } from "./observability/client-error-rate-limit.js";
import { createApplicationTelemetry } from "./observability/telemetry.js";
import type { ApplicationTelemetry } from "./observability/telemetry-contract.js";
import { OpenRouterCatalogClient } from "./openrouter/catalog-client.js";
import { OpenRouterGateway } from "./openrouter/openrouter-gateway.js";
import { operationalErrorMetadata } from "./operator-error.js";
import { registerAdminEmployeeRoutes } from "./routes/admin.js";
import { registerAdminModelRoutes } from "./routes/admin-models.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerClientErrorRoute } from "./routes/client-errors.js";
import { registerConversationRoutes } from "./routes/conversations.js";
import { registerDevelopmentMailboxRoute } from "./routes/development-mailbox.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerModelTierRoutes } from "./routes/model-tiers.js";
import { registerResponseRoutes } from "./routes/responses.js";
import { registerSessionRoute } from "./routes/session.js";
import {
  captureTrustedClientAddress,
  resolveTrustedClientAddress,
} from "./security/client-address.js";
import {
  applySecurityHeaders,
  enforceCapstoneMutationBoundary,
  httpServerTuning,
} from "./security/http.js";
import { applicationShutdownBudget } from "./shutdown-budget.js";
import {
  createKnownApplicationAssetValidator,
  registerStaticApplication,
} from "./static-application.js";

export interface ApplicationDependencies {
  readonly authentication?: Authentication;
  readonly budget?: BudgetService;
  readonly compactions?: CompactionService;
  readonly conversations?: ConversationService;
  readonly database?: AppDatabase;
  readonly emailSender?: EmailSender;
  readonly employeeAdministration?: EmployeeAdministrationService;
  readonly generationAdministration?: GenerationAdministrationService;
  readonly generations?: GenerationService;
  readonly identity?: IdentityService;
  readonly loggerStream?: { write(message: string): void };
  readonly maintenance?: CostControlMaintenance;
  readonly modelGateway?: ModelGateway;
  readonly modelPolicy?: ModelPolicyService;
  readonly pool?: DatabasePool;
  readonly requestIdFactory?: () => string;
  readonly refreshCatalog?: CostControlMaintenanceOptions["refreshCatalog"];
  readonly responseStreams?: ResponseStreamCoordinator;
  readonly streamRegistry?: ActiveStreamRegistry;
  readonly telemetry?: ApplicationTelemetry;
  readonly usage?: UsageService;
}

export function createApplication(config: ApiConfig, dependencies: ApplicationDependencies = {}) {
  const isKnownApplicationAsset = createKnownApplicationAssetValidator(config.webAssetsDirectory);
  const requestIdFactory = dependencies.requestIdFactory ?? randomUUID;
  const modelGateway =
    dependencies.modelGateway ??
    (config.modelGateway === "openrouter"
      ? new OpenRouterGateway({ apiKey: config.openRouterApiKey ?? "" })
      : new FakeModelGateway());
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
    requestTimeout: httpServerTuning.incomingRequestTimeoutMilliseconds,
    trustProxy: config.trustProxy,
  }).setValidatorCompiler(TypeBoxValidatorCompiler);
  const telemetry =
    dependencies.telemetry ??
    createApplicationTelemetry({
      endpoint: config.otlpEndpoint,
      environment: config.nodeEnv,
      headers: config.otlpHeaders,
      onExporterFailure(metadata) {
        server.log.warn(metadata, "telemetry exporter operation failed");
      },
      release: config.deploymentRevision,
    });
  function observeTelemetry(
    operation: "email-delivery" | "http-request",
    observation: () => void,
  ): void {
    try {
      observation();
    } catch {
      server.log.warn({ operation }, "telemetry instrumentation failed");
    }
  }
  const pool =
    dependencies.pool ??
    createDatabasePool(config.databaseUrl, (error) => {
      server.log.error(operationalErrorMetadata(error), "idle database connection failed");
    });
  const database = dependencies.database ?? createDatabase(pool as Pool);
  const emailSender =
    dependencies.emailSender ??
    createEmailSender(config.emailDelivery, {
      emailFrom: config.emailFrom,
      onDeliveryReport: (report) =>
        observeTelemetry("email-delivery", () => telemetry.recordEmailDelivery(report)),
      resendApiKey: config.resendApiKey,
    });
  if (config.nodeEnv === "production" && emailSender.kind !== "resend") {
    throw new Error("Resend email delivery is required in production");
  }
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
  const cursorCodec = createCursorCodec(config.authSecret);
  const budget = dependencies.budget ?? createBudgetService(database, { telemetry });
  const modelPolicy =
    dependencies.modelPolicy ?? createModelPolicyService(database, { cursorCodec });
  const readinessPolicyMode =
    config.nodeEnv === "production"
      ? "openrouter"
      : config.nodeEnv === "test" && config.webAssetsDirectory !== null
        ? "simulated"
        : null;
  const lifecycle = createApplicationLifecycle(pool, {
    ...(readinessPolicyMode === null
      ? {}
      : {
          onReadyValidationFailure(error: unknown) {
            server.log.warn(
              { ...operationalErrorMetadata(error), operation: "readiness-authority" },
              "application readiness validation failed",
            );
          },
          validateReady: () => modelPolicy.assertRuntimeMode(readinessPolicyMode),
        }),
  });
  const conversations =
    dependencies.conversations ??
    createConversationService(database, cursorCodec, config.modelGateway, modelPolicy);
  const generations =
    dependencies.generations ??
    createGenerationService(database, {
      budget,
      mode: config.modelGateway === "openrouter" ? "openrouter" : "simulated",
      modelPolicy,
      telemetry,
    });
  const compactions =
    dependencies.compactions ??
    createCompactionService({
      budget,
      database,
      gateway: modelGateway,
      mode: config.modelGateway === "openrouter" ? "openrouter" : "simulated",
      telemetry,
    });
  const streamRegistry = dependencies.streamRegistry ?? new ActiveStreamRegistry();
  const employeeAdministration =
    dependencies.employeeAdministration ??
    createEmployeeAdministrationService(database, cursorCodec);
  const generationAdministration =
    dependencies.generationAdministration ??
    createGenerationAdministrationService(database, budget, telemetry);
  const usage = dependencies.usage ?? createUsageService(database, cursorCodec);
  const responseStreams =
    dependencies.responseStreams ??
    createResponseStreamCoordinator({
      compactions,
      gateway: modelGateway,
      generations,
      registry: streamRegistry,
      telemetry,
    });
  const catalogClient =
    config.modelGateway === "openrouter"
      ? new OpenRouterCatalogClient({ apiKey: config.openRouterApiKey ?? "" })
      : undefined;
  const catalogRefreshOwnerId = randomUUID();
  const maintenance =
    dependencies.maintenance ??
    createCostControlMaintenance({
      budget,
      onFailure(metadata) {
        server.log.warn(metadata, "cost-control maintenance failed");
      },
      refreshCatalog:
        dependencies.refreshCatalog ??
        (catalogClient === undefined
          ? async () => Object.freeze({ available: 0, claimed: 0, unavailable: 0, updated: 0 })
          : (signal) =>
              refreshClaimedCatalog({
                loadSnapshots: (modelIds, refreshSignal) =>
                  catalogClient.loadSnapshots(modelIds, refreshSignal),
                modelPolicy,
                ownerId: catalogRefreshOwnerId,
                signal,
              })),
      telemetry,
    });
  const ordinaryRequestDrain = new OrdinaryRequestDrain();

  server.addHook("onRoute", (options) => {
    if (!options.url.startsWith("/api/")) {
      return;
    }
    const handler = options.handler;
    options.handler = async function trackedHandler(request, reply) {
      try {
        return await handler.call(this, request, reply);
      } finally {
        // A destroyed response can bypass onSend even though its handler keeps
        // running, so resource shutdown must fence the handler promise itself.
        ordinaryRequestDrain.completeHandler(request);
      }
    };
  });

  server.addHook("preValidation", (request, _reply, done) => {
    try {
      enforceCapstoneMutationBoundary(request, config);
      done();
    } catch (error: unknown) {
      done(error as Error);
    }
  });

  server.addHook("onRequest", (request, reply, done) => {
    captureTrustedClientAddress(request, config.clientAddressSource);
    applySecurityHeaders(reply, config.nodeEnv);
    if (!ordinaryRequestDrain.track(request, reply)) {
      done(new ApplicationError(503, "INTERNAL_ERROR", "El servicio se está reiniciando."));
      return;
    }
    done();
  });

  server.addHook("onSend", (request, reply, payload, done) => {
    void reply.header("x-request-id", request.id);
    if (request.url === "/api" || request.url.startsWith("/api/")) {
      void reply.header("cache-control", "no-store");
    }
    done(null, payload);
  });

  server.addHook("onResponse", (request, reply, done) => {
    observeTelemetry("http-request", () =>
      telemetry.recordHttpRequest({
        durationMs: reply.elapsedTime,
        method: request.method,
        requestId: request.id,
        route: request.routeOptions.url,
        statusCode: reply.statusCode,
      }),
    );
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

  const tryServeSpaShell =
    config.webAssetsDirectory === null
      ? undefined
      : registerStaticApplication(server, config.webAssetsDirectory);
  registerErrorHandling(server, tryServeSpaShell);
  registerHealthRoutes(server, lifecycle, config.deploymentRevision);
  registerClientErrorRoute(server, {
    isKnownAsset: isKnownApplicationAsset,
    onReport: (report) => telemetry.recordClientError(report.kind, report.route),
    rateLimiter: createClientErrorRateLimiter(database, config.authSecret),
    release: config.deploymentRevision,
    resolveClientAddress: resolveTrustedClientAddress,
  });
  registerAuthRoutes(server, { authentication, config });
  registerSessionRoute(server, resolveActor);
  registerAdminEmployeeRoutes(server, {
    authentication,
    employees: employeeAdministration,
    emailSender,
    generationAdministration,
    identity,
    publicOrigin: config.publicOrigin,
    resolveActor,
    streamRegistry,
    usage,
  });
  registerAdminModelRoutes(server, {
    ...(catalogClient === undefined
      ? {}
      : {
          loadCatalogSnapshots: (modelIds, signal) => catalogClient.loadSnapshots(modelIds, signal),
        }),
    modelGateway: config.modelGateway,
    modelPolicy,
    ownerIdFactory: randomUUID,
    resolveActor,
  });
  registerModelTierRoutes(server, {
    modelGateway: config.modelGateway,
    modelPolicy,
    resolveActor,
  });
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

  const observedPool = pool as DatabasePool & {
    readonly idleCount?: unknown;
    readonly totalCount?: unknown;
    readonly waitingCount?: unknown;
  };
  let stopPoolObservation = (): void => undefined;
  if (
    typeof observedPool.idleCount === "number" &&
    typeof observedPool.totalCount === "number" &&
    typeof observedPool.waitingCount === "number"
  ) {
    try {
      stopPoolObservation = telemetry.startDatabasePoolObservation(() => ({
        idleCount: observedPool.idleCount as number,
        totalCount: observedPool.totalCount as number,
        waitingCount: observedPool.waitingCount as number,
      }));
    } catch {
      server.log.warn({ operation: "database-pool" }, "telemetry instrumentation failed");
    }
  }

  let shutdownPromise: Promise<void> | undefined;

  function shutdown(): Promise<void> {
    shutdownPromise ??= (async () => {
      lifecycle.beginDraining();
      streamRegistry.beginDraining();
      ordinaryRequestDrain.beginDraining();
      const shutdownErrors: unknown[] = [];
      const captureShutdownOperation = (operation: () => Promise<unknown>): Promise<void> =>
        Promise.resolve()
          .then(operation)
          .then(
            () => undefined,
            (error: unknown) => {
              shutdownErrors.push(error);
            },
          );
      const maintenanceStopPromise = captureShutdownOperation(() => maintenance.stop());
      const closePromise = captureShutdownOperation(() => server.close());
      const httpAndMaintenanceSettled = settleWithin(
        Promise.all([closePromise, maintenanceStopPromise]),
        applicationShutdownBudget.httpAndMaintenanceMaximumMilliseconds,
      );

      const ordinaryIdle = await ordinaryRequestDrain.drainAndSeal(
        httpServerTuning.ordinaryDrainMilliseconds,
      );
      // A response request transfers ownership by registering its stream lease
      // before leaving the ordinary-request fence. Once this fence is sealed,
      // a force-closed handler cannot create work behind the stream drain.
      if (!ordinaryIdle) {
        ordinaryRequestDrain.abortAll();
      }

      const ordinaryCleanup = ordinaryIdle
        ? Promise.resolve(true)
        : ordinaryRequestDrain.waitForIdle(httpServerTuning.shutdownCleanupMilliseconds);
      const streamsIdleAfterGrace = await streamRegistry.waitForIdle(
        generationTuning.gracefulDrainMilliseconds,
      );
      if (!streamsIdleAfterGrace) {
        streamRegistry.abortAll("shutdown");
      }
      const [ordinaryCleanupCompleted, streamWorkFenced] = await Promise.all([
        ordinaryCleanup,
        streamsIdleAfterGrace
          ? Promise.resolve(true)
          : streamRegistry.waitForIdle(httpServerTuning.shutdownCleanupMilliseconds),
      ]);
      const resourceFenceFailed =
        (!ordinaryCleanupCompleted && !ordinaryRequestDrain.isIdle) || !streamWorkFenced;
      // Both independently bounded lifetimes have settled. Terminate only
      // residual idle or unparsed sockets before closing process-owned resources.
      server.server.closeAllConnections();
      if (!(await httpAndMaintenanceSettled)) {
        shutdownErrors.push(new Error("HTTP or maintenance shutdown exceeded its deadline"));
      }

      if (resourceFenceFailed) {
        shutdownErrors.push(new Error("Application shutdown could not fence in-flight work"));
        if (shutdownErrors.length === 1) {
          throw shutdownErrors[0];
        }
        throw new AggregateError(shutdownErrors, "application shutdown failed");
      }

      const emailClosePromise = captureShutdownOperation(() => emailSender.close());

      try {
        stopPoolObservation();
      } catch {
        server.log.warn({ operation: "database-pool" }, "telemetry instrumentation failed");
      }
      const poolClosePromise = captureShutdownOperation(() => pool.end());
      const [emailClosed, poolClosed] = await Promise.all([
        settleWithin(emailClosePromise, applicationShutdownBudget.emailShutdownMaximumMilliseconds),
        settleWithin(
          poolClosePromise,
          applicationShutdownBudget.databasePoolShutdownMaximumMilliseconds,
        ),
      ]);
      if (!emailClosed) {
        shutdownErrors.push(new Error("Transactional email shutdown exceeded its deadline"));
      }
      if (!poolClosed) {
        shutdownErrors.push(new Error("Database pool shutdown exceeded its deadline"));
      }

      const telemetryShutdownPromise = captureShutdownOperation(() => telemetry.shutdown());
      const telemetryStopped = await settleWithin(
        telemetryShutdownPromise,
        applicationShutdownBudget.telemetryShutdownMaximumMilliseconds,
      );
      if (!telemetryStopped) {
        shutdownErrors.push(new Error("Telemetry shutdown exceeded its deadline"));
      }
      lifecycle.markStopped();

      if (shutdownErrors.length === 1) {
        throw shutdownErrors[0];
      }
      if (shutdownErrors.length > 1) {
        throw new AggregateError(shutdownErrors, "application shutdown failed");
      }
    })();

    return shutdownPromise;
  }

  return {
    authentication,
    budget,
    compactions,
    conversations,
    database,
    emailSender,
    employeeAdministration,
    generationAdministration,
    generations,
    identity,
    lifecycle,
    maintenance,
    modelGateway,
    modelPolicy,
    pool,
    responseStreams,
    server,
    shutdown,
    streamRegistry,
    telemetry,
    usage,
  } as const;
}

export type ApiApplication = ReturnType<typeof createApplication>;

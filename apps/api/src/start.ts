import { type ApiApplication, type ApplicationDependencies, createApplication } from "./app.js";
import type { ApiConfig } from "./config.js";
import { publicConfigMetadata } from "./config.js";
import { operationalErrorMetadata } from "./operator-error.js";

export async function startServer(
  config: ApiConfig,
  dependencies: ApplicationDependencies = {},
  configure?: ((application: ApiApplication) => void | Promise<void>) | undefined,
): Promise<ApiApplication> {
  const application = createApplication(config, dependencies);

  try {
    await configure?.(application);
    await application.server.listen({ host: config.host, port: config.port });
    const readiness = await application.lifecycle.initialize();
    if (config.nodeEnv === "production" && readiness.status === "ready") {
      await application.modelPolicy.assertRuntimeMode("openrouter");
    }
    application.maintenance.start();

    application.server.log.info(
      { ...publicConfigMetadata(config), readiness: readiness.status },
      "api started",
    );

    if (readiness.status === "unavailable") {
      application.server.log.warn(
        { database: readiness.database },
        "api started without database readiness",
      );
    }

    return application;
  } catch (error: unknown) {
    await application.shutdown().catch(() => undefined);
    throw error;
  }
}

export function installShutdownHandlers(application: ApiApplication): () => void {
  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];
  const handlers = new Map<NodeJS.Signals, () => void>();

  for (const signal of signals) {
    const handler = () => {
      application.server.log.info({ signal }, "shutdown requested");
      void application.shutdown().catch((error: unknown) => {
        application.server.log.error(
          { ...operationalErrorMetadata(error), signal },
          "graceful shutdown failed",
        );
        process.exitCode = 1;
      });
    };

    handlers.set(signal, handler);
    process.once(signal, handler);
  }

  return () => {
    for (const [signal, handler] of handlers) {
      process.removeListener(signal, handler);
    }
  };
}

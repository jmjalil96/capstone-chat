import { loadConfig } from "../config.js";
import { operationalErrorMetadata } from "../operator-error.js";
import { installShutdownHandlers, startServer } from "../start.js";
import { hasExplicitGarbageCollector, registerLoadDiagnostics } from "./diagnostics.js";
import { LoadModelGateway } from "./load-gateway.js";

const confirmation = "--confirm-isolated-local-load";

async function main(): Promise<void> {
  if (process.argv.length !== 3 || process.argv[2] !== confirmation) {
    throw new Error(`The local load server requires ${confirmation}`);
  }
  if (!hasExplicitGarbageCollector()) {
    throw new Error("The local load server requires explicit garbage collection");
  }
  const config = loadConfig();
  if (
    config.applicationEnvironment !== "development" ||
    config.nodeEnv !== "test" ||
    config.modelGateway !== "openrouter" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(new URL(config.publicOrigin).hostname)
  ) {
    throw new Error("The local load server requires test mode and an isolated loopback origin");
  }

  const application = await startServer(
    config,
    {
      modelGateway: new LoadModelGateway(),
      refreshCatalog: async () =>
        Object.freeze({ available: 0, claimed: 0, unavailable: 0, updated: 0 }),
    },
    (configuredApplication) => {
      registerLoadDiagnostics(
        configuredApplication.server,
        configuredApplication.pool,
        configuredApplication.streamRegistry,
        config.authSecret,
      );
    },
  );
  installShutdownHandlers(application);
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${JSON.stringify({ ...operationalErrorMetadata(error), outcome: "local-load-start-failed" })}\n`,
  );
  process.exitCode = 1;
});

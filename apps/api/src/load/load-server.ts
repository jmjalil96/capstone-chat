import { loadConfig } from "../config.js";
import { operationalErrorMetadata } from "../operator-error.js";
import { installShutdownHandlers, startServer } from "../start.js";
import { hasExplicitGarbageCollector, registerLoadDiagnostics } from "./diagnostics.js";
import { LoadModelGateway } from "./load-gateway.js";

const confirmation = "--confirm-isolated-load-rehearsal";
async function main(): Promise<void> {
  if (process.argv.length !== 3 || process.argv[2] !== confirmation) {
    throw new Error(`The load rehearsal server requires ${confirmation}`);
  }
  if (!hasExplicitGarbageCollector()) {
    throw new Error("The load rehearsal server requires explicit garbage collection");
  }
  const config = loadConfig();
  if (
    config.nodeEnv !== "test" ||
    config.modelGateway !== "openrouter" ||
    config.publicOrigin === "https://chat.capstone.com.ec"
  ) {
    throw new Error(
      "The load rehearsal server requires test mode, isolated inference, and a non-production origin",
    );
  }
  const diagnosticsSecret =
    config.deploymentProfile === "managed-rehearsal"
      ? config.loadDiagnosticsSecret
      : config.authSecret;
  if (
    diagnosticsSecret === null ||
    diagnosticsSecret === undefined ||
    diagnosticsSecret.length < 32
  ) {
    throw new Error("The load rehearsal server requires a bounded diagnostics secret");
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
        diagnosticsSecret,
      );
    },
  );
  installShutdownHandlers(application);
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${JSON.stringify({ ...operationalErrorMetadata(error), outcome: "load-rehearsal-start-failed" })}\n`,
  );
  process.exitCode = 1;
});

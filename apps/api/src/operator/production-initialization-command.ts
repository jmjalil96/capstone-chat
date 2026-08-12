import { loadInitializationOperatorConfig } from "../config.js";
import { operationalErrorMetadata } from "../operator-error.js";
import { parseProductionInitializationDocument } from "./initialization-document.js";
import { initializeProduction } from "./production-initialization.js";

async function run(): Promise<void> {
  const config = loadInitializationOperatorConfig();
  const document = parseProductionInitializationDocument(config.initializationDocument);
  const result = await initializeProduction({
    applicationDatabaseUrl: config.applicationDatabaseUrl,
    document,
    migrationDatabaseUrl: config.migrationDatabaseUrl,
    openRouterApiKey: config.openRouterApiKey,
  });
  process.stdout.write(
    `${JSON.stringify({ command: "initialize", outcome: result.outcome, phase: result.phase, schemaVersion: document.schemaVersion })}\n`,
  );
}

run().catch((error: unknown) => {
  process.stderr.write(
    `${JSON.stringify({ ...operationalErrorMetadata(error), outcome: "failed" })}\n`,
  );
  process.exitCode = 1;
});

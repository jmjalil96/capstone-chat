import { loadManagedRehearsalInitializationConfig } from "../config.js";
import { parseManagedRehearsalInitializationDocument } from "../load/managed-rehearsal.js";
import { operationalErrorMetadata } from "../operator-error.js";
import { initializeManagedRehearsal } from "./production-initialization.js";

async function run(): Promise<void> {
  const config = loadManagedRehearsalInitializationConfig();
  const document = parseManagedRehearsalInitializationDocument(config.initializationDocument);
  const result = await initializeManagedRehearsal({
    applicationDatabaseUrl: config.applicationDatabaseUrl,
    document,
    migrationDatabaseUrl: config.migrationDatabaseUrl,
  });
  process.stdout.write(
    `${JSON.stringify({
      command: "initialize-rehearsal",
      documentSha256: document.documentSha256,
      outcome: result.outcome,
      phase: result.phase,
      schemaVersion: document.schemaVersion,
    })}\n`,
  );
}

run().catch((error: unknown) => {
  process.stderr.write(
    `${JSON.stringify({ ...operationalErrorMetadata(error), outcome: "failed" })}\n`,
  );
  process.exitCode = 1;
});

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../config.js";
import { createDatabase } from "../database/database.js";
import { productionInitialization } from "../database/initialization-schema.js";
import { migrateDatabase } from "../database/migrate.js";
import { createDatabasePool } from "../database/pool.js";
import { createModelPolicyService } from "../model-policy/service.js";
import { operationalErrorMetadata } from "../operator-error.js";
import {
  assertLocalDevelopmentDatabaseUrl,
  createDevelopmentInitializationDocument,
  developmentAdministratorEmail,
} from "./development-initialization.js";
import { initializeProduction } from "./production-initialization.js";

const privacyAttestationPath = fileURLToPath(
  new URL("../../../../.env.openrouter-privacy.json", import.meta.url),
);
const maximumPrivacyAttestationBytes = 20 * 1_024;

async function initializedDatabaseIsValid(databaseUrl: string): Promise<boolean> {
  const pool = createDatabasePool(databaseUrl);
  try {
    const database = createDatabase(pool);
    const rows = await database
      .select({ phase: productionInitialization.phase })
      .from(productionInitialization)
      .limit(1);
    if (rows[0]?.phase !== "complete") {
      return false;
    }
    await createModelPolicyService(database).assertRuntimeMode("openrouter");
    return true;
  } finally {
    await pool.end();
  }
}

async function readPrivacyAttestation(): Promise<string> {
  const contents = await readFile(privacyAttestationPath, "utf8");
  if (Buffer.byteLength(contents, "utf8") > maximumPrivacyAttestationBytes) {
    throw new Error("Local OpenRouter privacy attestation exceeds its byte limit");
  }
  return contents;
}

async function run(): Promise<void> {
  const config = loadConfig();
  if (config.nodeEnv !== "development") {
    throw new Error("Development initialization requires NODE_ENV=development");
  }
  if (config.modelGateway !== "openrouter" || config.openRouterApiKey === null) {
    throw new Error("Development initialization requires live OpenRouter configuration");
  }
  assertLocalDevelopmentDatabaseUrl(config.databaseUrl);

  await migrateDatabase(config.databaseUrl);
  if (await initializedDatabaseIsValid(config.databaseUrl)) {
    process.stdout.write(
      `${JSON.stringify({
        administratorEmail: developmentAdministratorEmail,
        command: "initialize-development",
        outcome: "already-complete",
        phase: "complete",
        schemaVersion: 2,
      })}\n`,
    );
    return;
  }

  const document = createDevelopmentInitializationDocument(await readPrivacyAttestation());
  const result = await initializeProduction(
    {
      applicationDatabaseUrl: config.databaseUrl,
      document,
      migrationDatabaseUrl: config.databaseUrl,
      openRouterApiKey: config.openRouterApiKey,
    },
    { migrate: async () => undefined },
  );
  process.stdout.write(
    `${JSON.stringify({
      administratorEmail: developmentAdministratorEmail,
      command: "initialize-development",
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

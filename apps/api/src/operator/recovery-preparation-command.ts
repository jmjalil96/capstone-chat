import { loadRecoveryPreparationOperatorConfig } from "../config.js";
import { createDatabasePool, createMigrationPool } from "../database/pool.js";
import {
  assertProductionDatabaseCredentialBoundary,
  prepareRestoredDatabase,
  RecoveryPreparationError,
  toRecoveryPreparationCommandEvidence,
} from "../database/recovery-preparation.js";
import { operationalErrorMetadata } from "../operator-error.js";
import { readSecretEnvironmentFile } from "../secret-environment.js";
import {
  parseOperatorArguments,
  rejectUnknownOperatorArguments,
  requiredOperatorArgument,
} from "./arguments.js";

async function run(): Promise<void> {
  const argumentsMap = parseOperatorArguments(process.argv.slice(2));
  rejectUnknownOperatorArguments(argumentsMap, new Set(["--application-secret-file"]));
  const applicationSecrets = readSecretEnvironmentFile(
    requiredOperatorArgument(argumentsMap, "--application-secret-file"),
  );
  const applicationDatabaseUrl = applicationSecrets.DATABASE_URL;
  if (
    applicationDatabaseUrl === undefined ||
    Object.keys(applicationSecrets).some((key) => key !== "DATABASE_URL")
  ) {
    throw new RecoveryPreparationError(
      "Application secret file must contain only its database URL",
    );
  }
  const operatorConfig = loadRecoveryPreparationOperatorConfig();
  const migrationSecretPath = operatorConfig.migrationSecretFilePath;
  const migrationSecrets = readSecretEnvironmentFile(migrationSecretPath);
  if (
    migrationSecrets.DATABASE_URL === undefined ||
    Object.keys(migrationSecrets).some((key) => key !== "DATABASE_URL")
  ) {
    throw new RecoveryPreparationError("Migration secret file must contain only its database URL");
  }
  const migrationDatabaseUrl = operatorConfig.databaseUrl;
  assertProductionDatabaseCredentialBoundary(migrationDatabaseUrl, applicationDatabaseUrl);

  const migrationPool = createMigrationPool(migrationDatabaseUrl);
  const applicationPool = createDatabasePool(applicationDatabaseUrl);
  try {
    const evidence = await prepareRestoredDatabase(migrationPool, applicationPool, {
      requireTls: true,
    });
    process.stdout.write(`${JSON.stringify(toRecoveryPreparationCommandEvidence(evidence))}\n`);
  } finally {
    await Promise.all([applicationPool.end(), migrationPool.end()]);
  }
}

run().catch((error: unknown) => {
  process.stderr.write(
    `${JSON.stringify({ ...operationalErrorMetadata(error), outcome: "failed" })}\n`,
  );
  process.exitCode = 1;
});

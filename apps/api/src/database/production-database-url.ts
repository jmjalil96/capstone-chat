import { isIP } from "node:net";
import { recoveryPreparationFailed } from "./recovery-error.js";

export function parseProductionDatabaseUrl(value: string): URL | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    (url.protocol !== "postgres:" && url.protocol !== "postgresql:") ||
    url.username.length === 0 ||
    url.password.length === 0 ||
    url.hostname.length === 0 ||
    isIP(url.hostname) !== 0 ||
    (url.port !== "" && url.port !== "5432") ||
    url.pathname.length <= 1 ||
    url.hash !== "" ||
    [...url.searchParams.keys()].some((key) => key !== "sslmode") ||
    url.searchParams.getAll("sslmode").length !== 1 ||
    url.searchParams.get("sslmode") !== "verify-full" ||
    url.searchParams.has("sslrootcert") ||
    url.searchParams.has("options")
  ) {
    return null;
  }
  return url;
}

function productionDatabaseUrl(value: string): URL {
  const url = parseProductionDatabaseUrl(value);
  if (url === null) {
    recoveryPreparationFailed(
      "Production database URL does not satisfy the direct verify-full contract",
    );
  }
  return url;
}

function decodedCredential(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    recoveryPreparationFailed("Production database credential encoding is invalid");
  }
}

export function assertProductionDatabaseCredentialBoundary(
  migrationDatabaseUrl: string,
  applicationDatabaseUrl: string,
): void {
  const migration = productionDatabaseUrl(migrationDatabaseUrl);
  const application = productionDatabaseUrl(applicationDatabaseUrl);
  const migrationPort = migration.port || "5432";
  const applicationPort = application.port || "5432";
  if (
    migration.hostname !== application.hostname ||
    migrationPort !== applicationPort ||
    migration.pathname !== application.pathname
  ) {
    recoveryPreparationFailed(
      "Application and migration credentials must target the same database",
    );
  }
  if (
    decodedCredential(migration.username) === decodedCredential(application.username) ||
    decodedCredential(migration.password) === decodedCredential(application.password) ||
    migration.href === application.href
  ) {
    recoveryPreparationFailed("Application and migration credentials must be distinct");
  }
}

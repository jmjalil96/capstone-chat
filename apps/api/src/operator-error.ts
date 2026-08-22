import { ConfigurationError } from "./config.js";

type ErrorRecord = Readonly<Record<string, unknown>>;

const databaseMetadataFields = [
  ["code", "errorCode"],
  ["severity", "databaseSeverity"],
  ["schema", "databaseSchema"],
  ["table", "databaseTable"],
  ["column", "databaseColumn"],
  ["constraint", "databaseConstraint"],
  ["routine", "databaseRoutine"],
] as const;

function asRecord(value: unknown): ErrorRecord | undefined {
  return typeof value === "object" && value !== null ? (value as ErrorRecord) : undefined;
}

/** Safe metadata for process-level operator logs, never for request or provider payloads. */
export function operationalErrorMetadata(error: unknown): Readonly<Record<string, string>> {
  const metadata: Record<string, string> = {
    errorName: error instanceof Error ? error.name : "UnknownError",
  };

  let current: unknown = error;
  for (let depth = 0; depth < 3; depth += 1) {
    if (current instanceof ConfigurationError) {
      metadata.configurationKey = current.configurationKey;
    }

    const record = asRecord(current);
    if (record === undefined) {
      break;
    }

    const operationalCode = record.operationalCode;
    if (
      metadata.operationalCode === undefined &&
      typeof operationalCode === "string" &&
      /^[a-z][a-z0-9-]{0,63}$/u.test(operationalCode)
    ) {
      metadata.operationalCode = operationalCode;
    }

    const migrationObjectCount = record.migrationObjectCount;
    const migrationObjectKind = record.migrationObjectKind;
    const migrationObjectName = record.migrationObjectName;
    if (
      metadata.migrationObjectKind === undefined &&
      typeof migrationObjectKind === "string" &&
      /^(?:constraint|function|index|table)$/u.test(migrationObjectKind) &&
      typeof migrationObjectName === "string" &&
      /^[a-z0-9_]{1,128}$/u.test(migrationObjectName) &&
      typeof migrationObjectCount === "number" &&
      Number.isSafeInteger(migrationObjectCount) &&
      migrationObjectCount > 0
    ) {
      metadata.migrationObjectCount = String(migrationObjectCount);
      metadata.migrationObjectKind = migrationObjectKind;
      metadata.migrationObjectName = migrationObjectName;
    }

    for (const [source, target] of databaseMetadataFields) {
      const value = record[source];
      if (metadata[target] === undefined && typeof value === "string" && value.length <= 128) {
        metadata[target] = value;
      }
    }

    current = record.cause;
  }

  return metadata;
}

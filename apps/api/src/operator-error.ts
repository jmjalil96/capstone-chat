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

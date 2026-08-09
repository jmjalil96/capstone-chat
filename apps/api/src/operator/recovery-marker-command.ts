import { loadDatabaseConfig } from "../config.js";
import { createDatabase } from "../database/database.js";
import { createDatabasePool } from "../database/pool.js";
import {
  createRecoveryMarkerService,
  type RecoveryMarkerKind,
} from "../operations/recovery-markers.js";
import {
  parseOperatorArguments,
  rejectUnknownOperatorArguments,
  requiredOperatorArgument,
} from "./arguments.js";

type Command = "create" | "delete" | "list";

function markerKind(value: string): RecoveryMarkerKind {
  if (value !== "pre" && value !== "post") {
    throw new Error("--kind must be pre or post");
  }
  return value;
}

function markerId(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) {
    throw new Error("--id must be a UUID");
  }
  return value;
}

async function run(): Promise<void> {
  const command = process.argv[2] as Command | undefined;
  if (command !== "create" && command !== "delete" && command !== "list") {
    throw new Error("Command must be create, list, or delete");
  }

  const argumentsMap = parseOperatorArguments(process.argv.slice(3));
  const config = loadDatabaseConfig();
  const pool = createDatabasePool(config.databaseUrl);
  const markers = createRecoveryMarkerService(createDatabase(pool));

  try {
    if (command === "create") {
      rejectUnknownOperatorArguments(argumentsMap, new Set(["--kind"]));
      const marker = await markers.create(
        markerKind(requiredOperatorArgument(argumentsMap, "--kind")),
      );
      process.stdout.write(
        `${JSON.stringify({ command, createdAt: marker.createdAt.toISOString(), id: marker.id, kind: marker.kind })}\n`,
      );
      return;
    }

    if (command === "delete") {
      rejectUnknownOperatorArguments(argumentsMap, new Set(["--id"]));
      const id = markerId(requiredOperatorArgument(argumentsMap, "--id"));
      process.stdout.write(
        `${JSON.stringify({ command, deleted: await markers.delete(id), id })}\n`,
      );
      return;
    }

    rejectUnknownOperatorArguments(argumentsMap, new Set());
    const markerList = await markers.list();
    process.stdout.write(
      `${JSON.stringify({
        command,
        markers: markerList.map((marker) => ({
          createdAt: marker.createdAt.toISOString(),
          id: marker.id,
          kind: marker.kind,
        })),
      })}\n`,
    );
  } finally {
    await pool.end();
  }
}

run().catch((error: unknown) => {
  process.stderr.write(
    `${JSON.stringify({ errorName: error instanceof Error ? error.name : "UnknownError", outcome: "failed" })}\n`,
  );
  process.exitCode = 1;
});

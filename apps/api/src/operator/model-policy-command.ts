import { randomUUID } from "node:crypto";
import { loadDatabaseConfig, loadOpenRouterOperatorConfig } from "../config.js";
import { createDatabase } from "../database/database.js";
import { createDatabasePool } from "../database/pool.js";
import { refreshClaimedCatalog } from "../model-policy/catalog-refresh.js";
import { createModelPolicyService } from "../model-policy/service.js";
import { OpenRouterCatalogClient } from "../openrouter/catalog-client.js";
import { operationalErrorMetadata } from "../operator-error.js";
import {
  parseOperatorArguments,
  rejectUnknownOperatorArguments,
  requiredOperatorArgument,
} from "./arguments.js";
import { parsePrivacyAttestationDocument } from "./model-policy-input.js";
import { readBoundedStdinDocument } from "./stdin-document.js";

type Command = "attest" | "refresh";

const attestationArguments = new Set(["--privacy-attestation", "--workspace"]);

async function jsonDocument(source: string): Promise<unknown> {
  if (source !== "-") {
    throw new Error("--privacy-attestation must be read from standard input with -");
  }
  return JSON.parse(await readBoundedStdinDocument()) as unknown;
}

async function run(): Promise<void> {
  const command = process.argv[2] as Command | undefined;
  if (command !== "attest" && command !== "refresh") {
    throw new Error("Command must be attest or refresh");
  }
  const argumentsMap = parseOperatorArguments(process.argv.slice(3));
  rejectUnknownOperatorArguments(
    argumentsMap,
    command === "attest" ? attestationArguments : new Set(),
  );
  const config = loadDatabaseConfig();
  const pool = createDatabasePool(config.databaseUrl);
  const service = createModelPolicyService(createDatabase(pool));

  try {
    if (command === "attest") {
      const workspaceIdentity = requiredOperatorArgument(argumentsMap, "--workspace");
      const attestation = parsePrivacyAttestationDocument(
        await jsonDocument(requiredOperatorArgument(argumentsMap, "--privacy-attestation")),
      );
      const result = await service.attestPrivacy(workspaceIdentity, attestation);
      process.stdout.write(
        `${JSON.stringify({ command, repeated: result.repeated, workspace: workspaceIdentity })}\n`,
      );
      return;
    }

    const client = new OpenRouterCatalogClient({
      apiKey: loadOpenRouterOperatorConfig().apiKey,
    });
    const result = await refreshClaimedCatalog({
      force: true,
      loadSnapshots: (modelIds, signal) => client.loadSnapshots(modelIds, signal),
      modelPolicy: service,
      ownerId: randomUUID(),
      signal: new AbortController().signal,
    });
    process.stdout.write(`${JSON.stringify({ command, ...result })}\n`);
  } finally {
    await pool.end();
  }
}

run().catch((error: unknown) => {
  process.stderr.write(
    `${JSON.stringify({ ...operationalErrorMetadata(error), outcome: "failed" })}\n`,
  );
  process.exitCode = 1;
});

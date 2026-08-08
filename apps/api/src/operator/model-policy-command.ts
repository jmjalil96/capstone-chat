import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { loadDatabaseConfig, loadOpenRouterOperatorConfig } from "../config.js";
import { createDatabase } from "../database/database.js";
import { createDatabasePool } from "../database/pool.js";
import {
  buildSimulatedCatalogSnapshot,
  type CatalogModelSnapshot,
  initialTierModels,
  type ModelTier,
  modelTiers,
} from "../model-policy/catalog.js";
import { refreshClaimedCatalog } from "../model-policy/catalog-refresh.js";
import { canonicalUsd } from "../model-policy/money.js";
import { createModelPolicyService } from "../model-policy/service.js";
import { OpenRouterCatalogClient } from "../openrouter/catalog-client.js";
import { operationalErrorMetadata } from "../operator-error.js";
import {
  parseOperatorArguments,
  rejectUnknownOperatorArguments,
  requiredOperatorArgument,
} from "./arguments.js";
import { parsePrivacyAttestationDocument } from "./model-policy-input.js";

type Command = "attest" | "bootstrap" | "refresh";

const bootstrapArguments = new Set([
  "--balanced-max-output",
  "--employee-generation-limit",
  "--fast-max-output",
  "--mode",
  "--monthly-budget-usd",
  "--privacy-attestation",
  "--pro-max-output",
  "--reservation-margin-bps",
  "--workspace",
]);
const attestationArguments = new Set(["--privacy-attestation", "--workspace"]);

function integerArgument(
  argumentsMap: ReadonlyMap<string, string>,
  name: string,
  minimum: number,
  maximum: number,
): number {
  const raw = requiredOperatorArgument(argumentsMap, name);
  if (!/^\d+$/u.test(raw)) {
    throw new Error(`${name} must be an integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be from ${minimum} to ${maximum}`);
  }
  return value;
}

async function jsonDocument(filePath: string): Promise<unknown> {
  const contents = await readFile(filePath, "utf8");
  return JSON.parse(contents) as unknown;
}

function outputLimits(
  argumentsMap: ReadonlyMap<string, string>,
): Readonly<Record<ModelTier, number>> {
  return Object.freeze({
    balanced: integerArgument(argumentsMap, "--balanced-max-output", 1, 2_147_483_647),
    fast: integerArgument(argumentsMap, "--fast-max-output", 1, 2_147_483_647),
    pro: integerArgument(argumentsMap, "--pro-max-output", 1, 2_147_483_647),
  });
}

async function loadRealCatalog(): Promise<Readonly<Record<ModelTier, CatalogModelSnapshot>>> {
  const client = new OpenRouterCatalogClient({
    apiKey: loadOpenRouterOperatorConfig().apiKey,
  });
  const snapshots = await client.loadSnapshots(
    modelTiers.map((tier) => initialTierModels[tier]),
    new AbortController().signal,
  );
  const byModel = new Map(snapshots.map((snapshot) => [snapshot.modelId, snapshot]));
  const catalog = {} as Record<ModelTier, CatalogModelSnapshot>;
  for (const tier of modelTiers) {
    const snapshot = byModel.get(initialTierModels[tier]);
    if (snapshot === undefined) {
      throw new Error(`The approved ${tier} model has no eligible OpenRouter route`);
    }
    catalog[tier] = snapshot;
  }
  return Object.freeze(catalog);
}

async function run(): Promise<void> {
  const command = process.argv[2] as Command | undefined;
  if (command !== "attest" && command !== "bootstrap" && command !== "refresh") {
    throw new Error("Command must be attest, bootstrap, or refresh");
  }
  const argumentsMap = parseOperatorArguments(process.argv.slice(3));
  rejectUnknownOperatorArguments(
    argumentsMap,
    command === "bootstrap"
      ? bootstrapArguments
      : command === "attest"
        ? attestationArguments
        : new Set(),
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

    if (command === "bootstrap") {
      const mode = requiredOperatorArgument(argumentsMap, "--mode");
      if (mode !== "simulated" && mode !== "openrouter") {
        throw new Error("--mode must be simulated or openrouter");
      }
      if (mode === "simulated" && argumentsMap.has("--privacy-attestation")) {
        throw new Error("--privacy-attestation is supported only in openrouter mode");
      }
      const limits = outputLimits(argumentsMap);
      const employeeActiveGenerationLimit = integerArgument(
        argumentsMap,
        "--employee-generation-limit",
        1,
        2_147_483_647,
      );
      const monthlyBudgetUsd = canonicalUsd(
        requiredOperatorArgument(argumentsMap, "--monthly-budget-usd"),
        "monthly workspace budget",
      );
      const reservationMarginBasisPoints = integerArgument(
        argumentsMap,
        "--reservation-margin-bps",
        0,
        1_000_000,
      );
      const workspaceIdentity = requiredOperatorArgument(argumentsMap, "--workspace");
      const privacyAttestation =
        mode === "simulated"
          ? null
          : parsePrivacyAttestationDocument(
              await jsonDocument(requiredOperatorArgument(argumentsMap, "--privacy-attestation")),
            );
      const catalog =
        mode === "simulated"
          ? Object.freeze(
              Object.fromEntries(
                modelTiers.map((tier) => [
                  tier,
                  buildSimulatedCatalogSnapshot(initialTierModels[tier], limits[tier], new Date()),
                ]),
              ) as Record<ModelTier, ReturnType<typeof buildSimulatedCatalogSnapshot>>,
            )
          : await loadRealCatalog();
      const result = await service.bootstrap({
        catalog,
        employeeActiveGenerationLimit,
        maximumOutputTokens: limits,
        mode,
        monthlyBudgetUsd,
        privacyAttestation,
        reservationMarginBasisPoints,
        workspaceIdentity,
      });
      process.stdout.write(
        `${JSON.stringify({ command, mode, repeated: result.repeated, workspace: workspaceIdentity })}\n`,
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

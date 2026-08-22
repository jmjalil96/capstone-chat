import { randomUUID } from "node:crypto";
import { loadDatabaseConfig, loadOpenRouterOperatorConfig } from "../config.js";
import { createDatabase } from "../database/database.js";
import { createDatabasePool } from "../database/pool.js";
import {
  buildSimulatedCatalogSnapshot,
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
import { loadApprovedOpenRouterCatalog } from "./openrouter-bootstrap-catalog.js";
import { readBoundedStdinDocument } from "./stdin-document.js";

type Command = "attest" | "bootstrap" | "refresh" | "verify";

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
const verificationArguments = new Set(["--mode"]);

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

async function jsonDocument(source: string): Promise<unknown> {
  if (source !== "-") {
    throw new Error("--privacy-attestation must be read from standard input with -");
  }
  return JSON.parse(await readBoundedStdinDocument()) as unknown;
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

async function run(): Promise<void> {
  const command = process.argv[2] as Command | undefined;
  if (
    command !== "attest" &&
    command !== "bootstrap" &&
    command !== "refresh" &&
    command !== "verify"
  ) {
    throw new Error("Command must be attest, bootstrap, refresh, or verify");
  }
  const argumentsMap = parseOperatorArguments(process.argv.slice(3));
  rejectUnknownOperatorArguments(
    argumentsMap,
    command === "bootstrap"
      ? bootstrapArguments
      : command === "attest"
        ? attestationArguments
        : command === "verify"
          ? verificationArguments
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
          : await loadApprovedOpenRouterCatalog(loadOpenRouterOperatorConfig().apiKey);
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

    if (command === "verify") {
      const mode = requiredOperatorArgument(argumentsMap, "--mode");
      if (mode !== "simulated" && mode !== "openrouter") {
        throw new Error("--mode must be simulated or openrouter");
      }
      await service.assertRuntimeMode(mode);
      process.stdout.write(`${JSON.stringify({ command, mode, outcome: "compatible" })}\n`);
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

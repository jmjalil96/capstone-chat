import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDatabase } from "../src/database/database.js";
import { workspaces } from "../src/database/identity-schema.js";
import { migrateDatabase } from "../src/database/migrate.js";
import {
  modelCatalog,
  openRouterPrivacyAttestations,
  workspaceCostPolicies,
  workspaceModelPolicies,
} from "../src/database/model-policy-schema.js";
import {
  type CatalogModelSnapshot,
  initialTierModels,
  type ModelTier,
  modelTiers,
  verifyPrivacyAttestation,
} from "../src/model-policy/catalog.js";
import { createModelPolicyService } from "../src/model-policy/service.js";
import { testCatalogCapability } from "./support/generation.js";
import { bootstrapSimulatedModelPolicy } from "./support/model-policy.js";

const apiRoot = fileURLToPath(new URL("..", import.meta.url));
const operatorExecutable = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));
const operatorScript = fileURLToPath(
  new URL("../src/operator/model-policy-command.ts", import.meta.url),
);
const providerAccessMarker = "CAPSTONE_TEST_PROVIDER_ACCESS_FORBIDDEN";
const fetchGuardSource = `globalThis.fetch=async()=>{process.stderr.write(${JSON.stringify(
  providerAccessMarker,
)});throw new Error("Provider access is forbidden in this test")}`;
const fetchGuardNodeOption = `--import=data:text/javascript,${encodeURIComponent(fetchGuardSource)}`;

const simulatedBootstrapArguments = [
  "bootstrap",
  "--workspace",
  "capstone-ecuador",
  "--mode",
  "simulated",
  "--monthly-budget-usd",
  "100",
  "--fast-max-output",
  "1",
  "--balanced-max-output",
  "2",
  "--pro-max-output",
  "3",
  "--employee-generation-limit",
  "2",
  "--reservation-margin-bps",
  "2000",
] as const;

interface OperatorResult {
  readonly code: number;
  readonly stderr: string;
  readonly stdout: string;
}

function parseOperatorOutput(output: string): Record<string, unknown> {
  const lines = output
    .trim()
    .split("\n")
    .filter((line) => line.length > 0);
  if (lines.length !== 1 || lines[0] === undefined) {
    throw new Error(`Expected one operator output line, received ${lines.length}`);
  }
  return JSON.parse(lines[0]) as Record<string, unknown>;
}

function expectNoProviderAccess(result: OperatorResult): void {
  expect(result.stdout).not.toContain(providerAccessMarker);
  expect(result.stderr).not.toContain(providerAccessMarker);
}

function realCatalog(validatedAt: Date): Readonly<Record<ModelTier, CatalogModelSnapshot>> {
  return Object.freeze(
    Object.fromEntries(
      modelTiers.map((tier) => [
        tier,
        Object.freeze({
          available: true,
          canonicalSlug: initialTierModels[tier],
          capability: testCatalogCapability,
          completionPricePerToken: "0.000002",
          contextLength: 128_000,
          displayName: `Model ${tier}`,
          inputModalities: Object.freeze(["text"]),
          maximumOutputTokens: 16_384,
          metadataSource: "openrouter",
          modelId: initialTierModels[tier],
          outputModalities: Object.freeze(["text"]),
          promptPricePerToken: "0.000001",
          requestPriceUsd: "0",
          supportedParameters: Object.freeze(["max_tokens", "reasoning"]),
          validatedAt,
        }),
      ]),
    ) as Record<ModelTier, CatalogModelSnapshot>,
  );
}

describe.sequential("model-policy operator commands", () => {
  let container: StartedPostgreSqlContainer;
  let databaseUrl: string;
  let pool: Pool;
  let privacyAttestationDocument = "";

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:18.4-alpine")
      .withDatabase("capstone_model_policy_operator")
      .withUsername("capstone")
      .withPassword("capstone-test-password")
      .start();
    databaseUrl = container.getConnectionUri();
    await migrateDatabase(databaseUrl);
    pool = new Pool({ connectionString: databaseUrl });
    await writePrivacyAttestation(new Date(Date.now() - 1_000));
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE TABLE "model_catalog", "workspaces" RESTART IDENTITY CASCADE');
    await createDatabase(pool).insert(workspaces).values({
      displayName: "Capstone Ecuador",
      identity: "capstone-ecuador",
      timezone: "America/Guayaquil",
    });
  });

  afterAll(async () => {
    await pool.end();
    await container.stop();
  });

  function runOperator(argumentsList: readonly string[]): Promise<OperatorResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(operatorExecutable, [operatorScript, ...argumentsList], {
        cwd: apiRoot,
        env: {
          ...process.env,
          DATABASE_URL: databaseUrl,
          NODE_ENV: "test",
          NODE_OPTIONS: fetchGuardNodeOption,
          OPENROUTER_API_KEY: "",
        },
      });
      let stdout = "";
      let stderr = "";

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      if (
        argumentsList.some(
          (value, index) => value === "-" && argumentsList[index - 1] === "--privacy-attestation",
        )
      ) {
        child.stdin.end(privacyAttestationDocument);
      } else {
        child.stdin.end();
      }
      child.once("error", reject);
      child.once("close", (code, signal) => {
        if (signal !== null) {
          reject(new Error(`Operator command exited from signal ${signal}`));
          return;
        }
        resolve({ code: code ?? 1, stderr, stdout });
      });
    });
  }

  async function writePrivacyAttestation(verifiedAt: Date): Promise<void> {
    privacyAttestationDocument = JSON.stringify({
      attestationVersion: "openrouter-privacy-v1",
      broadcastEnabled: false,
      dataDiscountLoggingEnabled: false,
      inputOutputLoggingEnabled: false,
      verifiedAt: verifiedAt.toISOString(),
    });
  }

  async function seedRealPolicy(verifiedAt: Date): Promise<void> {
    const service = createModelPolicyService(createDatabase(pool));
    await service.bootstrap({
      catalog: realCatalog(new Date(Date.now() - 1_000)),
      employeeActiveGenerationLimit: 2,
      maximumOutputTokens: { balanced: 8_192, fast: 4_096, pro: 16_384 },
      mode: "openrouter",
      monthlyBudgetUsd: "100",
      privacyAttestation: verifyPrivacyAttestation({
        attestationVersion: "openrouter-privacy-v1",
        broadcastEnabled: false,
        dataDiscountLoggingEnabled: false,
        inputOutputLoggingEnabled: false,
        verifiedAt,
      }),
      reservationMarginBasisPoints: 2_000,
      workspaceIdentity: "capstone-ecuador",
    });
  }

  async function readPolicyState() {
    const database = createDatabase(pool);
    const [catalog, costPolicies, modelPolicies, privacyAttestations] = await Promise.all([
      database.select().from(modelCatalog),
      database.select().from(workspaceCostPolicies),
      database.select().from(workspaceModelPolicies),
      database.select().from(openRouterPrivacyAttestations),
    ]);
    return {
      catalog: catalog.sort((left, right) =>
        left.openRouterModelId.localeCompare(right.openRouterModelId),
      ),
      costPolicies,
      modelPolicies: modelPolicies.sort((left, right) => left.tier.localeCompare(right.tier)),
      privacyAttestations,
    };
  }

  it("rejects the retired simulated bootstrap command without provider access", async () => {
    const first = await runOperator(simulatedBootstrapArguments);
    const repeated = await runOperator(simulatedBootstrapArguments);

    expect(first.code).toBe(1);
    expect(first.stdout).toBe("");
    expect(parseOperatorOutput(first.stderr)).toEqual({
      errorName: "Error",
      outcome: "failed",
    });
    expect(repeated.code).toBe(1);
    expect(repeated.stdout).toBe("");
    expect(parseOperatorOutput(repeated.stderr)).toEqual({
      errorName: "Error",
      outcome: "failed",
    });
    expectNoProviderAccess(first);
    expectNoProviderAccess(repeated);

    expect(await readPolicyState()).toEqual({
      catalog: [],
      costPolicies: [],
      modelPolicies: [],
      privacyAttestations: [],
    });
  });

  it("rejects retired bootstrap variations without mutating policy", async () => {
    const conflictingArguments = simulatedBootstrapArguments.map((value, index, values) =>
      values[index - 1] === "--monthly-budget-usd" ? "101" : value,
    );

    const conflict = await runOperator(conflictingArguments);

    expect(conflict.code).toBe(1);
    expect(conflict.stdout).toBe("");
    expect(parseOperatorOutput(conflict.stderr)).toEqual({
      errorName: "Error",
      outcome: "failed",
    });
    expectNoProviderAccess(conflict);
    expect((await readPolicyState()).costPolicies).toEqual([]);
  });

  it("renews an existing real policy without provider access and retries idempotently", async () => {
    const initialVerifiedAt = new Date(Date.now() - 60_000);
    await seedRealPolicy(initialVerifiedAt);
    const renewedVerifiedAt = new Date(Date.now() - 1_000);
    await writePrivacyAttestation(renewedVerifiedAt);
    const argumentsList = [
      "attest",
      "--workspace",
      "capstone-ecuador",
      "--privacy-attestation",
      "-",
    ] as const;

    const renewed = await runOperator(argumentsList);
    const repeated = await runOperator(argumentsList);

    expect(renewed.code).toBe(0);
    expect(renewed.stderr).toBe("");
    expect(parseOperatorOutput(renewed.stdout)).toEqual({
      command: "attest",
      repeated: false,
      workspace: "capstone-ecuador",
    });
    expect(repeated.code).toBe(0);
    expect(repeated.stderr).toBe("");
    expect(parseOperatorOutput(repeated.stdout)).toEqual({
      command: "attest",
      repeated: true,
      workspace: "capstone-ecuador",
    });
    expectNoProviderAccess(renewed);
    expectNoProviderAccess(repeated);
    expect((await readPolicyState()).privacyAttestations).toEqual([
      expect.objectContaining({ verifiedAt: renewedVerifiedAt }),
    ]);
  });

  it("rejects privacy documents from files instead of bounded standard input", async () => {
    const result = await runOperator([
      "attest",
      "--workspace",
      "capstone-ecuador",
      "--privacy-attestation",
      "/tmp/privacy-attestation.json",
    ]);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(parseOperatorOutput(result.stderr)).toEqual({
      errorName: "Error",
      outcome: "failed",
    });
    expectNoProviderAccess(result);
    expect((await readPolicyState()).privacyAttestations).toEqual([]);
  });

  it("rejects privacy renewal for unbootstrapped and simulated policies", async () => {
    await writePrivacyAttestation(new Date(Date.now() - 1_000));
    const argumentsList = [
      "attest",
      "--workspace",
      "capstone-ecuador",
      "--privacy-attestation",
      "-",
    ] as const;

    const unbootstrapped = await runOperator(argumentsList);
    await bootstrapSimulatedModelPolicy(
      createModelPolicyService(createDatabase(pool)),
      "capstone-ecuador",
    );
    const simulated = await runOperator(argumentsList);

    for (const result of [unbootstrapped, simulated]) {
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(parseOperatorOutput(result.stderr)).toEqual({
        errorName: "ModelPolicyConflictError",
        outcome: "failed",
      });
      expectNoProviderAccess(result);
    }
    expect((await readPolicyState()).privacyAttestations).toEqual([]);
  });

  it("rejects older and future privacy renewal without mutating policy", async () => {
    const initialVerifiedAt = new Date(Date.now() - 60_000);
    await seedRealPolicy(initialVerifiedAt);
    const before = await readPolicyState();
    const argumentsList = [
      "attest",
      "--workspace",
      "capstone-ecuador",
      "--privacy-attestation",
      "-",
    ] as const;

    await writePrivacyAttestation(new Date(initialVerifiedAt.getTime() - 1));
    const older = await runOperator(argumentsList);
    await writePrivacyAttestation(new Date(Date.now() + 60_000));
    const future = await runOperator(argumentsList);

    for (const result of [older, future]) {
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(parseOperatorOutput(result.stderr)).toEqual({
        errorName: "ModelPolicyConflictError",
        outcome: "failed",
      });
      expectNoProviderAccess(result);
    }
    expect(await readPolicyState()).toEqual(before);
  });

  it("rejects arbitrary refresh and model arguments before provider access", async () => {
    const refresh = await runOperator(["refresh", "--model", "unapproved/model"]);
    const bootstrap = await runOperator([
      ...simulatedBootstrapArguments,
      "--model",
      "unapproved/model",
    ]);

    for (const result of [refresh, bootstrap]) {
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(parseOperatorOutput(result.stderr)).toEqual({
        errorName: "Error",
        outcome: "failed",
      });
      expectNoProviderAccess(result);
    }
    expect(await readPolicyState()).toEqual({
      catalog: [],
      costPolicies: [],
      modelPolicies: [],
      privacyAttestations: [],
    });
  });

  it("rejects the retired real bootstrap command before provider access or mutation", async () => {
    const result = await runOperator([
      "bootstrap",
      "--workspace",
      "capstone-ecuador",
      "--mode",
      "openrouter",
      "--monthly-budget-usd",
      "100",
      "--fast-max-output",
      "1",
      "--balanced-max-output",
      "2",
      "--pro-max-output",
      "3",
      "--employee-generation-limit",
      "2",
      "--reservation-margin-bps",
      "2000",
      "--privacy-attestation",
      "-",
    ]);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(parseOperatorOutput(result.stderr)).toEqual({
      errorName: "Error",
      outcome: "failed",
    });
    expectNoProviderAccess(result);
    expect(await readPolicyState()).toEqual({
      catalog: [],
      costPolicies: [],
      modelPolicies: [],
      privacyAttestations: [],
    });
  });
});

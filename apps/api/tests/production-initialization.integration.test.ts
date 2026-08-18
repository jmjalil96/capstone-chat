import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { WORKSPACE_ASSISTANT_RULES_PRESET } from "../src/assistant-rules/defaults.js";
import {
  workspaceAssistantPromptRevisions,
  workspaceAssistantPrompts,
} from "../src/database/assistant-rules-schema.js";
import { createDatabase } from "../src/database/database.js";
import { employeeApprovals, workspaces } from "../src/database/identity-schema.js";
import { productionInitialization } from "../src/database/initialization-schema.js";
import { migrateDatabase } from "../src/database/migrate.js";
import {
  workspaceCostPolicies,
  workspaceModelPolicies,
  workspaceModelPolicyRevisions,
  workspaceModelPolicyRevisionTiers,
} from "../src/database/model-policy-schema.js";
import { createIdentityService } from "../src/identity/service.js";
import {
  type CatalogModelSnapshot,
  initialTierModels,
  type ModelTier,
  modelTiers,
} from "../src/model-policy/catalog.js";
import { INITIAL_TIER_BEHAVIOR_DEFAULTS } from "../src/model-policy/defaults.js";
import { parseProductionInitializationDocument } from "../src/operator/initialization-document.js";
import {
  createProductionInitializationLatch,
  ProductionInitializationConflictError,
} from "../src/operator/initialization-latch.js";
import type { ProductionInitializationCheckpoint } from "../src/operator/production-initialization.js";
import {
  initializeManagedRehearsal,
  initializeProduction,
} from "../src/operator/production-initialization.js";
import { testCatalogCapability } from "./support/generation.js";

const apiRoot = fileURLToPath(new URL("..", import.meta.url));
const operatorExecutable = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));
const entrypointScript = fileURLToPath(new URL("../src/entrypoint.ts", import.meta.url));

function documentContents(email = "administrator@capstone.com.ec"): string {
  return JSON.stringify({
    administrator: { email },
    assistantRules: { preset: WORKSPACE_ASSISTANT_RULES_PRESET },
    modelPolicy: {
      employeeActiveGenerationLimit: 2,
      maximumOutputTokens: { balanced: 8_192, fast: 4_096, pro: 16_384 },
      monthlyBudgetUsd: "100",
      reservationMarginBasisPoints: 2_000,
      tierBehavior: INITIAL_TIER_BEHAVIOR_DEFAULTS,
    },
    privacyAttestation: {
      attestationVersion: "openrouter-privacy-v1",
      broadcastEnabled: false,
      dataDiscountLoggingEnabled: false,
      inputOutputLoggingEnabled: false,
      verifiedAt: new Date().toISOString(),
    },
    schemaVersion: 2,
    workspace: { displayName: "Capstone", identity: "capstone" },
  });
}

function document(email = "administrator@capstone.com.ec") {
  return parseProductionInitializationDocument(documentContents(email));
}

function catalog(
  completionPricePerToken = "0.000002",
): Readonly<Record<ModelTier, CatalogModelSnapshot>> {
  return Object.freeze(
    Object.fromEntries(
      modelTiers.map((tier) => [
        tier,
        Object.freeze({
          available: true,
          canonicalSlug: initialTierModels[tier],
          capability: testCatalogCapability,
          completionPricePerToken,
          contextLength: 128_000,
          displayName: `Model ${tier}`,
          inputModalities: Object.freeze(["text"]),
          maximumOutputTokens: 32_768,
          metadataSource: "openrouter",
          modelId: initialTierModels[tier],
          outputModalities: Object.freeze(["text"]),
          promptPricePerToken: "0.000001",
          requestPriceUsd: "0",
          supportedParameters: Object.freeze(["max_tokens", "reasoning"]),
          validatedAt: new Date(),
        }),
      ]),
    ) as Record<ModelTier, CatalogModelSnapshot>,
  );
}

describe.sequential("production initialization", () => {
  let container: StartedPostgreSqlContainer;
  let databaseUrl: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:18.4-alpine")
      .withDatabase("capstone_initialization")
      .withUsername("capstone")
      .withPassword("capstone-test-password")
      .start();
    databaseUrl = container.getConnectionUri();
  }, 120_000);

  beforeEach(async () => {
    await migrateDatabase(databaseUrl);
    const pool = new Pool({ connectionString: databaseUrl });
    try {
      await pool.query(
        'TRUNCATE TABLE "production_initialization", "workspace_model_policies", "workspace_cost_policies", "workspace_catalog_approvals", "model_catalog", "workspace_memberships", "employee_approvals", "user", "workspaces" RESTART IDENTITY CASCADE',
      );
    } finally {
      await pool.end();
    }
  });

  afterAll(async () => {
    await container.stop();
  });

  function runInitialInvitation(contents: string): Promise<{
    readonly code: number;
    readonly stderr: string;
    readonly stdout: string;
  }> {
    return new Promise((resolve, reject) => {
      const child = spawn(operatorExecutable, [entrypointScript, "invite-initial"], {
        cwd: apiRoot,
        env: {
          ...process.env,
          DATABASE_URL: databaseUrl,
          EMAIL_DELIVERY: "fake",
          NODE_ENV: "test",
          PUBLIC_ORIGIN: "http://localhost:5173",
        },
      });
      let stderr = "";
      let stdout = "";
      child.stderr.setEncoding("utf8");
      child.stdout.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.once("error", reject);
      child.once("close", (code, signal) => {
        if (signal !== null) {
          reject(new Error(`Initial invitation command exited from signal ${signal}`));
          return;
        }
        resolve({ code: code ?? 1, stderr, stdout });
      });
      child.stdin.end(contents);
    });
  }

  it("persists ordered phases, closes the first pool before provider work, and repeats safely", async () => {
    const initializationDocument = document();
    let openSessions = 0;
    const openDatabase = (url: string) => {
      const sessionPool = new Pool({ connectionString: url });
      openSessions += 1;
      return {
        async close() {
          await sessionPool.end();
          openSessions -= 1;
        },
        database: createDatabase(sessionPool),
      };
    };
    const loadCatalog = vi.fn(async () => {
      expect(openSessions).toBe(0);
      return catalog();
    });

    await expect(
      initializeProduction(
        {
          applicationDatabaseUrl: databaseUrl,
          document: initializationDocument,
          migrationDatabaseUrl: databaseUrl,
          openRouterApiKey: "test-provider-key",
        },
        { loadCatalog, openDatabase },
      ),
    ).resolves.toEqual({ outcome: "completed", phase: "complete" });

    const pool = new Pool({ connectionString: databaseUrl });
    const database = createDatabase(pool);
    try {
      await expect(database.select().from(productionInitialization)).resolves.toMatchObject([
        {
          documentSha256: initializationDocument.documentSha256,
          phase: "complete",
          schemaVersion: 2,
          singletonId: 1,
        },
      ]);
      await expect(database.select().from(workspaces)).resolves.toHaveLength(1);
      await expect(database.select().from(employeeApprovals)).resolves.toMatchObject([
        {
          normalizedEmail: initializationDocument.administratorEmail,
          role: "admin",
          status: "pending",
        },
      ]);
      await expect(database.select().from(workspaceCostPolicies)).resolves.toMatchObject([
        { employeeActiveGenerationLimit: 2, monthlyBudgetUsd: "100.000000000000000000" },
      ]);
      await expect(database.select().from(workspaceModelPolicies)).resolves.toHaveLength(3);
      await expect(database.select().from(workspaceAssistantPrompts)).resolves.toMatchObject([
        { revision: 1 },
      ]);
      await expect(
        database.select().from(workspaceAssistantPromptRevisions),
      ).resolves.toMatchObject([{ actorKind: "system", changeKind: "bootstrap", revision: 1 }]);
      await expect(database.select().from(workspaceModelPolicyRevisions)).resolves.toMatchObject([
        { actorKind: "system", changeKind: "bootstrap", revision: 1 },
      ]);
      await expect(database.select().from(workspaceModelPolicyRevisionTiers)).resolves.toHaveLength(
        3,
      );
      await expect(
        createIdentityService(database).initialInvitationTarget({
          adminEmail: initializationDocument.administratorEmail,
          workspaceIdentity: initializationDocument.workspaceIdentity,
        }),
      ).resolves.toMatchObject({ normalizedEmail: initializationDocument.administratorEmail });
      await expect(
        createIdentityService(database).initialInvitationTarget({
          adminEmail: "missing@capstone.com.ec",
          workspaceIdentity: initializationDocument.workspaceIdentity,
        }),
      ).rejects.toThrow("canonical pending administrator approval");
    } finally {
      await pool.end();
    }

    loadCatalog.mockClear();
    await expect(
      initializeProduction(
        {
          applicationDatabaseUrl: databaseUrl,
          document: initializationDocument,
          migrationDatabaseUrl: databaseUrl,
          openRouterApiKey: "test-provider-key",
        },
        { loadCatalog, openDatabase },
      ),
    ).resolves.toEqual({ outcome: "already-complete", phase: "complete" });
    expect(loadCatalog).not.toHaveBeenCalled();
  }, 120_000);

  it("initializes and retries the managed rehearsal without provider access", async () => {
    const initializationDocument = document("administrator@rehearsal.test");
    let interrupted = false;
    await expect(
      initializeManagedRehearsal(
        {
          applicationDatabaseUrl: databaseUrl,
          document: initializationDocument,
          migrationDatabaseUrl: databaseUrl,
        },
        {
          afterCheckpoint(checkpoint) {
            if (!interrupted && checkpoint === "catalog-loaded") {
              interrupted = true;
              throw new Error("synthetic managed interruption");
            }
          },
        },
      ),
    ).rejects.toThrow("synthetic managed interruption");

    await expect(
      initializeManagedRehearsal({
        applicationDatabaseUrl: databaseUrl,
        document: initializationDocument,
        migrationDatabaseUrl: databaseUrl,
      }),
    ).resolves.toEqual({ outcome: "completed", phase: "complete" });
    await expect(
      initializeManagedRehearsal({
        applicationDatabaseUrl: databaseUrl,
        document: initializationDocument,
        migrationDatabaseUrl: databaseUrl,
      }),
    ).resolves.toEqual({ outcome: "already-complete", phase: "complete" });

    const pool = new Pool({ connectionString: databaseUrl });
    const database = createDatabase(pool);
    try {
      await expect(database.select().from(workspaceModelPolicies)).resolves.toHaveLength(3);
      await expect(database.select().from(productionInitialization)).resolves.toMatchObject([
        { documentSha256: initializationDocument.documentSha256, phase: "complete" },
      ]);
    } finally {
      await pool.end();
    }
  }, 120_000);

  it("sends the initial invitation only for the completed canonical authority without mutation", async () => {
    const contents = documentContents();
    const initializationDocument = parseProductionInitializationDocument(contents);
    await initializeProduction(
      {
        applicationDatabaseUrl: databaseUrl,
        document: initializationDocument,
        migrationDatabaseUrl: databaseUrl,
        openRouterApiKey: "test-provider-key",
      },
      { loadCatalog: async () => catalog() },
    );

    const pool = new Pool({ connectionString: databaseUrl });
    const database = createDatabase(pool);
    try {
      const before = await Promise.all([
        database.select().from(workspaces),
        database.select().from(employeeApprovals),
        database.select().from(productionInitialization),
      ]);
      const sent = await runInitialInvitation(contents);
      expect(sent).toEqual({
        code: 0,
        stderr: "",
        stdout: `${JSON.stringify({ command: "invite-initial", outcome: "sent", retrySafe: true })}\n`,
      });
      expect(`${sent.stdout}${sent.stderr}`).not.toContain(
        initializationDocument.administratorEmail,
      );
      await expect(
        Promise.all([
          database.select().from(workspaces),
          database.select().from(employeeApprovals),
          database.select().from(productionInitialization),
        ]),
      ).resolves.toEqual(before);

      const conflicting = await runInitialInvitation(documentContents("other@capstone.com.ec"));
      expect(conflicting.code).toBe(1);
      expect(conflicting.stdout).toBe("");
      expect(JSON.parse(conflicting.stderr)).toEqual({
        errorName: "ProductionInitializationConflictError",
        outcome: "failed",
      });

      await database
        .update(employeeApprovals)
        .set({ revokedAt: new Date(), status: "revoked" })
        .where(eq(employeeApprovals.normalizedEmail, initializationDocument.administratorEmail));
      const authorityBeforeFailure = await database.select().from(productionInitialization);
      const unavailable = await runInitialInvitation(contents);
      expect(unavailable.code).toBe(1);
      expect(unavailable.stdout).toBe("");
      expect(JSON.parse(unavailable.stderr)).toEqual({
        errorName: "IdentityConflictError",
        outcome: "failed",
      });
      await expect(database.select().from(productionInitialization)).resolves.toEqual(
        authorityBeforeFailure,
      );
    } finally {
      await pool.end();
    }
  }, 120_000);

  it("fails a conflicting document before provider work", async () => {
    const first = document();
    await initializeProduction(
      {
        applicationDatabaseUrl: databaseUrl,
        document: first,
        migrationDatabaseUrl: databaseUrl,
        openRouterApiKey: "test-provider-key",
      },
      { loadCatalog: async () => catalog() },
    );
    const loadCatalog = vi.fn(async () => catalog());

    await expect(
      initializeProduction(
        {
          applicationDatabaseUrl: databaseUrl,
          document: document("other@capstone.com.ec"),
          migrationDatabaseUrl: databaseUrl,
          openRouterApiKey: "test-provider-key",
        },
        { loadCatalog },
      ),
    ).rejects.toBeInstanceOf(ProductionInitializationConflictError);
    expect(loadCatalog).not.toHaveBeenCalled();
  }, 120_000);

  it("uses one schema-2 latch transition despite a skewed process clock", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2000-01-01T00:00:00.000Z"));
    const pool = new Pool({ connectionString: databaseUrl });
    try {
      const latch = createProductionInitializationLatch(createDatabase(pool));
      const documentSha256 = "a".repeat(64);
      await expect(latch.claim(documentSha256)).resolves.toMatchObject({
        phase: "claimed",
        schemaVersion: 2,
      });
      await expect(
        latch.completeWith(documentSha256, async () => undefined),
      ).resolves.toMatchObject({
        phase: "complete",
        schemaVersion: 2,
      });
    } finally {
      await pool.end();
      vi.useRealTimers();
    }
  }, 120_000);

  it("leaves application state untouched when provider catalog loading fails", async () => {
    const initializationDocument = document();
    await expect(
      initializeProduction(
        {
          applicationDatabaseUrl: databaseUrl,
          document: initializationDocument,
          migrationDatabaseUrl: databaseUrl,
          openRouterApiKey: "test-provider-key",
        },
        { loadCatalog: async () => Promise.reject(new Error("provider unavailable")) },
      ),
    ).rejects.toThrow("provider unavailable");

    const pool = new Pool({ connectionString: databaseUrl });
    const database = createDatabase(pool);
    try {
      await expect(
        database
          .select({ phase: productionInitialization.phase })
          .from(productionInitialization)
          .where(eq(productionInitialization.singletonId, 1)),
      ).resolves.toEqual([{ phase: "claimed" }]);
      await expect(database.select().from(employeeApprovals)).resolves.toHaveLength(0);
      await expect(database.select().from(workspaceCostPolicies)).resolves.toHaveLength(0);
    } finally {
      await pool.end();
    }

    await expect(
      initializeProduction(
        {
          applicationDatabaseUrl: databaseUrl,
          document: initializationDocument,
          migrationDatabaseUrl: databaseUrl,
          openRouterApiKey: "test-provider-key",
        },
        { loadCatalog: async () => catalog() },
      ),
    ).resolves.toEqual({ outcome: "completed", phase: "complete" });
  }, 120_000);

  it.each<ProductionInitializationCheckpoint>([
    "migrations-complete",
    "latch-claimed",
    "identity-complete",
    "catalog-loaded",
    "policy-complete",
  ])(
    "retries safely after interruption at %s",
    async (interruptedCheckpoint) => {
      const initializationDocument = document();
      await expect(
        initializeProduction(
          {
            applicationDatabaseUrl: databaseUrl,
            document: initializationDocument,
            migrationDatabaseUrl: databaseUrl,
            openRouterApiKey: "test-provider-key",
          },
          {
            afterCheckpoint(checkpoint) {
              if (checkpoint === interruptedCheckpoint) {
                throw new Error(`synthetic interruption at ${checkpoint}`);
              }
            },
            loadCatalog: async () => catalog(),
          },
        ),
      ).rejects.toThrow(`synthetic interruption at ${interruptedCheckpoint}`);

      await expect(
        initializeProduction(
          {
            applicationDatabaseUrl: databaseUrl,
            document: initializationDocument,
            migrationDatabaseUrl: databaseUrl,
            openRouterApiKey: "test-provider-key",
          },
          { loadCatalog: async () => catalog() },
        ),
      ).resolves.toMatchObject({ phase: "complete" });

      const pool = new Pool({ connectionString: databaseUrl });
      const database = createDatabase(pool);
      try {
        await expect(database.select().from(productionInitialization)).resolves.toMatchObject([
          { documentSha256: initializationDocument.documentSha256, phase: "complete" },
        ]);
        await expect(database.select().from(workspaces)).resolves.toHaveLength(1);
        await expect(database.select().from(employeeApprovals)).resolves.toHaveLength(1);
        await expect(database.select().from(workspaceCostPolicies)).resolves.toHaveLength(1);
        await expect(database.select().from(workspaceModelPolicies)).resolves.toHaveLength(3);
      } finally {
        await pool.end();
      }
    },
    120_000,
  );

  it("rolls policy writes back when interrupted before the completion authority commits", async () => {
    const initializationDocument = document();
    await expect(
      initializeProduction(
        {
          applicationDatabaseUrl: databaseUrl,
          document: initializationDocument,
          migrationDatabaseUrl: databaseUrl,
          openRouterApiKey: "test-provider-key",
        },
        {
          afterCheckpoint(checkpoint) {
            if (checkpoint === "policy-complete") {
              throw new Error("synthetic interruption before authority commit");
            }
          },
          loadCatalog: async () => catalog(),
        },
      ),
    ).rejects.toThrow("synthetic interruption before authority commit");

    const pool = new Pool({ connectionString: databaseUrl });
    const database = createDatabase(pool);
    try {
      await expect(database.select().from(productionInitialization)).resolves.toMatchObject([
        { documentSha256: initializationDocument.documentSha256, phase: "claimed" },
      ]);
      await expect(database.select().from(workspaceCostPolicies)).resolves.toHaveLength(0);
      await expect(database.select().from(workspaceModelPolicies)).resolves.toHaveLength(0);
    } finally {
      await pool.end();
    }

    await expect(
      initializeProduction(
        {
          applicationDatabaseUrl: databaseUrl,
          document: initializationDocument,
          migrationDatabaseUrl: databaseUrl,
          openRouterApiKey: "test-provider-key",
        },
        { loadCatalog: async () => catalog("0.000003") },
      ),
    ).resolves.toEqual({ outcome: "completed", phase: "complete" });
  }, 120_000);
});

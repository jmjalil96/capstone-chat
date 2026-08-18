import { bootstrapAssistantRulesInTransaction } from "../assistant-rules/service.js";
import type { AppDatabase } from "../database/database.js";
import { createDatabase } from "../database/database.js";
import { migrateDatabase } from "../database/migrate.js";
import { createDatabasePool } from "../database/pool.js";
import { createIdentityService } from "../identity/service.js";
import { createLoadRehearsalCatalog } from "../load/managed-rehearsal.js";
import type { CatalogModelSnapshot, ModelTier } from "../model-policy/catalog.js";
import { createModelPolicyService } from "../model-policy/service.js";
import type { ProductionInitializationDocument } from "./initialization-document.js";
import { createProductionInitializationLatch } from "./initialization-latch.js";
import { loadApprovedOpenRouterCatalog } from "./openrouter-bootstrap-catalog.js";

export interface ProductionInitializationInput {
  readonly applicationDatabaseUrl: string;
  readonly document: ProductionInitializationDocument;
  readonly migrationDatabaseUrl: string;
  readonly openRouterApiKey: string;
}

export interface ManagedRehearsalInitializationInput {
  readonly applicationDatabaseUrl: string;
  readonly document: ProductionInitializationDocument;
  readonly migrationDatabaseUrl: string;
}

interface InitializationDatabaseSession {
  readonly database: AppDatabase;
  close(): Promise<void>;
}

export type ProductionInitializationCheckpoint =
  | "catalog-loaded"
  | "identity-complete"
  | "latch-claimed"
  | "migrations-complete"
  | "policy-complete";

export interface ProductionInitializationDependencies {
  readonly afterCheckpoint: (checkpoint: ProductionInitializationCheckpoint) => void;
  readonly loadCatalog: (
    apiKey: string,
  ) => Promise<Readonly<Record<ModelTier, CatalogModelSnapshot>>>;
  readonly migrate: (databaseUrl: string) => Promise<void>;
  readonly openDatabase: (databaseUrl: string) => InitializationDatabaseSession;
}

export interface ProductionInitializationResult {
  readonly outcome: "already-complete" | "completed";
  readonly phase: "complete";
}

export type ManagedRehearsalInitializationDependencies = Omit<
  ProductionInitializationDependencies,
  "loadCatalog"
>;

const defaultDependencies: ProductionInitializationDependencies = Object.freeze({
  afterCheckpoint: () => undefined,
  loadCatalog: (apiKey: string) => loadApprovedOpenRouterCatalog(apiKey),
  migrate: migrateDatabase,
  openDatabase(databaseUrl: string) {
    const pool = createDatabasePool(databaseUrl);
    return Object.freeze({
      close: () => pool.end(),
      database: createDatabase(pool),
    });
  },
});

async function useDatabase<T>(
  dependencies: ProductionInitializationDependencies,
  databaseUrl: string,
  operation: (database: AppDatabase) => Promise<T>,
): Promise<T> {
  const session = dependencies.openDatabase(databaseUrl);
  try {
    return await operation(session.database);
  } finally {
    await session.close();
  }
}

async function initializeWithCatalog(
  input: ManagedRehearsalInitializationInput,
  dependencies: ProductionInitializationDependencies,
  loadCatalog: () => Promise<Readonly<Record<ModelTier, CatalogModelSnapshot>>>,
): Promise<ProductionInitializationResult> {
  await dependencies.migrate(input.migrationDatabaseUrl);
  dependencies.afterCheckpoint("migrations-complete");

  const claimed = await useDatabase(dependencies, input.applicationDatabaseUrl, async (database) =>
    createProductionInitializationLatch(database).claim(input.document.documentSha256),
  );
  if (claimed.phase === "complete") {
    return Object.freeze({ outcome: "already-complete", phase: "complete" });
  }
  dependencies.afterCheckpoint("latch-claimed");

  // Catalog and privacy validation complete before the coherent application-state transaction.
  const catalog = await loadCatalog();
  dependencies.afterCheckpoint("catalog-loaded");

  const outcome = await useDatabase(
    dependencies,
    input.applicationDatabaseUrl,
    async (database) => {
      const latch = createProductionInitializationLatch(database);
      const identity = createIdentityService(database);
      const modelPolicy = createModelPolicyService(database);
      await latch.completeWith(input.document.documentSha256, async (transaction) => {
        const workspace = await identity.bootstrapInTransaction(transaction, {
          adminEmail: input.document.administratorEmail,
          displayName: input.document.workspaceDisplayName,
          workspaceIdentity: input.document.workspaceIdentity,
        });
        dependencies.afterCheckpoint("identity-complete");
        await bootstrapAssistantRulesInTransaction(transaction, workspace.workspaceId, new Date());
        await modelPolicy.bootstrapInTransaction(transaction, {
          catalog,
          employeeActiveGenerationLimit: input.document.employeeActiveGenerationLimit,
          maximumOutputTokens: input.document.maximumOutputTokens,
          mode: "openrouter",
          monthlyBudgetUsd: input.document.monthlyBudgetUsd,
          privacyAttestation: input.document.privacyAttestation,
          reservationMarginBasisPoints: input.document.reservationMarginBasisPoints,
          workspaceIdentity: input.document.workspaceIdentity,
        });
        dependencies.afterCheckpoint("policy-complete");
      });
      return "completed" as const;
    },
  );

  return Object.freeze({ outcome, phase: "complete" });
}

export async function initializeProduction(
  input: ProductionInitializationInput,
  overrides: Partial<ProductionInitializationDependencies> = {},
): Promise<ProductionInitializationResult> {
  const dependencies: ProductionInitializationDependencies = Object.freeze({
    ...defaultDependencies,
    ...overrides,
  });
  return initializeWithCatalog(input, dependencies, () =>
    dependencies.loadCatalog(input.openRouterApiKey),
  );
}

export async function initializeManagedRehearsal(
  input: ManagedRehearsalInitializationInput,
  overrides: Partial<ManagedRehearsalInitializationDependencies> = {},
): Promise<ProductionInitializationResult> {
  const dependencies: ProductionInitializationDependencies = Object.freeze({
    ...defaultDependencies,
    ...overrides,
    loadCatalog: async () =>
      createLoadRehearsalCatalog(input.document.privacyAttestation.verifiedAt),
  });
  return initializeWithCatalog(input, dependencies, () => dependencies.loadCatalog(""));
}

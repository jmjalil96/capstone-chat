import { and, eq, sql } from "drizzle-orm";
import type { AppDatabase, AppTransaction } from "../database/database.js";
import { productionInitialization } from "../database/initialization-schema.js";

export type ProductionInitializationPhase = "claimed" | "complete";

export interface ProductionInitializationState {
  readonly documentSha256: string;
  readonly phase: ProductionInitializationPhase;
  readonly schemaVersion: 2;
}

export class ProductionInitializationConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProductionInitializationConflictError";
  }
}

function toState(row: {
  readonly documentSha256: string;
  readonly phase: string;
  readonly schemaVersion: number;
}): ProductionInitializationState {
  if (row.schemaVersion !== 2 || (row.phase !== "claimed" && row.phase !== "complete")) {
    throw new ProductionInitializationConflictError(
      "Production initialization state is incompatible",
    );
  }
  return Object.freeze({
    documentSha256: row.documentSha256,
    phase: row.phase,
    schemaVersion: 2,
  });
}

async function lockedState(
  transaction: AppTransaction,
): Promise<ProductionInitializationState | null> {
  await transaction.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext('capstone.production.initialization'))`,
  );
  const rows = await transaction
    .select({
      documentSha256: productionInitialization.documentSha256,
      phase: productionInitialization.phase,
      schemaVersion: productionInitialization.schemaVersion,
    })
    .from(productionInitialization)
    .where(eq(productionInitialization.singletonId, 1))
    .limit(1)
    .for("update");
  return rows[0] === undefined ? null : toState(rows[0]);
}

function assertDocument(
  state: ProductionInitializationState,
  documentSha256: string,
): ProductionInitializationState {
  if (state.documentSha256 !== documentSha256) {
    throw new ProductionInitializationConflictError(
      "Production initialization document conflicts with durable authority",
    );
  }
  return state;
}

export function createProductionInitializationLatch(database: AppDatabase) {
  async function requireComplete(documentSha256: string): Promise<ProductionInitializationState> {
    const rows = await database
      .select({
        documentSha256: productionInitialization.documentSha256,
        phase: productionInitialization.phase,
        schemaVersion: productionInitialization.schemaVersion,
      })
      .from(productionInitialization)
      .where(eq(productionInitialization.singletonId, 1))
      .limit(1);
    const row = rows[0];
    if (row === undefined) {
      throw new ProductionInitializationConflictError(
        "Production initialization authority is missing",
      );
    }
    const state = assertDocument(toState(row), documentSha256);
    if (state.phase !== "complete") {
      throw new ProductionInitializationConflictError(
        "Production initialization authority is incomplete",
      );
    }
    return state;
  }

  async function claim(documentSha256: string): Promise<ProductionInitializationState> {
    return database.transaction(async (transaction) => {
      const existing = await lockedState(transaction);
      if (existing !== null) {
        return assertDocument(existing, documentSha256);
      }
      const inserted = await transaction
        .insert(productionInitialization)
        .values({
          documentSha256,
          phase: "claimed",
          schemaVersion: 2,
          singletonId: 1,
        })
        .returning({
          documentSha256: productionInitialization.documentSha256,
          phase: productionInitialization.phase,
          schemaVersion: productionInitialization.schemaVersion,
        });
      const row = inserted[0];
      if (row === undefined) {
        throw new Error("Production initialization latch was not created");
      }
      return toState(row);
    });
  }

  async function completeWith(
    documentSha256: string,
    operation: (transaction: AppTransaction) => Promise<void>,
  ): Promise<ProductionInitializationState> {
    return database.transaction(async (transaction) => {
      const current = await lockedState(transaction);
      if (current === null) {
        throw new ProductionInitializationConflictError(
          "Production initialization has not been claimed",
        );
      }
      assertDocument(current, documentSha256);
      if (current.phase === "complete") {
        return current;
      }
      await operation(transaction);
      const rows = await transaction
        .update(productionInitialization)
        .set({ completedAt: sql`now()`, phase: "complete", updatedAt: sql`now()` })
        .where(
          and(
            eq(productionInitialization.singletonId, 1),
            eq(productionInitialization.documentSha256, documentSha256),
            eq(productionInitialization.phase, "claimed"),
          ),
        )
        .returning({
          documentSha256: productionInitialization.documentSha256,
          phase: productionInitialization.phase,
          schemaVersion: productionInitialization.schemaVersion,
        });
      const updated = rows[0];
      if (updated === undefined) {
        throw new ProductionInitializationConflictError(
          "Production initialization phase changed unexpectedly",
        );
      }
      return toState(updated);
    });
  }

  return Object.freeze({
    claim,
    completeWith,
    requireComplete,
  });
}

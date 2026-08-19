import { sql } from "drizzle-orm";
import { check, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const productionInitialization = pgTable(
  "production_initialization",
  {
    singletonId: integer("singleton_id").primaryKey(),
    schemaVersion: integer("schema_version").notNull(),
    documentSha256: text("document_sha256").notNull(),
    phase: text("phase").notNull(),
    createdAt: timestamp("created_at", { precision: 3, withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { precision: 3, withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp("completed_at", { precision: 3, withTimezone: true }),
  },
  (table) => [
    check("production_initialization_singleton_check", sql`${table.singletonId} = 1`),
    check("production_initialization_schema_check", sql`${table.schemaVersion} = 1`),
    check("production_initialization_hash_check", sql`${table.documentSha256} ~ '^[a-f0-9]{64}$'`),
    check(
      "production_initialization_phase_check",
      sql`${table.phase} IN ('claimed', 'identity-complete', 'complete')`,
    ),
    check(
      "production_initialization_lifecycle_check",
      sql`(${table.phase} = 'complete' AND ${table.completedAt} IS NOT NULL)
        OR (${table.phase} <> 'complete' AND ${table.completedAt} IS NULL)`,
    ),
    check(
      "production_initialization_timestamps_check",
      sql`${table.updatedAt} >= ${table.createdAt}
        AND (${table.completedAt} IS NULL OR ${table.completedAt} >= ${table.createdAt})`,
    ),
  ],
);

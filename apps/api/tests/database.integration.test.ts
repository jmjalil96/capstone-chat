import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApplication } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { migrateDatabase, migrationsFolder } from "../src/database/migrate.js";
import { createDatabasePool } from "../src/database/pool.js";

const productTableNames = [
  "account",
  "conversations",
  "drafts",
  "employee_approvals",
  "messages",
  "rate_limit",
  "session",
  "user",
  "verification",
  "workspace_memberships",
  "workspaces",
] as const;

function databaseUrlFor(baseUrl: string, databaseName: string): string {
  const parsed = new URL(baseUrl);
  parsed.pathname = `/${databaseName}`;
  return parsed.href;
}

describe("PostgreSQL application schema", () => {
  let container: StartedPostgreSqlContainer | undefined;
  let databaseUrl: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:18.4-alpine")
      .withDatabase("capstone_foundation")
      .withUsername("capstone")
      .withPassword("capstone-test-password")
      .start();
    databaseUrl = container.getConnectionUri();
  });

  afterAll(async () => {
    if (container !== undefined) {
      await container.stop();
    }
  });

  it("applies the complete migration history to a clean database", async () => {
    await migrateDatabase(databaseUrl);
    const verificationPool = new Pool({ connectionString: databaseUrl });

    try {
      const migrationTable = await verificationPool.query<{ migrationTable: string | null }>(
        "SELECT to_regclass('drizzle.__drizzle_migrations')::text AS \"migrationTable\"",
      );
      const productTables = await verificationPool.query<{ tableName: string }>(
        "SELECT table_name AS \"tableName\" FROM information_schema.tables WHERE table_schema = 'public'",
      );

      expect(migrationTable.rows[0]?.migrationTable).toBe("drizzle.__drizzle_migrations");
      expect(productTables.rows.map(({ tableName }) => tableName).sort()).toEqual(
        productTableNames,
      );
    } finally {
      await verificationPool.end();
    }
  });

  it("upgrades the exact empty Phase 1 migration state and remains retry-safe", async () => {
    const phaseOneDatabaseName = "capstone_phase_one_upgrade";
    const phaseOneDatabaseUrl = databaseUrlFor(databaseUrl, phaseOneDatabaseName);
    const administrativePool = new Pool({ connectionString: databaseUrl });

    try {
      await administrativePool.query(`CREATE DATABASE "${phaseOneDatabaseName}"`);
    } finally {
      await administrativePool.end();
    }

    const phaseOnePool = new Pool({ connectionString: phaseOneDatabaseUrl });
    try {
      await phaseOnePool.query("CREATE SCHEMA drizzle");
      await phaseOnePool.query(`
        CREATE TABLE drizzle.__drizzle_migrations (
          id SERIAL PRIMARY KEY,
          hash text NOT NULL,
          created_at bigint
        )
      `);
      const productTablesBeforeUpgrade = await phaseOnePool.query<{ tableName: string }>(
        "SELECT table_name AS \"tableName\" FROM information_schema.tables WHERE table_schema = 'public'",
      );
      expect(productTablesBeforeUpgrade.rows).toEqual([]);
    } finally {
      await phaseOnePool.end();
    }

    await migrateDatabase(phaseOneDatabaseUrl);
    await migrateDatabase(phaseOneDatabaseUrl);

    const verificationPool = new Pool({ connectionString: phaseOneDatabaseUrl });
    try {
      const appliedMigrations = await verificationPool.query<{
        createdAt: string;
        hash: string;
      }>('SELECT created_at::text AS "createdAt", hash FROM drizzle.__drizzle_migrations');
      const productTables = await verificationPool.query<{ tableName: string }>(
        "SELECT table_name AS \"tableName\" FROM information_schema.tables WHERE table_schema = 'public'",
      );

      expect(appliedMigrations.rows).toHaveLength(2);
      expect(appliedMigrations.rows[0]?.hash).toMatch(/^[a-f0-9]{64}$/u);
      expect(Number(appliedMigrations.rows[0]?.createdAt)).toBeGreaterThan(0);
      expect(productTables.rows.map(({ tableName }) => tableName).sort()).toEqual(
        productTableNames,
      );
    } finally {
      await verificationPool.end();
    }
  });

  it("upgrades the exact accepted Phase 2 schema without changing its data", async () => {
    const databaseName = "capstone_phase_two_upgrade";
    const upgradeUrl = databaseUrlFor(databaseUrl, databaseName);
    const administrativePool = new Pool({ connectionString: databaseUrl });
    try {
      await administrativePool.query(`CREATE DATABASE "${databaseName}"`);
    } finally {
      await administrativePool.end();
    }

    const phaseTwoSql = await readFile(
      resolve(migrationsFolder, "0000_bumpy_living_lightning.sql"),
      "utf8",
    );
    const phaseTwoPool = new Pool({ connectionString: upgradeUrl });
    try {
      for (const statement of phaseTwoSql.split("--> statement-breakpoint")) {
        if (statement.trim() !== "") {
          await phaseTwoPool.query(statement);
        }
      }
      await phaseTwoPool.query("CREATE SCHEMA drizzle");
      await phaseTwoPool.query(`
        CREATE TABLE drizzle.__drizzle_migrations (
          id SERIAL PRIMARY KEY,
          hash text NOT NULL,
          created_at bigint
        )
      `);
      await phaseTwoPool.query(
        "INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)",
        [createHash("sha256").update(phaseTwoSql).digest("hex"), "1786061111713"],
      );
      await phaseTwoPool.query(
        "INSERT INTO workspaces (identity, display_name) VALUES ('phase-two-preserved', 'Phase Two Preserved')",
      );
    } finally {
      await phaseTwoPool.end();
    }

    await migrateDatabase(upgradeUrl);
    await migrateDatabase(upgradeUrl);

    const verificationPool = new Pool({ connectionString: upgradeUrl });
    try {
      const migrations = await verificationPool.query(
        "SELECT hash FROM drizzle.__drizzle_migrations ORDER BY created_at",
      );
      const workspace = await verificationPool.query<{ displayName: string }>(
        "SELECT display_name AS \"displayName\" FROM workspaces WHERE identity = 'phase-two-preserved'",
      );
      const phaseThreeTables = await verificationPool.query<{ tableName: string }>(
        "SELECT table_name AS \"tableName\" FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('conversations', 'drafts', 'messages') ORDER BY table_name",
      );

      expect(migrations.rows).toHaveLength(2);
      expect(workspace.rows).toEqual([{ displayName: "Phase Two Preserved" }]);
      expect(phaseThreeTables.rows.map((row) => row.tableName)).toEqual([
        "conversations",
        "drafts",
        "messages",
      ]);
    } finally {
      await verificationPool.end();
    }
  });

  it("installs the reviewed constraints, generated search columns, and indexes", async () => {
    const verificationPool = new Pool({ connectionString: databaseUrl });
    try {
      const extension = await verificationPool.query<{ installed: boolean }>(
        "SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'unaccent') AS installed",
      );
      const constraints = await verificationPool.query<{ name: string; definition: string }>(`
        SELECT conname AS name, pg_get_constraintdef(oid) AS definition
        FROM pg_constraint
        WHERE conname IN (
          'conversations_same_conversation_selected_leaf_fk',
          'drafts_owned_conversation_fk',
          'messages_same_conversation_parent_fk'
        )
        ORDER BY conname
      `);
      const generatedColumns = await verificationPool.query<{
        columnName: string;
        generated: string;
      }>(`
        SELECT column_name AS "columnName", is_generated AS generated
        FROM information_schema.columns
        WHERE (table_name, column_name) IN (
          ('conversations', 'title_search_vector'),
          ('messages', 'content_search_vector')
        )
        ORDER BY column_name
      `);
      const indexes = await verificationPool.query<{ indexName: string }>(`
        SELECT indexname AS "indexName"
        FROM pg_indexes
        WHERE schemaname = 'public' AND indexname IN (
          'conversations_owner_active_history_idx',
          'conversations_owner_archived_history_idx',
          'conversations_owner_id_unique',
          'conversations_title_search_idx',
          'drafts_conversation_scope_unique',
          'drafts_new_chat_scope_unique',
          'messages_content_search_idx',
          'messages_parent_idx'
        )
        ORDER BY indexname
      `);
      const precision = await verificationPool.query<{ precision: number }>(`
        SELECT datetime_precision AS precision
        FROM information_schema.columns
        WHERE table_name = 'conversations' AND column_name = 'updated_at'
      `);

      expect(extension.rows[0]?.installed).toBe(true);
      expect(constraints.rows.map((row) => row.name)).toEqual([
        "conversations_same_conversation_selected_leaf_fk",
        "drafts_owned_conversation_fk",
        "messages_same_conversation_parent_fk",
      ]);
      expect(constraints.rows[0]?.definition).toContain("DEFERRABLE INITIALLY DEFERRED");
      expect(generatedColumns.rows).toEqual([
        { columnName: "content_search_vector", generated: "ALWAYS" },
        { columnName: "title_search_vector", generated: "ALWAYS" },
      ]);
      expect(indexes.rows).toHaveLength(8);
      expect(precision.rows).toEqual([{ precision: 3 }]);
    } finally {
      await verificationPool.end();
    }
  });

  it("keeps the Phase 3 migration additive for the expand-contract release", async () => {
    const migrationFiles = (await readdir(migrationsFolder))
      .filter((fileName) => fileName.endsWith(".sql"))
      .sort();
    const migrationSql = (
      await Promise.all(
        migrationFiles.map((fileName) => readFile(resolve(migrationsFolder, fileName), "utf8")),
      )
    ).join("\n");

    expect(migrationFiles.length).toBeGreaterThan(0);
    expect(migrationSql).toMatch(/\bCREATE (?:TABLE|TYPE)\b/iu);
    expect(migrationSql).not.toMatch(/\b(?:DELETE\s+FROM|DROP|TRUNCATE)\b/iu);
  });

  it("keeps liveness healthy when PostgreSQL becomes unavailable", async () => {
    const pool = createDatabasePool(databaseUrl);
    const application = createApplication(
      loadConfig({ DATABASE_URL: databaseUrl, NODE_ENV: "test" }),
      { pool },
    );

    await application.server.ready();
    await expect(application.lifecycle.initialize()).resolves.toEqual({
      database: "up",
      status: "ready",
    });

    const ready = await application.server.inject({ method: "GET", url: "/api/health/ready" });
    expect(ready.statusCode).toBe(200);

    const runningContainer = container;
    if (runningContainer === undefined) {
      throw new Error("PostgreSQL container was not started");
    }
    await runningContainer.stop();
    container = undefined;

    const live = await application.server.inject({ method: "GET", url: "/api/health/live" });
    const unavailable = await application.server.inject({
      method: "GET",
      url: "/api/health/ready",
    });

    expect(live.statusCode).toBe(200);
    expect(live.json()).toEqual({ status: "live" });
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.json()).toEqual({ database: "down", status: "unavailable" });

    await application.shutdown();
  });
});

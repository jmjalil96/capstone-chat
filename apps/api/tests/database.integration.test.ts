import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApplication } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { migrateDatabase, migrationsFolder } from "../src/database/migrate.js";
import { createDatabasePool } from "../src/database/pool.js";

const identityTableNames = [
  "account",
  "employee_approvals",
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

describe("PostgreSQL identity schema", () => {
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
        identityTableNames,
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

      expect(appliedMigrations.rows).toHaveLength(1);
      expect(appliedMigrations.rows[0]?.hash).toMatch(/^[a-f0-9]{64}$/u);
      expect(Number(appliedMigrations.rows[0]?.createdAt)).toBeGreaterThan(0);
      expect(productTables.rows.map(({ tableName }) => tableName).sort()).toEqual(
        identityTableNames,
      );
    } finally {
      await verificationPool.end();
    }
  });

  it("keeps the Phase 2 migration additive for the expand-contract release", async () => {
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

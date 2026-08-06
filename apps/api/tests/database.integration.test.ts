import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApplication } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { migrateDatabase } from "../src/database/migrate.js";
import { createDatabasePool } from "../src/database/pool.js";

describe("PostgreSQL foundation", () => {
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

  it("applies the complete empty migration history to a clean database", async () => {
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
      expect(productTables.rows).toEqual([]);
    } finally {
      await verificationPool.end();
    }
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

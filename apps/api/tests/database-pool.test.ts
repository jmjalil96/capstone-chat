import { describe, expect, it } from "vitest";
import { createDatabasePool, createMigrationPool } from "../src/database/pool.js";

const databaseUrl = "postgresql://capstone:secret@database.invalid:5432/capstone";

describe("database pools", () => {
  it("bounds application statements and transactions without constraining migrations", async () => {
    const applicationPool = createDatabasePool(databaseUrl);
    const migrationPool = createMigrationPool(databaseUrl);

    try {
      expect(applicationPool.options).toMatchObject({
        application_name: "capstone-chat-api",
        connectionTimeoutMillis: 5_000,
        idleTimeoutMillis: 30_000,
        max: 10,
        options:
          "-c jit=off -c statement_timeout=5000 -c lock_timeout=5000 -c idle_in_transaction_session_timeout=5000",
        query_timeout: 5_000,
      });
      expect(migrationPool.options).toMatchObject({
        application_name: "capstone-chat-migrations",
        connectionTimeoutMillis: 5_000,
        idleTimeoutMillis: 30_000,
        max: 1,
      });
      expect(migrationPool.options.options).toBeUndefined();
      expect(migrationPool.options.query_timeout).toBeUndefined();
    } finally {
      await Promise.all([applicationPool.end(), migrationPool.end()]);
    }
  });
});

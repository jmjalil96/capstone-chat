import { describe, expect, it } from "vitest";
import { createDatabasePool, createMigrationPool } from "../src/database/pool.js";

const databaseUrl = "postgresql://capstone:secret@database.invalid:5432/capstone";

describe("database pools", () => {
  it("keeps request query timeouts out of the migration runner", async () => {
    const applicationPool = createDatabasePool(databaseUrl);
    const migrationPool = createMigrationPool(databaseUrl);

    try {
      expect(applicationPool.options).toMatchObject({
        application_name: "capstone-chat-api",
        max: 10,
        options: "-c jit=off",
        query_timeout: 5_000,
      });
      expect(migrationPool.options).toMatchObject({
        application_name: "capstone-chat-migrations",
        max: 1,
      });
      expect(migrationPool.options.query_timeout).toBeUndefined();
    } finally {
      await Promise.all([applicationPool.end(), migrationPool.end()]);
    }
  });
});

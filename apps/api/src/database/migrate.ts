import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { Pool } from "pg";
import {
  loadMigrationManifest,
  migrationsFolder,
  verifyMigrationObjects,
  verifyMigrationPrefix,
} from "./migration-verification.js";
import { createMigrationPool } from "./pool.js";

export { migrationsFolder } from "./migration-verification.js";

export async function applyMigrations(pool: Pool): Promise<void> {
  const database = drizzle({ client: pool });
  await migrate(database, { migrationsFolder });
}

export async function migrateDatabase(databaseUrl: string): Promise<void> {
  const pool = createMigrationPool(databaseUrl);

  try {
    const manifest = await loadMigrationManifest();
    await verifyMigrationPrefix(pool, manifest);
    await applyMigrations(pool);
    await verifyMigrationObjects(pool, manifest);
  } finally {
    await pool.end();
  }
}

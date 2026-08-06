import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { Pool } from "pg";
import { createDatabasePool } from "./pool.js";

export const migrationsFolder = fileURLToPath(new URL("../../migrations", import.meta.url));

export async function applyMigrations(pool: Pool): Promise<void> {
  const database = drizzle({ client: pool });
  await migrate(database, { migrationsFolder });
}

export async function migrateDatabase(databaseUrl: string): Promise<void> {
  const pool = createDatabasePool(databaseUrl);

  try {
    await applyMigrations(pool);
  } finally {
    await pool.end();
  }
}

import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";
import * as schema from "./schema.js";

export type AppDatabase = NodePgDatabase<typeof schema>;
export type AppTransaction = Parameters<Parameters<AppDatabase["transaction"]>[0]>[0];
export type AppDatabaseExecutor = AppDatabase | AppTransaction;

export function createDatabase(pool: Pool): AppDatabase {
  return drizzle({ client: pool, schema });
}

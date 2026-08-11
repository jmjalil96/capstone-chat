import type { SQL } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Pool, QueryResult, QueryResultRow } from "pg";
import * as schema from "./schema.js";

export type AppDatabase = NodePgDatabase<typeof schema>;
export type AppTransaction = Parameters<Parameters<AppDatabase["transaction"]>[0]>[0];
export type AppDatabaseExecutor = AppDatabase | AppTransaction;

export function createDatabase(pool: Pool): AppDatabase {
  return drizzle({ client: pool, schema });
}

export async function executePrepared<TRow extends QueryResultRow>(
  transaction: AppTransaction,
  name: string,
  statement: SQL,
): Promise<QueryResult<TRow>> {
  // Raw SQL execution is unnamed by default. These versioned names let PostgreSQL reuse the plan
  // for the few stable statements inside the workspace admission lock without changing the SQL.
  const query = transaction.execute(statement).getQuery();
  const prepared = transaction._.session.prepareQuery(
    query,
    undefined,
    name,
    false,
    undefined,
    undefined,
  );
  return (await prepared.execute()) as QueryResult<TRow>;
}

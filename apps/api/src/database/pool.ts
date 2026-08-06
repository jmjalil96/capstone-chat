import { Pool } from "pg";

const poolLimits = {
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 30_000,
  max: 10,
  query_timeout: 5_000,
} as const;

export interface DatabasePool {
  end(): Promise<void>;
  query(queryText: string): Promise<unknown>;
}

export function createDatabasePool(
  databaseUrl: string,
  onIdleError: (error: Error) => void = () => undefined,
): Pool {
  const pool = new Pool({
    application_name: "capstone-chat-api",
    connectionString: databaseUrl,
    ...poolLimits,
  });

  pool.on("error", onIdleError);
  return pool;
}

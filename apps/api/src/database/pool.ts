import { Pool } from "pg";

const applicationPoolLimits = {
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 30_000,
  max: 10,
  // The bounded search query can cross PostgreSQL's JIT cost threshold even though compiling the
  // plan costs far more than executing it for this OLTP workload.
  options: "-c jit=off",
  query_timeout: 5_000,
} as const;

const migrationPoolLimits = {
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 30_000,
  max: 1,
} as const;

export interface DatabasePool {
  end(): Promise<void>;
  query(queryText: string): Promise<unknown>;
}

function createPool(
  options: ConstructorParameters<typeof Pool>[0],
  onIdleError: (error: Error) => void,
): Pool {
  const pool = new Pool(options);
  pool.on("error", onIdleError);
  return pool;
}

export function createDatabasePool(
  databaseUrl: string,
  onIdleError: (error: Error) => void = () => undefined,
): Pool {
  return createPool(
    {
      application_name: "capstone-chat-api",
      connectionString: databaseUrl,
      ...applicationPoolLimits,
    },
    onIdleError,
  );
}

export function createMigrationPool(databaseUrl: string): Pool {
  return createPool(
    {
      application_name: "capstone-chat-migrations",
      connectionString: databaseUrl,
      ...migrationPoolLimits,
    },
    () => undefined,
  );
}

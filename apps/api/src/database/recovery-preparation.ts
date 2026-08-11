import type { Pool, PoolClient, QueryResultRow } from "pg";
import { assertProductionDatabaseCredentialBoundary } from "./production-database-url.js";
import { RecoveryPreparationError, recoveryPreparationFailed } from "./recovery-error.js";
import {
  type MigrationObjectsEvidence,
  prepareAndVerifyMigrationObjects,
} from "./recovery-migrations.js";

export { assertProductionDatabaseCredentialBoundary, RecoveryPreparationError };

const expectedPostgresMajor = 18;
const expectedSessionSetting = "5s";
const managedVerificationRequired = [
  "backup-cadence-and-retention",
  "database-wide-source-ip-restriction",
  "provider-region-tier-and-storage-ceiling",
  "source-ip-denial-and-established-session-termination",
  "tls-hostname-ca-and-credential-denial",
] as const;

export interface RecoveryPreparationEvidence {
  readonly applicationRole: {
    readonly administrativeWorkDenied: true;
    readonly dataReadWriteVerified: true;
    readonly ddlDenied: true;
  };
  readonly migrationCount: number;
  readonly migrationRole: {
    readonly clusterAdministrationDenied: true;
    readonly schemaWorkVerified: true;
  };
  readonly objects: MigrationObjectsEvidence;
  readonly postgresMajor: 18;
  readonly sessionGuardsVerified: true;
  readonly tlsVerified: boolean;
}

export interface RecoveryPreparationCommandEvidence extends RecoveryPreparationEvidence {
  readonly managedVerificationRequired: typeof managedVerificationRequired;
  readonly outcome: "database-compatible";
}

interface SessionFactsRow extends QueryResultRow {
  readonly databaseName: string;
  readonly idleTransactionTimeout: string;
  readonly jit: string;
  readonly lockTimeout: string;
  readonly serverVersionNumber: string;
  readonly ssl: boolean;
  readonly statementTimeout: string;
  readonly userName: string;
}

interface ApplicationRoleRow extends QueryResultRow {
  readonly bypassesRowSecurity: boolean;
  readonly canCreateDatabaseObjects: boolean;
  readonly canCreatePublicObjects: boolean;
  readonly createsDatabases: boolean;
  readonly createsRoles: boolean;
  readonly hasAdministrativeMembership: boolean;
  readonly isMigrationRoleMember: boolean;
  readonly ownsExtension: boolean;
  readonly ownsProductTable: boolean;
  readonly replicates: boolean;
  readonly superuser: boolean;
}

interface MigrationRoleRow extends QueryResultRow {
  readonly bypassesRowSecurity: boolean;
  readonly createsDatabases: boolean;
  readonly createsRoles: boolean;
  readonly hasAdministrativeMembership: boolean;
  readonly replicates: boolean;
  readonly superuser: boolean;
}

function postgresMajor(serverVersionNumber: string): 18 {
  const versionNumber = Number(serverVersionNumber);
  if (
    !Number.isSafeInteger(versionNumber) ||
    versionNumber < expectedPostgresMajor * 10_000 ||
    versionNumber >= (expectedPostgresMajor + 1) * 10_000
  ) {
    recoveryPreparationFailed("Restored database must run the approved PostgreSQL major version");
  }
  return expectedPostgresMajor;
}

async function sessionFacts(pool: Pool): Promise<SessionFactsRow> {
  const result = await pool.query<SessionFactsRow>(`
    SELECT
      current_database() AS "databaseName",
      current_user AS "userName",
      current_setting('server_version_num') AS "serverVersionNumber",
      current_setting('jit') AS jit,
      current_setting('statement_timeout') AS "statementTimeout",
      current_setting('lock_timeout') AS "lockTimeout",
      current_setting('idle_in_transaction_session_timeout') AS "idleTransactionTimeout",
      COALESCE(
        (SELECT connection.ssl FROM pg_catalog.pg_stat_ssl AS connection
          WHERE connection.pid = pg_backend_pid()),
        false
      ) AS ssl
  `);
  const row = result.rows[0];
  if (row === undefined) {
    recoveryPreparationFailed("Database session facts are unavailable");
  }
  return row;
}

function assertApplicationSessionGuards(facts: SessionFactsRow): void {
  if (
    facts.jit !== "off" ||
    facts.statementTimeout !== expectedSessionSetting ||
    facts.lockTimeout !== expectedSessionSetting ||
    facts.idleTransactionTimeout !== expectedSessionSetting
  ) {
    recoveryPreparationFailed("Application database session guards are unavailable");
  }
}

async function verifyMigrationRole(pool: Pool): Promise<void> {
  const result = await pool.query<MigrationRoleRow>(`
    SELECT
      role.rolsuper AS superuser,
      role.rolcreaterole AS "createsRoles",
      role.rolcreatedb AS "createsDatabases",
      role.rolreplication AS replicates,
      role.rolbypassrls AS "bypassesRowSecurity",
      EXISTS (
        SELECT 1
        FROM pg_catalog.pg_roles AS granted_role
        WHERE (
            granted_role.rolsuper OR granted_role.rolcreaterole OR
            granted_role.rolcreatedb OR granted_role.rolreplication OR
            granted_role.rolbypassrls
          )
          AND pg_has_role(current_user, granted_role.oid, 'USAGE')
      ) AS "hasAdministrativeMembership"
    FROM pg_catalog.pg_roles AS role
    WHERE role.rolname = current_user
  `);
  const role = result.rows[0];
  if (
    role === undefined ||
    role.superuser ||
    role.createsRoles ||
    role.createsDatabases ||
    role.replicates ||
    role.bypassesRowSecurity ||
    role.hasAdministrativeMembership
  ) {
    recoveryPreparationFailed("Migration role has prohibited cluster-administration privileges");
  }
}

async function expectedDenial(client: PoolClient, statement: string): Promise<void> {
  await client.query("BEGIN");
  let denied = false;
  try {
    await client.query(statement);
  } catch (error: unknown) {
    denied =
      typeof error === "object" && error !== null && "code" in error && error.code === "42501";
    if (!denied) {
      await client.query("ROLLBACK");
      recoveryPreparationFailed(
        "Application administrative denial probe failed unexpectedly",
        error,
      );
    }
  }
  await client.query("ROLLBACK");
  if (!denied) {
    recoveryPreparationFailed("Application role can perform prohibited database DDL");
  }
}

async function verifyApplicationReadWrite(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT count(*) FROM public.workspaces");
    const inserted = await client.query<{ id: string }>(`
      INSERT INTO public.operational_recovery_markers (kind)
      VALUES ('pre')
      RETURNING id
    `);
    const id = inserted.rows[0]?.id;
    if (id === undefined) {
      recoveryPreparationFailed("Application write verification returned no row");
    }
    await client.query(
      "UPDATE public.operational_recovery_markers SET kind = 'post' WHERE id = $1",
      [id],
    );
    await client.query("DELETE FROM public.operational_recovery_markers WHERE id = $1", [id]);
    await client.query("ROLLBACK");

    await expectedDenial(
      client,
      "CREATE TABLE public.capstone_application_role_ddl_probe (id integer PRIMARY KEY)",
    );
    await expectedDenial(
      client,
      "ALTER TABLE public.workspaces ADD COLUMN capstone_application_role_ddl_probe integer",
    );
    await expectedDenial(client, "CREATE ROLE capstone_application_role_admin_probe");
    await expectedDenial(
      client,
      "COMMENT ON EXTENSION unaccent IS 'capstone application role probe'",
    );
  } catch (error: unknown) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (error instanceof RecoveryPreparationError) {
      throw error;
    }
    recoveryPreparationFailed("Application role cannot perform required data transactions", error);
  } finally {
    client.release();
  }
}

async function verifyApplicationRole(applicationPool: Pool, migrationRole: string): Promise<void> {
  const result = await applicationPool.query<ApplicationRoleRow>(
    `
      SELECT
        role.rolsuper AS superuser,
        role.rolcreaterole AS "createsRoles",
        role.rolcreatedb AS "createsDatabases",
        role.rolreplication AS replicates,
        role.rolbypassrls AS "bypassesRowSecurity",
        EXISTS (
          SELECT 1
          FROM pg_catalog.pg_roles AS granted_role
          WHERE (
              granted_role.rolsuper OR granted_role.rolcreaterole OR
              granted_role.rolcreatedb OR granted_role.rolreplication OR
              granted_role.rolbypassrls
            )
            AND pg_has_role(current_user, granted_role.oid, 'USAGE')
        ) AS "hasAdministrativeMembership",
        has_database_privilege(current_user, current_database(), 'CREATE')
          AS "canCreateDatabaseObjects",
        has_schema_privilege(current_user, 'public', 'CREATE') AS "canCreatePublicObjects",
        pg_has_role(current_user, $1::text, 'MEMBER') AS "isMigrationRoleMember",
        EXISTS (
          SELECT 1
          FROM pg_catalog.pg_extension AS extension
          WHERE extension.extname = 'unaccent'
            AND pg_has_role(current_user, extension.extowner, 'USAGE')
        ) AS "ownsExtension",
        EXISTS (
          SELECT 1
          FROM pg_catalog.pg_class AS relation
          INNER JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
          WHERE namespace.nspname = 'public'
            AND relation.relkind IN ('r', 'p')
            AND pg_has_role(current_user, relation.relowner, 'USAGE')
        ) AS "ownsProductTable"
      FROM pg_catalog.pg_roles AS role
      WHERE role.rolname = current_user
    `,
    [migrationRole],
  );
  const role = result.rows[0];
  if (
    role === undefined ||
    role.superuser ||
    role.createsRoles ||
    role.createsDatabases ||
    role.replicates ||
    role.bypassesRowSecurity ||
    role.hasAdministrativeMembership ||
    role.canCreateDatabaseObjects ||
    role.canCreatePublicObjects ||
    role.isMigrationRoleMember ||
    role.ownsExtension ||
    role.ownsProductTable
  ) {
    recoveryPreparationFailed(
      "Application role has prohibited ownership or administrative privileges",
    );
  }
  await verifyApplicationReadWrite(applicationPool);
}

export async function prepareRestoredDatabase(
  migrationPool: Pool,
  applicationPool: Pool,
  options: { readonly requireTls: boolean },
): Promise<RecoveryPreparationEvidence> {
  const migrationFacts = await sessionFacts(migrationPool);
  const major = postgresMajor(migrationFacts.serverVersionNumber);
  if (options.requireTls && !migrationFacts.ssl) {
    recoveryPreparationFailed("Migration connection is not protected by TLS");
  }
  await verifyMigrationRole(migrationPool);
  const migration = await prepareAndVerifyMigrationObjects(migrationPool);

  const applicationFacts = await sessionFacts(applicationPool);
  postgresMajor(applicationFacts.serverVersionNumber);
  if (
    applicationFacts.databaseName !== migrationFacts.databaseName ||
    applicationFacts.userName === migrationFacts.userName
  ) {
    recoveryPreparationFailed(
      "Application and migration sessions do not use the required credential boundary",
    );
  }
  if (options.requireTls && !applicationFacts.ssl) {
    recoveryPreparationFailed("Application connection is not protected by TLS");
  }
  assertApplicationSessionGuards(applicationFacts);
  await verifyApplicationRole(applicationPool, migrationFacts.userName);

  return Object.freeze({
    applicationRole: Object.freeze({
      administrativeWorkDenied: true,
      dataReadWriteVerified: true,
      ddlDenied: true,
    }),
    migrationCount: migration.migrationCount,
    migrationRole: Object.freeze({
      clusterAdministrationDenied: true,
      schemaWorkVerified: true,
    }),
    objects: migration.objects,
    postgresMajor: major,
    sessionGuardsVerified: true,
    tlsVerified: options.requireTls,
  });
}

export function toRecoveryPreparationCommandEvidence(
  evidence: RecoveryPreparationEvidence,
): RecoveryPreparationCommandEvidence {
  return Object.freeze({
    ...evidence,
    managedVerificationRequired,
    outcome: "database-compatible",
  });
}

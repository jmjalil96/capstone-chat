import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabasePool, createMigrationPool } from "../src/database/pool.js";
import {
  prepareRestoredDatabase,
  RecoveryPreparationError,
  type RecoveryPreparationEvidence,
} from "../src/database/recovery-preparation.js";

function roleDatabaseUrl(baseUrl: string, username: string, password: string): string {
  const url = new URL(baseUrl);
  url.username = username;
  url.password = password;
  return url.href;
}

describe.sequential("restored PostgreSQL branch preparation", () => {
  let applicationPool: Pool;
  let container: StartedPostgreSqlContainer;
  let evidence: RecoveryPreparationEvidence;
  let migrationPool: Pool;
  let ownerUrl: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:18.4-alpine")
      .withDatabase("capstone_recovery")
      .withUsername("capstone_owner")
      .withPassword("owner-test-password")
      .start();
    ownerUrl = container.getConnectionUri();
    const ownerPool = new Pool({ connectionString: ownerUrl });
    try {
      await ownerPool.query(`
        CREATE ROLE capstone_migration LOGIN PASSWORD 'migration-test-password';
        CREATE ROLE capstone_application LOGIN PASSWORD 'application-test-password';
        GRANT CONNECT, CREATE ON DATABASE capstone_recovery TO capstone_migration;
        GRANT USAGE, CREATE ON SCHEMA public TO capstone_migration;
        GRANT pg_read_all_data, pg_write_all_data TO capstone_application;
      `);
    } finally {
      await ownerPool.end();
    }

    migrationPool = createMigrationPool(
      roleDatabaseUrl(ownerUrl, "capstone_migration", "migration-test-password"),
    );
    applicationPool = createDatabasePool(
      roleDatabaseUrl(ownerUrl, "capstone_application", "application-test-password"),
    );
    evidence = await prepareRestoredDatabase(migrationPool, applicationPool, {
      requireTls: false,
    });
  }, 120_000);

  afterAll(async () => {
    await Promise.all([applicationPool?.end(), migrationPool?.end()]);
    await container?.stop();
  });

  it("applies the full history with a narrow migration role and verifies the runtime role", () => {
    expect(evidence).toMatchObject({
      applicationRole: {
        administrativeWorkDenied: true,
        dataReadWriteVerified: true,
        ddlDenied: true,
      },
      migrationCount: 7,
      migrationRole: {
        clusterAdministrationDenied: true,
        schemaWorkVerified: true,
      },
      postgresMajor: 18,
      sessionGuardsVerified: true,
      tlsVerified: false,
    });
    expect(evidence.objects).toMatchObject({ functions: 1, tables: 20 });
    expect(evidence.objects.constraints).toBeGreaterThan(20);
    expect(evidence.objects.indexes).toBeGreaterThan(20);
  });

  it("remains idempotent and repairs the explicitly recoverable manual indexes", async () => {
    await migrationPool.query(`
      DROP INDEX public.conversations_title_search_idx;
      DROP INDEX public.messages_content_search_idx;
      DROP INDEX public.generations_conversation_idx;
    `);

    const repeated = await prepareRestoredDatabase(migrationPool, applicationPool, {
      requireTls: false,
    });

    expect(repeated).toEqual(evidence);
  });

  it("fails closed when a named critical index has the wrong definition", async () => {
    await migrationPool.query(`
      DROP INDEX public.generations_conversation_idx;
      CREATE INDEX generations_conversation_idx ON public.generations USING btree (id);
    `);
    try {
      await expect(
        prepareRestoredDatabase(migrationPool, applicationPool, { requireTls: false }),
      ).rejects.toBeInstanceOf(RecoveryPreparationError);
    } finally {
      await migrationPool.query("DROP INDEX public.generations_conversation_idx");
      await prepareRestoredDatabase(migrationPool, applicationPool, { requireTls: false });
    }
  });

  it("rejects an administrative credential at the application boundary", async () => {
    const administrativeApplicationPool = createDatabasePool(container.getConnectionUri());
    try {
      await expect(
        prepareRestoredDatabase(migrationPool, administrativeApplicationPool, {
          requireTls: false,
        }),
      ).rejects.toBeInstanceOf(RecoveryPreparationError);
    } finally {
      await administrativeApplicationPool.end();
    }
  });

  it("rejects application membership in an administrative role", async () => {
    const ownerPool = new Pool({ connectionString: ownerUrl });
    try {
      await ownerPool.query(`
        CREATE ROLE capstone_recovery_admin_membership CREATEROLE;
        GRANT capstone_recovery_admin_membership TO capstone_application;
      `);
      await expect(
        prepareRestoredDatabase(migrationPool, applicationPool, { requireTls: false }),
      ).rejects.toBeInstanceOf(RecoveryPreparationError);
    } finally {
      await ownerPool.query(`
        REVOKE capstone_recovery_admin_membership FROM capstone_application;
        DROP ROLE capstone_recovery_admin_membership;
      `);
      await ownerPool.end();
    }
  });

  it("rejects the default administrative credential at the migration boundary", async () => {
    const administrativeMigrationPool = createMigrationPool(container.getConnectionUri());
    try {
      await expect(
        prepareRestoredDatabase(administrativeMigrationPool, applicationPool, {
          requireTls: false,
        }),
      ).rejects.toBeInstanceOf(RecoveryPreparationError);
    } finally {
      await administrativeMigrationPool.end();
    }
  });
});

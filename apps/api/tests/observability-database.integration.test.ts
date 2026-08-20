import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDatabase } from "../src/database/database.js";
import { migrateDatabase, migrationsFolder } from "../src/database/migrate.js";
import { createDatabasePool } from "../src/database/pool.js";
import {
  CLIENT_ERROR_GLOBAL_LIMIT_PER_MINUTE,
  CLIENT_ERROR_IP_LIMIT_PER_MINUTE,
  CLIENT_ERROR_STALE_CLEANUP_LIMIT,
  createClientErrorRateLimiter,
} from "../src/observability/client-error-rate-limit.js";
import { createRecoveryMarkerService } from "../src/operations/recovery-markers.js";

const hashSecret = "phase-eight-client-error-rate-limit-test-secret";
const now = new Date("2026-08-08T12:00:30.000Z");

function databaseUrlFor(baseUrl: string, databaseName: string): string {
  const parsed = new URL(baseUrl);
  parsed.pathname = `/${databaseName}`;
  return parsed.href;
}

async function applyMigrationSql(pool: Pool, migrationSql: string): Promise<void> {
  for (const statement of migrationSql.split("--> statement-breakpoint")) {
    if (statement.trim() !== "") {
      await pool.query(statement);
    }
  }
}

describe("Phase 8 PostgreSQL operational state", () => {
  let container: StartedPostgreSqlContainer | undefined;
  let pool: Pool;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:18.4-alpine")
      .withDatabase("capstone_observability")
      .withUsername("capstone")
      .withPassword("capstone-test-password")
      .start();
    const databaseUrl = container.getConnectionUri();
    await migrateDatabase(databaseUrl);
    pool = createDatabasePool(databaseUrl);
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE client_error_rate_limit_windows, operational_recovery_markers");
  });

  it("upgrades a nonempty Phase 7 database without changing its data", async () => {
    const databaseName = "capstone_exact_phase_seven";
    const upgradeUrl = databaseUrlFor(container?.getConnectionUri() ?? "", databaseName);
    const administrativePool = new Pool({ connectionString: container?.getConnectionUri() });
    await administrativePool.query(`CREATE DATABASE "${databaseName}"`);
    await administrativePool.end();

    const migrationNames = [
      "0000_bumpy_living_lightning.sql",
      "0001_conscious_giant_man.sql",
      "0002_great_serpent_society.sql",
      "0003_openrouter_cost_control.sql",
      "0004_compaction_administration.sql",
    ] as const;
    const migrationTimes = [
      1786061111713, 1786071863036, 1786119062299, 1786205271465, 1786219479071,
    ] as const;
    const migrationSql = await Promise.all(
      migrationNames.map((name) => readFile(resolve(migrationsFolder, name), "utf8")),
    );
    const phaseSevenPool = new Pool({ connectionString: upgradeUrl });
    let acceptedData: Record<string, unknown> | undefined;
    try {
      for (const sql of migrationSql) {
        await applyMigrationSql(phaseSevenPool, sql);
      }
      await phaseSevenPool.query("CREATE SCHEMA drizzle");
      await phaseSevenPool.query(`
        CREATE TABLE drizzle.__drizzle_migrations (
          id SERIAL PRIMARY KEY,
          hash text NOT NULL,
          created_at bigint
        )
      `);
      for (const [index, sql] of migrationSql.entries()) {
        await phaseSevenPool.query(
          "INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)",
          [createHash("sha256").update(sql).digest("hex"), migrationTimes[index]],
        );
      }
      await phaseSevenPool.query(`
        INSERT INTO workspaces (id, identity, display_name)
        VALUES ('70000000-0000-4000-8000-000000000001', 'phase-seven-exact', 'Phase Seven')
      `);
      await phaseSevenPool.query(`
        INSERT INTO "user" (id, name, email, email_verified)
        VALUES ('phase-seven-exact-user', 'Phase Seven', 'phase-seven@example.test', true)
      `);
      await phaseSevenPool.query(`
        INSERT INTO workspace_memberships (
          id, workspace_id, user_id, role, status, monthly_soft_budget_usd,
          activated_at, created_at, updated_at
        ) VALUES (
          '70000000-0000-4000-8000-000000000002',
          '70000000-0000-4000-8000-000000000001',
          'phase-seven-exact-user',
          'admin',
          'active',
          12.340000000000000000,
          '2026-08-08T12:00:00.000Z',
          '2026-08-08T12:00:00.000Z',
          '2026-08-08T12:00:00.000Z'
        )
      `);
      acceptedData = (
        await phaseSevenPool.query<Record<string, unknown>>(`
          SELECT workspace.identity,
            membership.role::text AS role,
            membership.status::text AS status,
            membership.monthly_soft_budget_usd::text AS monthly_soft_budget
          FROM workspace_memberships AS membership
          INNER JOIN workspaces AS workspace ON workspace.id = membership.workspace_id
          WHERE membership.id = '70000000-0000-4000-8000-000000000002'
        `)
      ).rows[0];
    } finally {
      await phaseSevenPool.end();
    }

    await expect(migrateDatabase(upgradeUrl)).resolves.toBeUndefined();
    await expect(migrateDatabase(upgradeUrl)).resolves.toBeUndefined();

    const verificationPool = new Pool({ connectionString: upgradeUrl });
    try {
      const preserved = (
        await verificationPool.query<Record<string, unknown>>(`
          SELECT workspace.identity,
            membership.role::text AS role,
            membership.status::text AS status,
            membership.monthly_soft_budget_usd::text AS monthly_soft_budget
          FROM workspace_memberships AS membership
          INNER JOIN workspaces AS workspace ON workspace.id = membership.workspace_id
          WHERE membership.id = '70000000-0000-4000-8000-000000000002'
        `)
      ).rows[0];
      const installed = await verificationPool.query(`
        SELECT to_regclass('public.client_error_rate_limit_windows')::text AS rate_limits,
          to_regclass('public.operational_recovery_markers')::text AS recovery_markers
      `);
      const migrations = await verificationPool.query(
        "SELECT hash FROM drizzle.__drizzle_migrations ORDER BY created_at",
      );

      expect(preserved).toEqual(acceptedData);
      expect(installed.rows).toEqual([
        {
          rate_limits: "client_error_rate_limit_windows",
          recovery_markers: "operational_recovery_markers",
        },
      ]);
      expect(migrations.rows).toHaveLength(10);
    } finally {
      await verificationPool.end();
    }
  });

  it("upgrades a nonempty Phase 8 database while retaining its bounded lookup index", async () => {
    const databaseName = "capstone_exact_phase_eight";
    const upgradeUrl = databaseUrlFor(container?.getConnectionUri() ?? "", databaseName);
    const administrativePool = new Pool({ connectionString: container?.getConnectionUri() });
    await administrativePool.query(`CREATE DATABASE "${databaseName}"`);
    await administrativePool.end();

    const migrationNames = [
      "0000_bumpy_living_lightning.sql",
      "0001_conscious_giant_man.sql",
      "0002_great_serpent_society.sql",
      "0003_openrouter_cost_control.sql",
      "0004_compaction_administration.sql",
      "0005_observability_recovery.sql",
    ] as const;
    const migrationTimes = [
      1786061111713, 1786071863036, 1786119062299, 1786205271465, 1786219479071, 1786230000000,
    ] as const;
    const migrationSql = await Promise.all(
      migrationNames.map((name) => readFile(resolve(migrationsFolder, name), "utf8")),
    );
    const phaseEightPool = new Pool({ connectionString: upgradeUrl });
    try {
      for (const sql of migrationSql) {
        await applyMigrationSql(phaseEightPool, sql);
      }
      await phaseEightPool.query("CREATE SCHEMA drizzle");
      await phaseEightPool.query(`
        CREATE TABLE drizzle.__drizzle_migrations (
          id SERIAL PRIMARY KEY,
          hash text NOT NULL,
          created_at bigint
        )
      `);
      for (const [index, sql] of migrationSql.entries()) {
        await phaseEightPool.query(
          "INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)",
          [createHash("sha256").update(sql).digest("hex"), migrationTimes[index]],
        );
      }
      await phaseEightPool.query(`
        INSERT INTO workspaces (id, identity, display_name)
        VALUES ('80000000-0000-4000-8000-000000000001', 'phase-eight-exact', 'Phase Eight')
      `);
      await phaseEightPool.query(`
        INSERT INTO "user" (id, name, email, email_verified)
        VALUES ('phase-eight-exact-user', 'Phase Eight', 'phase-eight@example.test', true)
      `);
      await phaseEightPool.query(`
        INSERT INTO conversations (id, workspace_id, user_id, title)
        VALUES (
          '80000000-0000-4000-8000-000000000002',
          '80000000-0000-4000-8000-000000000001',
          'phase-eight-exact-user',
          'Historia preservada'
        )
      `);
      await phaseEightPool.query(`
        INSERT INTO messages (id, conversation_id, parent_message_id, role, content)
        VALUES
          (
            '80000000-0000-4000-8000-000000000003',
            '80000000-0000-4000-8000-000000000002',
            NULL,
            'user',
            '[{"type":"text","text":"Pregunta preservada"}]'::jsonb
          ),
          (
            '80000000-0000-4000-8000-000000000004',
            '80000000-0000-4000-8000-000000000002',
            '80000000-0000-4000-8000-000000000003',
            'assistant',
            '[{"type":"text","text":"Respuesta preservada"}]'::jsonb
          )
      `);
      await phaseEightPool.query(`
        INSERT INTO generations (
          id, workspace_id, user_id, conversation_id, assistant_message_id,
          idempotency_key, requested_tier, purpose, system_prompt_version,
          effective_parameters, status
        ) VALUES (
          '80000000-0000-4000-8000-000000000005',
          '80000000-0000-4000-8000-000000000001',
          'phase-eight-exact-user',
          '80000000-0000-4000-8000-000000000002',
          '80000000-0000-4000-8000-000000000004',
          '80000000-0000-4000-8000-000000000006',
          'balanced',
          'chat',
          'capstone-chat-v1',
          '{}'::jsonb,
          'active'
        )
      `);
    } finally {
      await phaseEightPool.end();
    }

    await expect(migrateDatabase(upgradeUrl)).resolves.toBeUndefined();
    await expect(migrateDatabase(upgradeUrl)).resolves.toBeUndefined();

    const verificationPool = new Pool({ connectionString: upgradeUrl });
    try {
      const preserved = await verificationPool.query(`
        SELECT conversation.title, generation.status::text AS status
        FROM generations AS generation
        INNER JOIN conversations AS conversation ON conversation.id = generation.conversation_id
        WHERE generation.id = '80000000-0000-4000-8000-000000000005'
      `);
      const index = await verificationPool.query<{ definition: string }>(`
        SELECT indexdef AS definition
        FROM pg_indexes
        WHERE schemaname = 'public' AND indexname = 'generations_conversation_idx'
      `);
      const migrations = await verificationPool.query(
        "SELECT hash FROM drizzle.__drizzle_migrations ORDER BY created_at",
      );

      expect(preserved.rows).toEqual([{ status: "active", title: "Historia preservada" }]);
      expect(index.rows).toHaveLength(1);
      expect(index.rows[0]?.definition).toContain("generations_conversation_idx");
      expect(migrations.rows).toHaveLength(10);
    } finally {
      await verificationPool.end();
    }
  });

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  it("enforces the client-address limit without retaining a raw address", async () => {
    const limiter = createClientErrorRateLimiter(createDatabase(pool), hashSecret, () => now);

    for (let index = 0; index < CLIENT_ERROR_IP_LIMIT_PER_MINUTE; index += 1) {
      await expect(limiter.allow("203.0.113.42")).resolves.toBe(true);
    }
    await expect(limiter.allow("203.0.113.42")).resolves.toBe(false);
    await expect(limiter.allow("203.0.113.43")).resolves.toBe(true);

    const rows = await pool.query<{
      keyHash: string;
      requestCount: number;
      scope: string;
    }>(`
      SELECT scope, key_hash AS "keyHash", request_count AS "requestCount"
      FROM client_error_rate_limit_windows
      ORDER BY scope, key_hash
    `);
    expect(rows.rows).toHaveLength(3);
    expect(rows.rows.every(({ keyHash }) => /^[a-f0-9]{64}$/u.test(keyHash))).toBe(true);
    expect(JSON.stringify(rows.rows)).not.toContain("203.0.113");
    expect(rows.rows.find(({ scope }) => scope === "global")?.requestCount).toBe(11);
  });

  it("enforces the global limit atomically without charging a rejected client", async () => {
    const limiter = createClientErrorRateLimiter(createDatabase(pool), hashSecret, () => now);
    const accepted = await Promise.all(
      Array.from({ length: CLIENT_ERROR_GLOBAL_LIMIT_PER_MINUTE }, (_, index) =>
        limiter.allow(`2001:db8:${index.toString(16)}::1`),
      ),
    );

    expect(accepted.every(Boolean)).toBe(true);
    await expect(limiter.allow("2001:db8:ffff::1")).resolves.toBe(false);

    const counts = await pool.query<{ count: string; scope: string }>(`
      SELECT scope, COUNT(*)::text AS count
      FROM client_error_rate_limit_windows
      GROUP BY scope
      ORDER BY scope
    `);
    expect(counts.rows).toEqual([
      { count: String(CLIENT_ERROR_GLOBAL_LIMIT_PER_MINUTE), scope: "client" },
      { count: "1", scope: "global" },
    ]);
    const global = await pool.query<{ requestCount: number }>(`
      SELECT request_count AS "requestCount"
      FROM client_error_rate_limit_windows
      WHERE scope = 'global'
    `);
    expect(global.rows[0]?.requestCount).toBe(CLIENT_ERROR_GLOBAL_LIMIT_PER_MINUTE);
  });

  it("rejects malformed addresses and bounds stale-window cleanup", async () => {
    const limiter = createClientErrorRateLimiter(createDatabase(pool), hashSecret, () => now);
    await expect(limiter.allow("203.0.113.5, 198.51.100.8")).resolves.toBe(false);

    await pool.query(
      `
        INSERT INTO client_error_rate_limit_windows (
          scope, key_hash, window_started_at, request_count, expires_at
        )
        SELECT
          'client',
          lpad(to_hex(candidate), 64, '0'),
          '2026-08-08T10:59:00Z'::timestamptz,
          1,
          '2026-08-08T11:00:00Z'::timestamptz
        FROM generate_series(1, 70) AS candidate
      `,
    );
    await expect(limiter.allow("198.51.100.10")).resolves.toBe(true);

    const stale = await pool.query<{ count: string }>(`
      SELECT COUNT(*)::text AS count
      FROM client_error_rate_limit_windows
      WHERE expires_at <= '2026-08-08T12:00:30Z'::timestamptz
    `);
    expect(stale.rows[0]?.count).toBe(String(70 - CLIENT_ERROR_STALE_CLEANUP_LIMIT));
  });

  it("creates, orders, and explicitly deletes content-free recovery markers", async () => {
    const markers = createRecoveryMarkerService(createDatabase(pool));
    const before = await markers.create("pre");
    await pool.query(
      "UPDATE operational_recovery_markers SET created_at = '2026-08-08T11:59:00Z'::timestamptz WHERE id = $1",
      [before.id],
    );
    const after = await markers.create("post");

    expect((await markers.list()).map(({ id, kind }) => ({ id, kind }))).toEqual([
      { id: after.id, kind: "post" },
      { id: before.id, kind: "pre" },
    ]);
    await expect(markers.delete(before.id)).resolves.toBe(true);
    await expect(markers.delete(before.id)).resolves.toBe(false);
    await expect(markers.list()).resolves.toEqual([after]);
    await expect(
      pool.query("INSERT INTO operational_recovery_markers (kind) VALUES ('notes')"),
    ).rejects.toThrow();
  });
});

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApplication } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { migrateDatabase, migrationsFolder } from "../src/database/migrate.js";
import { createDatabasePool } from "../src/database/pool.js";

const productTableNames = [
  "account",
  "conversation_compactions",
  "conversations",
  "drafts",
  "employee_approvals",
  "generations",
  "messages",
  "model_catalog",
  "openrouter_privacy_attestations",
  "rate_limit",
  "session",
  "user",
  "verification",
  "workspace_catalog_approvals",
  "workspace_cost_policies",
  "workspace_memberships",
  "workspace_model_policies",
  "workspaces",
] as const;

function databaseUrlFor(baseUrl: string, databaseName: string): string {
  const parsed = new URL(baseUrl);
  parsed.pathname = `/${databaseName}`;
  return parsed.href;
}

describe("PostgreSQL application schema", () => {
  let container: StartedPostgreSqlContainer | undefined;
  let databaseUrl: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:18.4-alpine")
      .withDatabase("capstone_foundation")
      .withUsername("capstone")
      .withPassword("capstone-test-password")
      .start();
    databaseUrl = container.getConnectionUri();
  });

  afterAll(async () => {
    if (container !== undefined) {
      await container.stop();
    }
  });

  it("applies the complete migration history to a clean database", async () => {
    await migrateDatabase(databaseUrl);
    const verificationPool = new Pool({ connectionString: databaseUrl });

    try {
      const migrationTable = await verificationPool.query<{ migrationTable: string | null }>(
        "SELECT to_regclass('drizzle.__drizzle_migrations')::text AS \"migrationTable\"",
      );
      const productTables = await verificationPool.query<{ tableName: string }>(
        "SELECT table_name AS \"tableName\" FROM information_schema.tables WHERE table_schema = 'public'",
      );

      expect(migrationTable.rows[0]?.migrationTable).toBe("drizzle.__drizzle_migrations");
      expect(productTables.rows.map(({ tableName }) => tableName).sort()).toEqual(
        productTableNames,
      );
    } finally {
      await verificationPool.end();
    }
  });

  it("upgrades the exact empty Phase 1 migration state and remains retry-safe", async () => {
    const phaseOneDatabaseName = "capstone_phase_one_upgrade";
    const phaseOneDatabaseUrl = databaseUrlFor(databaseUrl, phaseOneDatabaseName);
    const administrativePool = new Pool({ connectionString: databaseUrl });

    try {
      await administrativePool.query(`CREATE DATABASE "${phaseOneDatabaseName}"`);
    } finally {
      await administrativePool.end();
    }

    const phaseOnePool = new Pool({ connectionString: phaseOneDatabaseUrl });
    try {
      await phaseOnePool.query("CREATE SCHEMA drizzle");
      await phaseOnePool.query(`
        CREATE TABLE drizzle.__drizzle_migrations (
          id SERIAL PRIMARY KEY,
          hash text NOT NULL,
          created_at bigint
        )
      `);
      const productTablesBeforeUpgrade = await phaseOnePool.query<{ tableName: string }>(
        "SELECT table_name AS \"tableName\" FROM information_schema.tables WHERE table_schema = 'public'",
      );
      expect(productTablesBeforeUpgrade.rows).toEqual([]);
    } finally {
      await phaseOnePool.end();
    }

    await migrateDatabase(phaseOneDatabaseUrl);
    await migrateDatabase(phaseOneDatabaseUrl);

    const verificationPool = new Pool({ connectionString: phaseOneDatabaseUrl });
    try {
      const appliedMigrations = await verificationPool.query<{
        createdAt: string;
        hash: string;
      }>('SELECT created_at::text AS "createdAt", hash FROM drizzle.__drizzle_migrations');
      const productTables = await verificationPool.query<{ tableName: string }>(
        "SELECT table_name AS \"tableName\" FROM information_schema.tables WHERE table_schema = 'public'",
      );

      expect(appliedMigrations.rows).toHaveLength(5);
      expect(appliedMigrations.rows[0]?.hash).toMatch(/^[a-f0-9]{64}$/u);
      expect(Number(appliedMigrations.rows[0]?.createdAt)).toBeGreaterThan(0);
      expect(productTables.rows.map(({ tableName }) => tableName).sort()).toEqual(
        productTableNames,
      );
    } finally {
      await verificationPool.end();
    }
  });

  it("upgrades the exact accepted Phase 2 schema without changing its data", async () => {
    const databaseName = "capstone_phase_two_upgrade";
    const upgradeUrl = databaseUrlFor(databaseUrl, databaseName);
    const administrativePool = new Pool({ connectionString: databaseUrl });
    try {
      await administrativePool.query(`CREATE DATABASE "${databaseName}"`);
    } finally {
      await administrativePool.end();
    }

    const phaseTwoSql = await readFile(
      resolve(migrationsFolder, "0000_bumpy_living_lightning.sql"),
      "utf8",
    );
    const phaseTwoPool = new Pool({ connectionString: upgradeUrl });
    try {
      for (const statement of phaseTwoSql.split("--> statement-breakpoint")) {
        if (statement.trim() !== "") {
          await phaseTwoPool.query(statement);
        }
      }
      await phaseTwoPool.query("CREATE SCHEMA drizzle");
      await phaseTwoPool.query(`
        CREATE TABLE drizzle.__drizzle_migrations (
          id SERIAL PRIMARY KEY,
          hash text NOT NULL,
          created_at bigint
        )
      `);
      await phaseTwoPool.query(
        "INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)",
        [createHash("sha256").update(phaseTwoSql).digest("hex"), "1786061111713"],
      );
      await phaseTwoPool.query(
        "INSERT INTO workspaces (identity, display_name) VALUES ('phase-two-preserved', 'Phase Two Preserved')",
      );
    } finally {
      await phaseTwoPool.end();
    }

    await migrateDatabase(upgradeUrl);
    await migrateDatabase(upgradeUrl);

    const verificationPool = new Pool({ connectionString: upgradeUrl });
    try {
      const migrations = await verificationPool.query(
        "SELECT hash FROM drizzle.__drizzle_migrations ORDER BY created_at",
      );
      const workspace = await verificationPool.query<{ displayName: string }>(
        "SELECT display_name AS \"displayName\" FROM workspaces WHERE identity = 'phase-two-preserved'",
      );
      const phaseThreeTables = await verificationPool.query<{ tableName: string }>(
        "SELECT table_name AS \"tableName\" FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('conversations', 'drafts', 'messages') ORDER BY table_name",
      );

      expect(migrations.rows).toHaveLength(5);
      expect(workspace.rows).toEqual([{ displayName: "Phase Two Preserved" }]);
      expect(phaseThreeTables.rows.map((row) => row.tableName)).toEqual([
        "conversations",
        "drafts",
        "messages",
      ]);
    } finally {
      await verificationPool.end();
    }
  });

  it("upgrades the exact accepted Phase 3 schema without changing conversation data", async () => {
    const databaseName = "capstone_phase_three_upgrade";
    const upgradeUrl = databaseUrlFor(databaseUrl, databaseName);
    const administrativePool = new Pool({ connectionString: databaseUrl });
    try {
      await administrativePool.query(`CREATE DATABASE "${databaseName}"`);
    } finally {
      await administrativePool.end();
    }

    const phaseThreeMigrations = await Promise.all(
      ["0000_bumpy_living_lightning.sql", "0001_conscious_giant_man.sql"].map((fileName) =>
        readFile(resolve(migrationsFolder, fileName), "utf8"),
      ),
    );
    const phaseThreePool = new Pool({ connectionString: upgradeUrl });
    try {
      for (const migrationSql of phaseThreeMigrations) {
        for (const statement of migrationSql.split("--> statement-breakpoint")) {
          if (statement.trim() !== "") {
            await phaseThreePool.query(statement);
          }
        }
      }
      await phaseThreePool.query("CREATE SCHEMA drizzle");
      await phaseThreePool.query(`
        CREATE TABLE drizzle.__drizzle_migrations (
          id SERIAL PRIMARY KEY,
          hash text NOT NULL,
          created_at bigint
        )
      `);
      for (const [index, migrationSql] of phaseThreeMigrations.entries()) {
        await phaseThreePool.query(
          "INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)",
          [
            createHash("sha256").update(migrationSql).digest("hex"),
            index === 0 ? "1786061111713" : "1786071863036",
          ],
        );
      }
      await phaseThreePool.query(`
        INSERT INTO workspaces (id, identity, display_name)
        VALUES ('11111111-1111-4111-8111-111111111111', 'phase-three', 'Phase Three')
      `);
      await phaseThreePool.query(`
        INSERT INTO "user" (id, name, email, email_verified)
        VALUES ('phase-three-user', 'Phase Three User', 'phase-three@example.test', true)
      `);
      await phaseThreePool.query(`
        INSERT INTO conversations (
          id, workspace_id, user_id, title, revision
        ) VALUES (
          '22222222-2222-4222-8222-222222222222',
          '11111111-1111-4111-8111-111111111111',
          'phase-three-user',
          'Conversación preservada',
          3
        )
      `);
      await phaseThreePool.query(`
        INSERT INTO messages (id, conversation_id, parent_message_id, role, content)
        VALUES
          (
            '33333333-3333-4333-8333-333333333333',
            '22222222-2222-4222-8222-222222222222',
            NULL,
            'user',
            '[{"type":"text","text":"Pregunta preservada"}]'::jsonb
          ),
          (
            '44444444-4444-4444-8444-444444444444',
            '22222222-2222-4222-8222-222222222222',
            '33333333-3333-4333-8333-333333333333',
            'assistant',
            '[{"type":"text","text":"Respuesta preservada"}]'::jsonb
          )
      `);
      await phaseThreePool.query(`
        UPDATE conversations
        SET selected_leaf_message_id = '44444444-4444-4444-8444-444444444444'
        WHERE id = '22222222-2222-4222-8222-222222222222'
      `);
      await phaseThreePool.query(`
        INSERT INTO drafts (
          id, workspace_id, user_id, conversation_id, content, revision
        ) VALUES (
          '55555555-5555-4555-8555-555555555555',
          '11111111-1111-4111-8111-111111111111',
          'phase-three-user',
          '22222222-2222-4222-8222-222222222222',
          'Borrador preservado',
          2
        )
      `);
    } finally {
      await phaseThreePool.end();
    }

    await migrateDatabase(upgradeUrl);
    await migrateDatabase(upgradeUrl);

    const verificationPool = new Pool({ connectionString: upgradeUrl });
    try {
      const migrations = await verificationPool.query(
        "SELECT hash FROM drizzle.__drizzle_migrations ORDER BY created_at",
      );
      const preserved = await verificationPool.query<{
        draftContent: string;
        messageText: string;
        revision: number;
        selectedLeafMessageId: string;
        title: string;
      }>(`
        SELECT conversation.title,
          conversation.revision,
          conversation.selected_leaf_message_id AS "selectedLeafMessageId",
          draft.content AS "draftContent",
          message.content -> 0 ->> 'text' AS "messageText"
        FROM conversations AS conversation
        INNER JOIN drafts AS draft ON draft.conversation_id = conversation.id
        INNER JOIN messages AS message ON message.id = conversation.selected_leaf_message_id
        WHERE conversation.id = '22222222-2222-4222-8222-222222222222'
      `);
      const generationCount = await verificationPool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM generations",
      );

      expect(migrations.rows).toHaveLength(5);
      expect(preserved.rows).toEqual([
        {
          draftContent: "Borrador preservado",
          messageText: "Respuesta preservada",
          revision: 3,
          selectedLeafMessageId: "44444444-4444-4444-8444-444444444444",
          title: "Conversación preservada",
        },
      ]);
      expect(generationCount.rows).toEqual([{ count: "0" }]);
    } finally {
      await verificationPool.end();
    }
  });

  it("upgrades the exact Phase 5 generation shape as untracked and preserves deferred deletion", async () => {
    const databaseName = "capstone_phase_five_upgrade";
    const upgradeUrl = databaseUrlFor(databaseUrl, databaseName);
    const administrativePool = new Pool({ connectionString: databaseUrl });
    try {
      await administrativePool.query(`CREATE DATABASE "${databaseName}"`);
    } finally {
      await administrativePool.end();
    }

    const phaseFiveMigrations = await Promise.all(
      [
        "0000_bumpy_living_lightning.sql",
        "0001_conscious_giant_man.sql",
        "0002_great_serpent_society.sql",
      ].map((fileName) => readFile(resolve(migrationsFolder, fileName), "utf8")),
    );
    const phaseFivePool = new Pool({ connectionString: upgradeUrl });
    try {
      for (const migrationSql of phaseFiveMigrations) {
        for (const statement of migrationSql.split("--> statement-breakpoint")) {
          if (statement.trim() !== "") {
            await phaseFivePool.query(statement);
          }
        }
      }
      await phaseFivePool.query("CREATE SCHEMA drizzle");
      await phaseFivePool.query(`
        CREATE TABLE drizzle.__drizzle_migrations (
          id SERIAL PRIMARY KEY,
          hash text NOT NULL,
          created_at bigint
        )
      `);
      const migrationTimes = ["1786061111713", "1786071863036", "1786119062299"];
      for (const [index, migrationSql] of phaseFiveMigrations.entries()) {
        await phaseFivePool.query(
          "INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)",
          [createHash("sha256").update(migrationSql).digest("hex"), migrationTimes[index]],
        );
      }
      await phaseFivePool.query(`
        INSERT INTO workspaces (id, identity, display_name)
        VALUES ('10101010-1010-4010-8010-101010101010', 'phase-five', 'Phase Five')
      `);
      await phaseFivePool.query(`
        INSERT INTO "user" (id, name, email, email_verified)
        VALUES ('phase-five-user', 'Phase Five', 'phase-five@example.test', true)
      `);
      await phaseFivePool.query(`
        INSERT INTO conversations (id, workspace_id, user_id)
        VALUES (
          '20202020-2020-4020-8020-202020202020',
          '10101010-1010-4010-8010-101010101010',
          'phase-five-user'
        )
      `);
      await phaseFivePool.query(`
        INSERT INTO messages (id, conversation_id, parent_message_id, role, content)
        VALUES
          (
            '30303030-3030-4030-8030-303030303030',
            '20202020-2020-4020-8020-202020202020',
            NULL,
            'user',
            '[{"type":"text","text":"Pregunta histórica"}]'::jsonb
          ),
          (
            '40404040-4040-4040-8040-404040404040',
            '20202020-2020-4020-8020-202020202020',
            '30303030-3030-4030-8030-303030303030',
            'assistant',
            '[{"type":"text","text":"Respuesta histórica"}]'::jsonb
          )
      `);
      await phaseFivePool.query(`
        INSERT INTO generations (
          id, workspace_id, user_id, conversation_id, assistant_message_id, idempotency_key,
          requested_tier, system_prompt_version, effective_parameters, status
        ) VALUES (
          '50505050-5050-4050-8050-505050505050',
          '10101010-1010-4010-8010-101010101010',
          'phase-five-user',
          '20202020-2020-4020-8020-202020202020',
          '40404040-4040-4040-8040-404040404040',
          '60606060-6060-4060-8060-606060606060',
          'balanced',
          'capstone-chat-v1',
          '{}'::jsonb,
          'active'
        )
      `);
    } finally {
      await phaseFivePool.end();
    }

    await migrateDatabase(upgradeUrl);
    await migrateDatabase(upgradeUrl);

    const verificationPool = new Pool({ connectionString: upgradeUrl });
    try {
      const upgraded = await verificationPool.query<{
        accountingStatus: string | null;
        preferredTier: string;
        purpose: string | null;
        reservedCostUsd: string | null;
      }>(`
        SELECT conversation.preferred_tier AS "preferredTier",
          generation.accounting_status AS "accountingStatus",
          generation.purpose,
          generation.reserved_cost_usd::text AS "reservedCostUsd"
        FROM conversations AS conversation
        INNER JOIN generations AS generation ON generation.conversation_id = conversation.id
        WHERE generation.id = '50505050-5050-4050-8050-505050505050'
      `);
      const ownedForeignKey = await verificationPool.query<{ deferred: boolean }>(`
        SELECT condeferrable AS deferred
        FROM pg_constraint
        WHERE conname = 'generations_owned_conversation_fk'
      `);
      expect(upgraded.rows).toEqual([
        {
          accountingStatus: null,
          preferredTier: "balanced",
          purpose: null,
          reservedCostUsd: null,
        },
      ]);
      expect(ownedForeignKey.rows).toEqual([{ deferred: true }]);

      await verificationPool.query("BEGIN");
      try {
        await verificationPool.query(`
          UPDATE generations
          SET status = 'cancelled', terminal_reason = 'cancelled', completed_at = now(), updated_at = now()
          WHERE id = '50505050-5050-4050-8050-505050505050'
        `);
        await verificationPool.query(`
          DELETE FROM conversations WHERE id = '20202020-2020-4020-8020-202020202020'
        `);
        await verificationPool.query("COMMIT");
      } catch (error: unknown) {
        await verificationPool.query("ROLLBACK");
        throw error;
      }
      const retained = await verificationPool.query(`
        SELECT conversation_id, assistant_message_id, accounting_status
        FROM generations
        WHERE id = '50505050-5050-4050-8050-505050505050'
      `);
      expect(retained.rows).toEqual([
        { accounting_status: null, assistant_message_id: null, conversation_id: null },
      ]);
    } finally {
      await verificationPool.end();
    }
  });

  it("installs the reviewed constraints, generated search columns, and indexes", async () => {
    const verificationPool = new Pool({ connectionString: databaseUrl });
    try {
      const extension = await verificationPool.query<{ installed: boolean }>(
        "SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'unaccent') AS installed",
      );
      const constraints = await verificationPool.query<{ name: string; definition: string }>(`
        SELECT conname AS name, pg_get_constraintdef(oid) AS definition
        FROM pg_constraint
        WHERE conname IN (
          'conversations_same_conversation_selected_leaf_fk',
          'drafts_owned_conversation_fk',
          'messages_same_conversation_parent_fk'
        )
        ORDER BY conname
      `);
      const generatedColumns = await verificationPool.query<{
        columnName: string;
        generated: string;
      }>(`
        SELECT column_name AS "columnName", is_generated AS generated
        FROM information_schema.columns
        WHERE (table_name, column_name) IN (
          ('conversations', 'title_search_vector'),
          ('messages', 'content_search_vector')
        )
        ORDER BY column_name
      `);
      const indexes = await verificationPool.query<{ indexName: string }>(`
        SELECT indexname AS "indexName"
        FROM pg_indexes
        WHERE schemaname = 'public' AND indexname IN (
          'conversations_owner_active_history_idx',
          'conversations_owner_archived_history_idx',
          'conversations_owner_id_unique',
          'conversations_title_search_idx',
          'drafts_conversation_scope_unique',
          'drafts_new_chat_scope_unique',
          'messages_content_search_idx',
          'messages_parent_idx'
        )
        ORDER BY indexname
      `);
      const precision = await verificationPool.query<{ precision: number }>(`
        SELECT datetime_precision AS precision
        FROM information_schema.columns
        WHERE table_name = 'conversations' AND column_name = 'updated_at'
      `);

      expect(extension.rows[0]?.installed).toBe(true);
      expect(constraints.rows.map((row) => row.name)).toEqual([
        "conversations_same_conversation_selected_leaf_fk",
        "drafts_owned_conversation_fk",
        "messages_same_conversation_parent_fk",
      ]);
      expect(constraints.rows[0]?.definition).toContain("DEFERRABLE INITIALLY DEFERRED");
      expect(generatedColumns.rows).toEqual([
        { columnName: "content_search_vector", generated: "ALWAYS" },
        { columnName: "title_search_vector", generated: "ALWAYS" },
      ]);
      expect(indexes.rows).toHaveLength(8);
      expect(precision.rows).toEqual([{ precision: 3 }]);
    } finally {
      await verificationPool.end();
    }
  });

  it("installs generation accounting with the Phase 7 workflow guards", async () => {
    const verificationPool = new Pool({ connectionString: databaseUrl });
    try {
      const columns = await verificationPool.query<{ columnName: string }>(`
        SELECT column_name AS "columnName"
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'generations'
        ORDER BY ordinal_position
      `);
      const enumValues = await verificationPool.query<{ enumName: string; value: string }>(`
        SELECT enum_type.typname AS "enumName", enum_value.enumlabel AS value
        FROM pg_type AS enum_type
        INNER JOIN pg_enum AS enum_value ON enum_value.enumtypid = enum_type.oid
        WHERE enum_type.typname IN ('generation_status', 'generation_terminal_reason')
        ORDER BY enum_type.typname, enum_value.enumsortorder
      `);
      const constraints = await verificationPool.query<{
        deferred: boolean;
        definition: string;
        name: string;
      }>(`
        SELECT conname AS name,
          condeferrable AS deferred,
          pg_get_constraintdef(oid) AS definition
        FROM pg_constraint
        WHERE conrelid = 'public.generations'::regclass
          AND conname IN (
            'generations_assistant_message_fk',
            'generations_accounting_check',
            'generations_content_references_check',
            'generations_effective_parameters_check',
            'generations_lifecycle_check',
            'generations_owned_conversation_fk',
            'generations_requested_tier_check',
            'generations_system_prompt_version_check',
            'generations_timestamps_check',
            'generations_token_counts_check'
          )
        ORDER BY conname
      `);
      const indexes = await verificationPool.query<{ indexName: string }>(`
        SELECT indexname AS "indexName"
        FROM pg_indexes
        WHERE schemaname = 'public' AND indexname IN (
          'generations_active_conversation_unique',
          'generations_assistant_message_unique',
          'generations_chat_workflow_conversation_unique',
          'generations_openrouter_generation_id_unique',
          'generations_reserved_expiry_idx',
          'generations_scoped_idempotency_unique',
          'generations_workspace_budget_period_idx'
        )
        ORDER BY indexname
      `);

      expect(columns.rows.map((row) => row.columnName)).toEqual([
        "id",
        "workspace_id",
        "user_id",
        "conversation_id",
        "assistant_message_id",
        "idempotency_key",
        "requested_tier",
        "system_prompt_version",
        "effective_parameters",
        "status",
        "terminal_reason",
        "error_code",
        "started_at",
        "first_token_at",
        "completed_at",
        "created_at",
        "updated_at",
        "purpose",
        "requested_model",
        "resolved_model",
        "provider",
        "openrouter_generation_id",
        "prompt_tokens",
        "completion_tokens",
        "reasoning_tokens",
        "cached_tokens",
        "cost_usd",
        "cost_basis",
        "accounting_status",
        "estimated_input_tokens",
        "maximum_output_tokens",
        "reserved_cost_usd",
        "prompt_price_ceiling_per_token",
        "completion_price_ceiling_per_token",
        "request_price_ceiling_usd",
        "reservation_margin_basis_points",
        "budget_period_start",
        "budget_period_end",
        "reservation_expires_at",
        "accounting_settled_at",
      ]);
      expect(enumValues.rows).toEqual([
        { enumName: "generation_status", value: "preparing" },
        { enumName: "generation_status", value: "active" },
        { enumName: "generation_status", value: "completed" },
        { enumName: "generation_status", value: "cancelled" },
        { enumName: "generation_status", value: "incomplete" },
        { enumName: "generation_status", value: "failed" },
        { enumName: "generation_terminal_reason", value: "stop" },
        { enumName: "generation_terminal_reason", value: "length" },
        { enumName: "generation_terminal_reason", value: "refusal" },
        { enumName: "generation_terminal_reason", value: "content_filter" },
        { enumName: "generation_terminal_reason", value: "cancelled" },
        { enumName: "generation_terminal_reason", value: "error" },
      ]);
      expect(constraints.rows.map((row) => row.name)).toHaveLength(10);
      expect(
        constraints.rows.find((row) => row.name === "generations_owned_conversation_fk"),
      ).toMatchObject({ deferred: true });
      expect(
        constraints.rows.find((row) => row.name === "generations_assistant_message_fk")?.definition,
      ).toContain("ON DELETE SET NULL");
      expect(indexes.rows.map((row) => row.indexName)).toEqual([
        "generations_active_conversation_unique",
        "generations_assistant_message_unique",
        "generations_chat_workflow_conversation_unique",
        "generations_openrouter_generation_id_unique",
        "generations_reserved_expiry_idx",
        "generations_scoped_idempotency_unique",
        "generations_workspace_budget_period_idx",
      ]);
    } finally {
      await verificationPool.end();
    }
  });

  it("enforces generation scope, lifecycle, idempotency, and deletion retention", async () => {
    const verificationPool = new Pool({ connectionString: databaseUrl });
    try {
      await verificationPool.query(`
        INSERT INTO workspaces (id, identity, display_name)
        VALUES ('66666666-6666-4666-8666-666666666666', 'generation-schema', 'Generation Schema')
      `);
      await verificationPool.query(`
        INSERT INTO "user" (id, name, email, email_verified)
        VALUES
          ('generation-schema-user', 'Generation User', 'generation@example.test', true),
          ('generation-other-user', 'Other User', 'generation-other@example.test', true)
      `);
      await verificationPool.query(`
        INSERT INTO conversations (id, workspace_id, user_id)
        VALUES
          (
            '77777777-7777-4777-8777-777777777777',
            '66666666-6666-4666-8666-666666666666',
            'generation-schema-user'
          ),
          (
            'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            '66666666-6666-4666-8666-666666666666',
            'generation-schema-user'
          )
      `);
      await verificationPool.query(`
        INSERT INTO messages (id, conversation_id, parent_message_id, role, content)
        VALUES
          (
            '88888888-8888-4888-8888-888888888888',
            '77777777-7777-4777-8777-777777777777',
            NULL,
            'user',
            '[{"type":"text","text":"Pregunta"}]'::jsonb
          ),
          (
            '99999999-9999-4999-8999-999999999999',
            '77777777-7777-4777-8777-777777777777',
            '88888888-8888-4888-8888-888888888888',
            'assistant',
            '[{"type":"text","text":""}]'::jsonb
          ),
          (
            'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            '77777777-7777-4777-8777-777777777777',
            '88888888-8888-4888-8888-888888888888',
            'assistant',
            '[{"type":"text","text":""}]'::jsonb
          ),
          (
            'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
            'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            NULL,
            'user',
            '[{"type":"text","text":"Otra pregunta"}]'::jsonb
          ),
          (
            'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
            'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
            'assistant',
            '[{"type":"text","text":""}]'::jsonb
          )
      `);
      await verificationPool.query(`
        INSERT INTO generations (
          id,
          workspace_id,
          user_id,
          conversation_id,
          assistant_message_id,
          idempotency_key,
          requested_tier,
          system_prompt_version,
          effective_parameters,
          status
        ) VALUES (
          'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
          '66666666-6666-4666-8666-666666666666',
          'generation-schema-user',
          '77777777-7777-4777-8777-777777777777',
          '99999999-9999-4999-8999-999999999999',
          'ffffffff-ffff-4fff-8fff-ffffffffffff',
          'balanced',
          'capstone-chat-v1',
          '{}'::jsonb,
          'active'
        )
      `);

      await expect(
        verificationPool.query(`
          INSERT INTO generations (
            workspace_id, user_id, conversation_id, assistant_message_id, idempotency_key,
            requested_tier, system_prompt_version, effective_parameters, status,
            accounting_status
          ) VALUES (
            '66666666-6666-4666-8666-666666666666',
            'generation-schema-user',
            'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
            '12345678-1234-4234-8234-123456789019',
            'balanced',
            'capstone-chat-v1',
            '{}'::jsonb,
            'active',
            'reserved'
          )
        `),
      ).rejects.toMatchObject({ code: "23514", constraint: "generations_accounting_check" });

      await expect(
        verificationPool.query(`
          INSERT INTO generations (
            workspace_id, user_id, conversation_id, assistant_message_id, idempotency_key,
            requested_tier, system_prompt_version, effective_parameters, status
          ) VALUES (
            '66666666-6666-4666-8666-666666666666',
            'generation-schema-user',
            '77777777-7777-4777-8777-777777777777',
            'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            '12345678-1234-4234-8234-123456789012',
            'balanced',
            'capstone-chat-v1',
            '{}'::jsonb,
            'active'
          )
        `),
      ).rejects.toMatchObject({
        code: "23505",
        constraint: "generations_active_conversation_unique",
      });
      await expect(
        verificationPool.query(`
          INSERT INTO generations (
            workspace_id, user_id, conversation_id, assistant_message_id, idempotency_key,
            requested_tier, system_prompt_version, effective_parameters, status
          ) VALUES (
            '66666666-6666-4666-8666-666666666666',
            'generation-schema-user',
            'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
            'ffffffff-ffff-4fff-8fff-ffffffffffff',
            'balanced',
            'capstone-chat-v1',
            '{}'::jsonb,
            'active'
          )
        `),
      ).rejects.toMatchObject({
        code: "23505",
        constraint: "generations_scoped_idempotency_unique",
      });
      await expect(
        verificationPool.query(`
          INSERT INTO generations (
            workspace_id, user_id, conversation_id, assistant_message_id, idempotency_key,
            requested_tier, system_prompt_version, effective_parameters, status
          ) VALUES (
            '66666666-6666-4666-8666-666666666666',
            'generation-other-user',
            'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
            '12345678-1234-4234-8234-123456789013',
            'balanced',
            'capstone-chat-v1',
            '{}'::jsonb,
            'active'
          )
        `),
      ).rejects.toMatchObject({ code: "23503", constraint: "generations_owned_conversation_fk" });
      await expect(
        verificationPool.query(`
          INSERT INTO generations (
            workspace_id, user_id, conversation_id, assistant_message_id, idempotency_key,
            requested_tier, system_prompt_version, effective_parameters, status
          ) VALUES (
            '66666666-6666-4666-8666-666666666666',
            'generation-schema-user',
            'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
            '12345678-1234-4234-8234-123456789014',
            'ultra',
            'capstone-chat-v1',
            '{}'::jsonb,
            'active'
          )
        `),
      ).rejects.toMatchObject({ code: "23514", constraint: "generations_requested_tier_check" });
      await expect(
        verificationPool.query(`
          INSERT INTO generations (
            workspace_id, user_id, conversation_id, assistant_message_id, idempotency_key,
            requested_tier, system_prompt_version, effective_parameters, status,
            terminal_reason, completed_at
          ) VALUES (
            '66666666-6666-4666-8666-666666666666',
            'generation-schema-user',
            'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
            '12345678-1234-4234-8234-123456789015',
            'balanced',
            'capstone-chat-v1',
            '{}'::jsonb,
            'completed',
            'error',
            now()
          )
        `),
      ).rejects.toMatchObject({ code: "23514", constraint: "generations_lifecycle_check" });
      await expect(
        verificationPool.query(`
          INSERT INTO generations (
            workspace_id, user_id, conversation_id, assistant_message_id, idempotency_key,
            requested_tier, system_prompt_version, effective_parameters, status,
            terminal_reason, started_at, first_token_at, completed_at
          ) VALUES (
            '66666666-6666-4666-8666-666666666666',
            'generation-schema-user',
            'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
            '12345678-1234-4234-8234-123456789016',
            'balanced',
            'capstone-chat-v1',
            '{}'::jsonb,
            'completed',
            'stop',
            '2026-08-07T12:00:00.000Z'::timestamptz,
            '2026-08-07T12:00:02.000Z'::timestamptz,
            '2026-08-07T12:00:01.000Z'::timestamptz
          )
        `),
      ).rejects.toMatchObject({ code: "23514", constraint: "generations_timestamps_check" });
      await expect(
        verificationPool.query(`
          INSERT INTO generations (
            workspace_id, user_id, conversation_id, assistant_message_id, idempotency_key,
            requested_tier, system_prompt_version, effective_parameters, status,
            started_at, created_at, updated_at
          ) VALUES (
            '66666666-6666-4666-8666-666666666666',
            'generation-schema-user',
            'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
            '12345678-1234-4234-8234-123456789017',
            'balanced',
            'capstone-chat-v1',
            '{}'::jsonb,
            'active',
            '2026-08-07T12:00:00.000Z'::timestamptz,
            '2026-08-07T12:00:01.000Z'::timestamptz,
            '2026-08-07T12:00:01.000Z'::timestamptz
          )
        `),
      ).rejects.toMatchObject({ code: "23514", constraint: "generations_timestamps_check" });
      await expect(
        verificationPool.query(`
          INSERT INTO generations (
            workspace_id, user_id, conversation_id, assistant_message_id, idempotency_key,
            requested_tier, system_prompt_version, effective_parameters, status,
            terminal_reason, started_at, completed_at, created_at, updated_at
          ) VALUES (
            '66666666-6666-4666-8666-666666666666',
            'generation-schema-user',
            'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
            '12345678-1234-4234-8234-123456789018',
            'balanced',
            'capstone-chat-v1',
            '{}'::jsonb,
            'completed',
            'stop',
            '2026-08-07T12:00:02.000Z'::timestamptz,
            '2026-08-07T12:00:03.000Z'::timestamptz,
            '2026-08-07T11:59:00.000Z'::timestamptz,
            '2026-08-07T12:00:01.000Z'::timestamptz
          )
        `),
      ).rejects.toMatchObject({ code: "23514", constraint: "generations_timestamps_check" });

      await expect(
        verificationPool.query(
          "DELETE FROM conversations WHERE id = '77777777-7777-4777-8777-777777777777'",
        ),
      ).rejects.toMatchObject({ code: "23514", constraint: "generations_lifecycle_check" });

      await verificationPool.query("BEGIN");
      try {
        await verificationPool.query(`
          UPDATE generations
          SET status = 'cancelled',
            terminal_reason = 'cancelled',
            completed_at = now(),
            updated_at = now()
          WHERE id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
        `);
        await verificationPool.query(
          "DELETE FROM conversations WHERE id = '77777777-7777-4777-8777-777777777777'",
        );
        await verificationPool.query("COMMIT");
      } catch (error: unknown) {
        await verificationPool.query("ROLLBACK");
        throw error;
      }

      const retained = await verificationPool.query<{
        assistantMessageId: string | null;
        conversationId: string | null;
        status: string;
      }>(`
        SELECT conversation_id AS "conversationId",
          assistant_message_id AS "assistantMessageId",
          status::text
        FROM generations
        WHERE id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
      `);
      expect(retained.rows).toEqual([
        { assistantMessageId: null, conversationId: null, status: "cancelled" },
      ]);
    } finally {
      await verificationPool.end();
    }
  });

  it("keeps the migration history additive for expand-contract releases", async () => {
    const migrationFiles = (await readdir(migrationsFolder))
      .filter((fileName) => fileName.endsWith(".sql"))
      .sort();
    const migrationSql = (
      await Promise.all(
        migrationFiles.map((fileName) => readFile(resolve(migrationsFolder, fileName), "utf8")),
      )
    ).join("\n");

    expect(migrationFiles.length).toBeGreaterThan(0);
    expect(migrationSql).toMatch(/\bCREATE (?:TABLE|TYPE)\b/iu);
    expect(migrationSql).not.toMatch(/\b(?:DELETE\s+FROM|DROP\s+(?:TABLE|COLUMN)|TRUNCATE)\b/iu);
  });

  it("keeps liveness healthy when PostgreSQL becomes unavailable", async () => {
    const pool = createDatabasePool(databaseUrl);
    const application = createApplication(
      loadConfig({ DATABASE_URL: databaseUrl, NODE_ENV: "test" }),
      { pool },
    );

    await application.server.ready();
    await expect(application.lifecycle.initialize()).resolves.toEqual({
      database: "up",
      status: "ready",
    });

    const ready = await application.server.inject({ method: "GET", url: "/api/health/ready" });
    expect(ready.statusCode).toBe(200);

    const runningContainer = container;
    if (runningContainer === undefined) {
      throw new Error("PostgreSQL container was not started");
    }
    await runningContainer.stop();
    container = undefined;

    const live = await application.server.inject({ method: "GET", url: "/api/health/live" });
    const unavailable = await application.server.inject({
      method: "GET",
      url: "/api/health/ready",
    });

    expect(live.statusCode).toBe(200);
    expect(live.json()).toEqual({ status: "live" });
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.json()).toEqual({ database: "down", status: "unavailable" });

    await application.shutdown();
  });
});

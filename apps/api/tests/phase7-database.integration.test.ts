import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateDatabase, migrationsFolder } from "../src/database/migrate.js";

const workspaceOneId = "10000000-0000-4000-8000-000000000001";
const workspaceTwoId = "10000000-0000-4000-8000-000000000002";
const conversationOneId = "20000000-0000-4000-8000-000000000001";
const conversationTwoId = "20000000-0000-4000-8000-000000000002";
const deletionConversationId = "20000000-0000-4000-8000-000000000003";
const assistantOneId = "30000000-0000-4000-8000-000000000002";
const assistantTwoId = "30000000-0000-4000-8000-000000000003";
const assistantOtherId = "30000000-0000-4000-8000-000000000005";
const deletionAssistantId = "30000000-0000-4000-8000-000000000007";
const userId = "phase-seven-storage-user";

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

async function insertUntrackedGeneration(
  pool: Pool,
  input: {
    assistantMessageId: string | null;
    conversationId: string;
    id: string;
    idempotencyKey: string;
    promptVersion: string;
    purpose: "chat" | "compaction" | null;
    status: "active" | "cancelled" | "completed" | "failed" | "incomplete" | "preparing";
    workspaceId?: string;
  },
): Promise<void> {
  const terminalReason =
    input.status === "completed"
      ? "stop"
      : input.status === "cancelled"
        ? "cancelled"
        : input.status === "failed" || input.status === "incomplete"
          ? "error"
          : null;
  const errorCode =
    input.status === "failed" || input.status === "incomplete" ? "GENERATION_FAILED" : null;
  const completedAt = terminalReason === null ? null : new Date("2026-08-08T12:00:03.000Z");

  await pool.query(
    `
      INSERT INTO generations (
        id, workspace_id, user_id, conversation_id, assistant_message_id, idempotency_key,
        requested_tier, purpose, system_prompt_version, effective_parameters, status,
        terminal_reason, error_code, completed_at,
        started_at, created_at, updated_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6,
        'balanced', $7, $8, '{}'::jsonb, $9,
        $10, $11, $12,
        '2026-08-08T12:00:01.000Z'::timestamptz,
        '2026-08-08T12:00:00.000Z'::timestamptz,
        CASE WHEN $12::timestamptz IS NULL
          THEN '2026-08-08T12:00:01.000Z'::timestamptz
          ELSE '2026-08-08T12:00:04.000Z'::timestamptz
        END
      )
    `,
    [
      input.id,
      input.workspaceId ?? workspaceOneId,
      userId,
      input.conversationId,
      input.assistantMessageId,
      input.idempotencyKey,
      input.purpose,
      input.promptVersion,
      input.status,
      terminalReason,
      errorCode,
      completedAt,
    ],
  );
}

describe("Phase 7 PostgreSQL storage", () => {
  let container: StartedPostgreSqlContainer | undefined;
  let databaseUrl: string;
  let pool: Pool;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:18.4-alpine")
      .withDatabase("capstone_phase_seven")
      .withUsername("capstone")
      .withPassword("capstone-test-password")
      .start();
    databaseUrl = container.getConnectionUri();
    await migrateDatabase(databaseUrl);
    pool = new Pool({ connectionString: databaseUrl });

    await pool.query(`
      INSERT INTO workspaces (id, identity, display_name)
      VALUES
        ('${workspaceOneId}', 'phase-seven-one', 'Phase Seven One'),
        ('${workspaceTwoId}', 'phase-seven-two', 'Phase Seven Two')
    `);
    await pool.query(`
      INSERT INTO "user" (id, name, email, email_verified)
      VALUES ('${userId}', 'Phase Seven', 'phase-seven@example.test', true)
    `);
    await pool.query(`
      INSERT INTO conversations (id, workspace_id, user_id)
      VALUES
        ('${conversationOneId}', '${workspaceOneId}', '${userId}'),
        ('${conversationTwoId}', '${workspaceOneId}', '${userId}'),
        ('${deletionConversationId}', '${workspaceOneId}', '${userId}')
    `);
    await pool.query(`
      INSERT INTO messages (id, conversation_id, parent_message_id, role, content)
      VALUES
        (
          '30000000-0000-4000-8000-000000000001',
          '${conversationOneId}',
          NULL,
          'user',
          '[{"type":"text","text":"Pregunta uno"}]'::jsonb
        ),
        (
          '${assistantOneId}',
          '${conversationOneId}',
          '30000000-0000-4000-8000-000000000001',
          'assistant',
          '[{"type":"text","text":"Respuesta uno"}]'::jsonb
        ),
        (
          '${assistantTwoId}',
          '${conversationOneId}',
          '30000000-0000-4000-8000-000000000001',
          'assistant',
          '[{"type":"text","text":"Respuesta alternativa"}]'::jsonb
        ),
        (
          '30000000-0000-4000-8000-000000000004',
          '${conversationTwoId}',
          NULL,
          'user',
          '[{"type":"text","text":"Pregunta dos"}]'::jsonb
        ),
        (
          '${assistantOtherId}',
          '${conversationTwoId}',
          '30000000-0000-4000-8000-000000000004',
          'assistant',
          '[{"type":"text","text":"Respuesta dos"}]'::jsonb
        ),
        (
          '30000000-0000-4000-8000-000000000006',
          '${deletionConversationId}',
          NULL,
          'user',
          '[{"type":"text","text":"Pregunta para borrar"}]'::jsonb
        ),
        (
          '${deletionAssistantId}',
          '${deletionConversationId}',
          '30000000-0000-4000-8000-000000000006',
          'assistant',
          '[{"type":"text","text":"Respuesta para borrar"}]'::jsonb
        )
    `);
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  it("upgrades the exact Phase 6 shape without changing accepted data and backfills approvals", async () => {
    const databaseName = "capstone_exact_phase_six";
    const upgradeUrl = databaseUrlFor(databaseUrl, databaseName);
    const administrativePool = new Pool({ connectionString: databaseUrl });
    await administrativePool.query(`CREATE DATABASE "${databaseName}"`);
    await administrativePool.end();

    const migrationNames = [
      "0000_bumpy_living_lightning.sql",
      "0001_conscious_giant_man.sql",
      "0002_great_serpent_society.sql",
      "0003_openrouter_cost_control.sql",
    ] as const;
    const migrationTimes = [1786061111713, 1786071863036, 1786119062299, 1786205271465] as const;
    const migrationSql = await Promise.all(
      migrationNames.map((name) => readFile(resolve(migrationsFolder, name), "utf8")),
    );
    const phaseSixPool = new Pool({ connectionString: upgradeUrl });
    let beforeUpgrade: Record<string, unknown> | undefined;

    try {
      for (const sql of migrationSql) {
        await applyMigrationSql(phaseSixPool, sql);
      }
      await phaseSixPool.query("CREATE SCHEMA drizzle");
      await phaseSixPool.query(`
        CREATE TABLE drizzle.__drizzle_migrations (
          id SERIAL PRIMARY KEY,
          hash text NOT NULL,
          created_at bigint
        )
      `);
      for (const [index, sql] of migrationSql.entries()) {
        await phaseSixPool.query(
          "INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)",
          [createHash("sha256").update(sql).digest("hex"), migrationTimes[index]],
        );
      }

      await phaseSixPool.query(`
        INSERT INTO workspaces (id, identity, display_name)
        VALUES ('60000000-0000-4000-8000-000000000001', 'phase-six-exact', 'Phase Six Exact')
      `);
      await phaseSixPool.query(`
        INSERT INTO "user" (id, name, email, email_verified)
        VALUES ('phase-six-exact-user', 'Phase Six', 'phase-six-exact@example.test', true)
      `);
      await phaseSixPool.query(`
        INSERT INTO workspace_memberships (
          id, workspace_id, user_id, role, status, activated_at, created_at, updated_at
        ) VALUES (
          '60000000-0000-4000-8000-000000000002',
          '60000000-0000-4000-8000-000000000001',
          'phase-six-exact-user',
          'admin',
          'active',
          '2026-08-01T00:00:00.000Z',
          '2026-08-01T00:00:00.000Z',
          '2026-08-01T00:00:00.000Z'
        )
      `);
      await phaseSixPool.query(`
        INSERT INTO conversations (
          id, workspace_id, user_id, title, selected_leaf_message_id, revision,
          created_at, updated_at
        ) VALUES (
          '60000000-0000-4000-8000-000000000003',
          '60000000-0000-4000-8000-000000000001',
          'phase-six-exact-user',
          'Historia exacta',
          NULL,
          7,
          '2026-08-01T00:00:00.000Z',
          '2026-08-01T00:00:04.000Z'
        )
      `);
      await phaseSixPool.query(`
        INSERT INTO messages (id, conversation_id, parent_message_id, role, content, created_at)
        VALUES
          (
            '60000000-0000-4000-8000-000000000004',
            '60000000-0000-4000-8000-000000000003',
            NULL,
            'user',
            '[{"type":"text","text":"Contenido exacto"}]'::jsonb,
            '2026-08-01T00:00:01.000Z'
          ),
          (
            '60000000-0000-4000-8000-000000000005',
            '60000000-0000-4000-8000-000000000003',
            '60000000-0000-4000-8000-000000000004',
            'assistant',
            '[{"type":"text","text":"Respuesta exacta"}]'::jsonb,
            '2026-08-01T00:00:02.000Z'
          )
      `);
      await phaseSixPool.query(`
        UPDATE conversations
        SET selected_leaf_message_id = '60000000-0000-4000-8000-000000000005'
        WHERE id = '60000000-0000-4000-8000-000000000003'
      `);
      await phaseSixPool.query(`
        INSERT INTO drafts (
          id, workspace_id, user_id, conversation_id, content, revision, updated_at
        ) VALUES (
          '60000000-0000-4000-8000-000000000009',
          '60000000-0000-4000-8000-000000000001',
          'phase-six-exact-user',
          '60000000-0000-4000-8000-000000000003',
          'Borrador exacto',
          3,
          '2026-08-01T00:00:05.000Z'
        )
      `);
      await phaseSixPool.query(`
        INSERT INTO model_catalog (
          id, openrouter_model_id, display_name, input_modalities, output_modalities,
          supported_parameters, context_length, maximum_output_tokens,
          prompt_price_per_token, completion_price_per_token, request_price_usd,
          metadata_source, available, validated_at, created_at, updated_at
        ) VALUES (
          '60000000-0000-4000-8000-000000000006',
          'capstone/phase-six',
          'Phase Six Model',
          '["text"]'::jsonb,
          '["text"]'::jsonb,
          '["max_tokens"]'::jsonb,
          32768,
          4096,
          0.000000000000000123456789,
          0.000000000000000987654321,
          0.010000000000000000,
          'simulated',
          true,
          '2026-08-01T00:00:00.000Z',
          '2026-08-01T00:00:00.000Z',
          '2026-08-01T00:00:00.000Z'
        )
      `);
      await phaseSixPool.query(`
        INSERT INTO workspace_model_policies (
          workspace_id, tier, model_catalog_id, enabled, maximum_output_tokens,
          created_at, updated_at
        ) VALUES (
          '60000000-0000-4000-8000-000000000001',
          'balanced',
          '60000000-0000-4000-8000-000000000006',
          true,
          4096,
          '2026-08-01T00:00:00.000Z',
          '2026-08-01T00:00:00.000Z'
        )
      `);
      await phaseSixPool.query(`
        INSERT INTO workspace_cost_policies (
          workspace_id, monthly_budget_usd, default_tier,
          employee_active_generation_limit, reservation_margin_basis_points,
          created_at, updated_at
        ) VALUES (
          '60000000-0000-4000-8000-000000000001',
          123.456789012345678901,
          'balanced',
          2,
          1000,
          '2026-08-01T00:00:00.000Z',
          '2026-08-01T00:00:00.000Z'
        )
      `);
      await phaseSixPool.query(`
        INSERT INTO generations (
          id, workspace_id, user_id, conversation_id, assistant_message_id,
          idempotency_key, requested_tier, purpose, requested_model, resolved_model,
          provider, openrouter_generation_id, system_prompt_version, effective_parameters,
          status, terminal_reason, prompt_tokens, completion_tokens, cost_usd, cost_basis,
          accounting_status, estimated_input_tokens, maximum_output_tokens, reserved_cost_usd,
          prompt_price_ceiling_per_token, completion_price_ceiling_per_token,
          request_price_ceiling_usd, reservation_margin_basis_points,
          budget_period_start, budget_period_end, reservation_expires_at,
          accounting_settled_at, started_at, first_token_at, completed_at, created_at, updated_at
        ) VALUES (
          '60000000-0000-4000-8000-000000000007',
          '60000000-0000-4000-8000-000000000001',
          'phase-six-exact-user',
          '60000000-0000-4000-8000-000000000003',
          '60000000-0000-4000-8000-000000000005',
          '60000000-0000-4000-8000-000000000008',
          'balanced',
          'chat',
          'capstone/phase-six',
          'capstone/phase-six',
          'simulated',
          'phase-six-generation',
          'capstone-chat-v1',
          '{"temperature":0}'::jsonb,
          'completed',
          'stop',
          123,
          45,
          0.123456789012345678,
          'actual',
          'actual',
          150,
          4096,
          0.500000000000000000,
          0.000000000000000123456789,
          0.000000000000000987654321,
          0.010000000000000000,
          1000,
          '2026-08-01T00:00:00.000Z',
          '2026-09-01T00:00:00.000Z',
          '2026-08-01T00:06:01.000Z',
          '2026-08-01T00:00:04.000Z',
          '2026-08-01T00:00:01.000Z',
          '2026-08-01T00:00:02.000Z',
          '2026-08-01T00:00:03.000Z',
          '2026-08-01T00:00:00.000Z',
          '2026-08-01T00:00:04.000Z'
        )
      `);

      beforeUpgrade = (
        await phaseSixPool.query<Record<string, unknown>>(`
          SELECT
            conversation.title,
            conversation.selected_leaf_message_id::text AS selected_leaf,
            message.content::text AS content,
            generation.status::text AS status,
            generation.cost_usd::text AS cost,
            generation.reserved_cost_usd::text AS reserved_cost,
            generation.created_at::text AS generation_created_at,
            draft.content AS draft_content,
            draft.revision AS draft_revision,
            draft.updated_at::text AS draft_updated_at,
            policy.monthly_budget_usd::text AS monthly_budget,
            policy.updated_at::text AS policy_updated_at,
            model_policy.enabled AS model_enabled,
            model_policy.maximum_output_tokens AS model_output_tokens,
            model_policy.updated_at::text AS model_policy_updated_at
          FROM conversations AS conversation
          INNER JOIN messages AS message ON message.id = conversation.selected_leaf_message_id
          INNER JOIN generations AS generation ON generation.conversation_id = conversation.id
          INNER JOIN drafts AS draft ON draft.conversation_id = conversation.id
          INNER JOIN workspace_cost_policies AS policy
            ON policy.workspace_id = conversation.workspace_id
          INNER JOIN workspace_model_policies AS model_policy
            ON model_policy.workspace_id = conversation.workspace_id
          WHERE conversation.id = '60000000-0000-4000-8000-000000000003'
        `)
      ).rows[0];
    } finally {
      await phaseSixPool.end();
    }

    await migrateDatabase(upgradeUrl);
    await migrateDatabase(upgradeUrl);

    const verificationPool = new Pool({ connectionString: upgradeUrl });
    try {
      const afterUpgrade = (
        await verificationPool.query<Record<string, unknown>>(`
          SELECT
            conversation.title,
            conversation.selected_leaf_message_id::text AS selected_leaf,
            message.content::text AS content,
            generation.status::text AS status,
            generation.cost_usd::text AS cost,
            generation.reserved_cost_usd::text AS reserved_cost,
            generation.created_at::text AS generation_created_at,
            draft.content AS draft_content,
            draft.revision AS draft_revision,
            draft.updated_at::text AS draft_updated_at,
            policy.monthly_budget_usd::text AS monthly_budget,
            policy.updated_at::text AS policy_updated_at,
            model_policy.enabled AS model_enabled,
            model_policy.maximum_output_tokens AS model_output_tokens,
            model_policy.updated_at::text AS model_policy_updated_at
          FROM conversations AS conversation
          INNER JOIN messages AS message ON message.id = conversation.selected_leaf_message_id
          INNER JOIN generations AS generation ON generation.conversation_id = conversation.id
          INNER JOIN drafts AS draft ON draft.conversation_id = conversation.id
          INNER JOIN workspace_cost_policies AS policy
            ON policy.workspace_id = conversation.workspace_id
          INNER JOIN workspace_model_policies AS model_policy
            ON model_policy.workspace_id = conversation.workspace_id
          WHERE conversation.id = '60000000-0000-4000-8000-000000000003'
        `)
      ).rows[0];
      const phaseSevenFields = await verificationPool.query(`
        SELECT
          membership.monthly_soft_budget_usd,
          policy.revision,
          approval.model_catalog_id
        FROM workspace_memberships AS membership
        INNER JOIN workspace_cost_policies AS policy
          ON policy.workspace_id = membership.workspace_id
        INNER JOIN workspace_catalog_approvals AS approval
          ON approval.workspace_id = membership.workspace_id
        WHERE membership.workspace_id = '60000000-0000-4000-8000-000000000001'
      `);
      const migrations = await verificationPool.query(
        "SELECT hash FROM drizzle.__drizzle_migrations ORDER BY created_at",
      );

      expect(afterUpgrade).toEqual(beforeUpgrade);
      expect(phaseSevenFields.rows).toEqual([
        {
          model_catalog_id: "60000000-0000-4000-8000-000000000006",
          monthly_soft_budget_usd: null,
          revision: 1,
        },
      ]);
      expect(migrations.rows).toHaveLength(7);
    } finally {
      await verificationPool.end();
    }
  });

  it("enforces Phase 7 generation workflow and compaction invariants", async () => {
    await insertUntrackedGeneration(pool, {
      assistantMessageId: assistantOneId,
      conversationId: conversationOneId,
      id: "40000000-0000-4000-8000-000000000001",
      idempotencyKey: "41000000-0000-4000-8000-000000000001",
      promptVersion: "capstone-chat-v1",
      purpose: "chat",
      status: "preparing",
    });
    await expect(
      insertUntrackedGeneration(pool, {
        assistantMessageId: assistantTwoId,
        conversationId: conversationOneId,
        id: "40000000-0000-4000-8000-000000000002",
        idempotencyKey: "41000000-0000-4000-8000-000000000002",
        promptVersion: "capstone-chat-v1",
        purpose: "chat",
        status: "active",
      }),
    ).rejects.toMatchObject({
      code: "23505",
      constraint: "generations_chat_workflow_conversation_unique",
    });
    await insertUntrackedGeneration(pool, {
      assistantMessageId: null,
      conversationId: conversationOneId,
      id: "40000000-0000-4000-8000-000000000003",
      idempotencyKey: "41000000-0000-4000-8000-000000000003",
      promptVersion: "capstone-compaction-v1",
      purpose: "compaction",
      status: "active",
    });
    await expect(
      insertUntrackedGeneration(pool, {
        assistantMessageId: null,
        conversationId: conversationOneId,
        id: "40000000-0000-4000-8000-000000000004",
        idempotencyKey: "41000000-0000-4000-8000-000000000004",
        promptVersion: "capstone-compaction-v1",
        purpose: "compaction",
        status: "active",
      }),
    ).rejects.toMatchObject({
      code: "23505",
      constraint: "generations_active_conversation_unique",
    });

    await pool.query(`
      INSERT INTO conversation_compactions (
        id, workspace_id, user_id, conversation_id, through_message_id,
        generation_id, model_used, prompt_version, status
      ) VALUES (
        '50000000-0000-4000-8000-000000000001',
        '${workspaceOneId}',
        '${userId}',
        '${conversationOneId}',
        '${assistantOneId}',
        '40000000-0000-4000-8000-000000000003',
        'capstone/compaction',
        'capstone-compaction-v1',
        'active'
      )
    `);
    await expect(
      pool.query(`
        INSERT INTO conversation_compactions (
          id, workspace_id, user_id, conversation_id, through_message_id,
          generation_id, model_used, prompt_version, status
        ) VALUES (
          '50000000-0000-4000-8000-000000000008',
          '${workspaceOneId}',
          '${userId}',
          '${conversationOneId}',
          '${assistantTwoId}',
          '40000000-0000-4000-8000-000000000003',
          'capstone/compaction',
          'capstone-compaction-v1',
          'active'
        )
      `),
    ).rejects.toMatchObject({
      code: "23505",
      constraint: "conversation_compactions_generation_unique",
    });
    await insertUntrackedGeneration(pool, {
      assistantMessageId: null,
      conversationId: conversationOneId,
      id: "40000000-0000-4000-8000-000000000005",
      idempotencyKey: "41000000-0000-4000-8000-000000000005",
      promptVersion: "capstone-compaction-v1",
      purpose: "compaction",
      status: "completed",
    });

    await expect(
      pool.query(`
        INSERT INTO conversation_compactions (
          id, workspace_id, user_id, conversation_id, through_message_id,
          generation_id, model_used, prompt_version, status, completed_at
        ) VALUES (
          '50000000-0000-4000-8000-000000000002',
          '${workspaceTwoId}',
          '${userId}',
          '${conversationOneId}',
          '${assistantOneId}',
          '40000000-0000-4000-8000-000000000005',
          'capstone/compaction',
          'capstone-compaction-v1',
          'incomplete',
          now()
        )
      `),
    ).rejects.toMatchObject({
      code: "23503",
      constraint: "conversation_compactions_owned_conversation_fk",
    });
    await expect(
      pool.query(`
        INSERT INTO conversation_compactions (
          id, workspace_id, user_id, conversation_id, through_message_id,
          generation_id, model_used, prompt_version, status, completed_at
        ) VALUES (
          '50000000-0000-4000-8000-000000000003',
          '${workspaceOneId}',
          '${userId}',
          '${conversationOneId}',
          '${assistantOtherId}',
          '40000000-0000-4000-8000-000000000005',
          'capstone/compaction',
          'capstone-compaction-v1',
          'incomplete',
          now()
        )
      `),
    ).rejects.toMatchObject({
      code: "23503",
      constraint: "conversation_compactions_through_message_fk",
    });
    await expect(
      pool.query(`
        INSERT INTO conversation_compactions (
          id, workspace_id, user_id, conversation_id, through_message_id,
          generation_id, model_used, prompt_version, status, completed_at
        ) VALUES (
          '50000000-0000-4000-8000-000000000004',
          '${workspaceOneId}',
          '${userId}',
          '${conversationOneId}',
          '${assistantOneId}',
          '40000000-0000-4000-8000-000000000005',
          'capstone/compaction',
          'capstone-compaction-v1',
          'completed',
          now()
        )
      `),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "conversation_compactions_lifecycle_check",
    });
    await expect(
      pool.query(`
        INSERT INTO conversation_compactions (
          id, workspace_id, user_id, conversation_id, through_message_id,
          generation_id, summary, source_token_count, summary_token_count,
          model_used, prompt_version, status, completed_at, updated_at
        ) VALUES (
          '50000000-0000-4000-8000-000000000005',
          '${workspaceOneId}',
          '${userId}',
          '${conversationOneId}',
          '${assistantOneId}',
          '40000000-0000-4000-8000-000000000005',
          'Resumen válido',
          10,
          4,
          'capstone/compaction',
          'wrong-prompt',
          'completed',
          now(),
          now()
        )
      `),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "conversation_compactions_nonempty_text_check",
    });

    await pool.query(`
      INSERT INTO conversation_compactions (
        id, workspace_id, user_id, conversation_id, through_message_id,
        generation_id, summary, source_token_count, summary_token_count,
        model_used, prompt_version, status, completed_at, updated_at
      ) VALUES (
        '50000000-0000-4000-8000-000000000006',
        '${workspaceOneId}',
        '${userId}',
        '${conversationOneId}',
        '${assistantOneId}',
        '40000000-0000-4000-8000-000000000005',
        'Resumen válido',
        10,
        4,
        'capstone/compaction',
        'capstone-compaction-v1',
        'completed',
        now(),
        now()
      )
    `);
    await insertUntrackedGeneration(pool, {
      assistantMessageId: null,
      conversationId: conversationOneId,
      id: "40000000-0000-4000-8000-000000000006",
      idempotencyKey: "41000000-0000-4000-8000-000000000006",
      promptVersion: "capstone-compaction-v1",
      purpose: "compaction",
      status: "completed",
    });
    await expect(
      pool.query(`
        INSERT INTO conversation_compactions (
          id, workspace_id, user_id, conversation_id, through_message_id,
          generation_id, summary, source_token_count, summary_token_count,
          model_used, prompt_version, status, completed_at, updated_at
        ) VALUES (
          '50000000-0000-4000-8000-000000000007',
          '${workspaceOneId}',
          '${userId}',
          '${conversationOneId}',
          '${assistantOneId}',
          '40000000-0000-4000-8000-000000000006',
          'Otro resumen',
          12,
          5,
          'capstone/compaction',
          'capstone-compaction-v1',
          'completed',
          now(),
          now()
        )
      `),
    ).rejects.toMatchObject({
      code: "23505",
      constraint: "conversation_compactions_completed_boundary_unique",
    });

    await insertUntrackedGeneration(pool, {
      assistantMessageId: null,
      conversationId: conversationTwoId,
      id: "40000000-0000-4000-8000-000000000008",
      idempotencyKey: "41000000-0000-4000-8000-000000000009",
      promptVersion: "capstone-compaction-v1",
      purpose: "compaction",
      status: "incomplete",
    });
    await expect(
      pool.query(`
        INSERT INTO conversation_compactions (
          id, workspace_id, user_id, conversation_id, through_message_id,
          previous_compaction_id, generation_id, model_used, prompt_version,
          status, completed_at
        ) VALUES (
          '50000000-0000-4000-8000-000000000009',
          '${workspaceOneId}',
          '${userId}',
          '${conversationTwoId}',
          '${assistantOtherId}',
          '50000000-0000-4000-8000-000000000006',
          '40000000-0000-4000-8000-000000000008',
          'capstone/compaction',
          'capstone-compaction-v1',
          'incomplete',
          now()
        )
      `),
    ).rejects.toMatchObject({
      code: "23503",
      constraint: "conversation_compactions_previous_compaction_fk",
    });

    await expect(
      insertUntrackedGeneration(pool, {
        assistantMessageId: assistantOtherId,
        conversationId: conversationTwoId,
        id: "40000000-0000-4000-8000-000000000007",
        idempotencyKey: "41000000-0000-4000-8000-000000000007",
        promptVersion: "capstone-compaction-v1",
        purpose: null,
        status: "active",
      }),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "generations_system_prompt_version_check",
    });
    await expect(
      pool.query(`
        INSERT INTO generations (
          workspace_id, user_id, conversation_id, idempotency_key, requested_tier,
          purpose, system_prompt_version, effective_parameters, status,
          terminal_reason, error_code, completed_at, accounting_status
        ) VALUES (
          '${workspaceOneId}',
          '${userId}',
          '${conversationTwoId}',
          '41000000-0000-4000-8000-000000000008',
          'balanced',
          'compaction',
          'capstone-compaction-v1',
          '{}'::jsonb,
          'failed',
          'error',
          'GENERATION_FAILED',
          now(),
          'actual'
        )
      `),
    ).rejects.toMatchObject({ code: "23514", constraint: "generations_accounting_check" });
    await expect(
      pool.query(`
        INSERT INTO workspace_memberships (
          workspace_id, user_id, role, monthly_soft_budget_usd
        ) VALUES ('${workspaceOneId}', '${userId}', 'member', -0.01)
      `),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "workspace_memberships_soft_budget_check",
    });
    await expect(
      pool.query(`
        INSERT INTO workspace_cost_policies (
          workspace_id, monthly_budget_usd, default_tier,
          employee_active_generation_limit, reservation_margin_basis_points, revision
        ) VALUES ('${workspaceOneId}', 100, 'balanced', 2, 1000, 0)
      `),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "workspace_cost_policies_revision_check",
    });
  });

  it("cascades summaries while retaining immutable accounting and excluding summaries from search", async () => {
    await pool.query(`
      INSERT INTO generations (
        id, workspace_id, user_id, conversation_id, assistant_message_id,
        idempotency_key, requested_tier, purpose, requested_model, resolved_model,
        provider, openrouter_generation_id, system_prompt_version, effective_parameters,
        status, terminal_reason, prompt_tokens, completion_tokens, cost_usd, cost_basis,
        accounting_status, estimated_input_tokens, maximum_output_tokens, reserved_cost_usd,
        prompt_price_ceiling_per_token, completion_price_ceiling_per_token,
        request_price_ceiling_usd, reservation_margin_basis_points,
        budget_period_start, budget_period_end, reservation_expires_at,
        accounting_settled_at, started_at, completed_at, created_at, updated_at
      ) VALUES (
        '70000000-0000-4000-8000-000000000001',
        '${workspaceOneId}',
        '${userId}',
        '${deletionConversationId}',
        NULL,
        '71000000-0000-4000-8000-000000000001',
        'fast',
        'compaction',
        'capstone/compaction',
        'capstone/compaction',
        'simulated',
        'phase-seven-retained',
        'capstone-compaction-v1',
        '{}'::jsonb,
        'completed',
        'stop',
        10,
        4,
        0.123456789012345678,
        'actual',
        'actual',
        12,
        64,
        0.200000000000000000,
        0.000000000000000100000000,
        0.000000000000000200000000,
        0.000000000000000000,
        1000,
        '2026-08-01T00:00:00.000Z',
        '2026-09-01T00:00:00.000Z',
        '2026-08-08T12:06:01.000Z',
        '2026-08-08T12:00:04.000Z',
        '2026-08-08T12:00:01.000Z',
        '2026-08-08T12:00:03.000Z',
        '2026-08-08T12:00:00.000Z',
        '2026-08-08T12:00:04.000Z'
      )
    `);
    await pool.query(`
      INSERT INTO conversation_compactions (
        id, workspace_id, user_id, conversation_id, through_message_id,
        generation_id, summary, source_token_count, summary_token_count,
        model_used, prompt_version, status, completed_at, updated_at
      ) VALUES (
        '70000000-0000-4000-8000-000000000002',
        '${workspaceOneId}',
        '${userId}',
        '${deletionConversationId}',
        '${deletionAssistantId}',
        '70000000-0000-4000-8000-000000000001',
        'secretphase7summary',
        10,
        4,
        'capstone/compaction',
        'capstone-compaction-v1',
        'completed',
        now(),
        now()
      )
    `);
    const searchBeforeDeletion = await pool.query<{ count: string }>(`
      SELECT count(*)::text AS count
      FROM messages
      WHERE content_search_vector @@ to_tsquery('simple', unaccent('secretphase7summary'))
    `);
    expect(searchBeforeDeletion.rows).toEqual([{ count: "0" }]);

    await pool.query("BEGIN");
    try {
      await pool.query(`
        UPDATE generations
        SET conversation_id = NULL
        WHERE id = '70000000-0000-4000-8000-000000000001'
      `);
      await pool.query(`
        DELETE FROM conversations WHERE id = '${deletionConversationId}'
      `);
      await pool.query("COMMIT");
    } catch (error: unknown) {
      await pool.query("ROLLBACK");
      throw error;
    }

    const compactions = await pool.query<{ count: string }>(`
      SELECT count(*)::text AS count
      FROM conversation_compactions
      WHERE conversation_id = '${deletionConversationId}'
    `);
    const retained = await pool.query(`
      SELECT
        conversation_id,
        assistant_message_id,
        purpose,
        provider,
        accounting_status,
        cost_usd::text AS cost_usd,
        system_prompt_version
      FROM generations
      WHERE id = '70000000-0000-4000-8000-000000000001'
    `);
    expect(compactions.rows).toEqual([{ count: "0" }]);
    expect(retained.rows).toEqual([
      {
        accounting_status: "actual",
        assistant_message_id: null,
        conversation_id: null,
        cost_usd: "0.123456789012345678",
        provider: "simulated",
        purpose: "compaction",
        system_prompt_version: "capstone-compaction-v1",
      },
    ]);
  });
});

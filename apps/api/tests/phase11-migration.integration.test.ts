import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_WORKSPACE_ASSISTANT_RULES } from "../src/assistant-rules/defaults.js";
import { createDatabase } from "../src/database/database.js";
import { migrateDatabase, migrationsFolder } from "../src/database/migrate.js";
import { refreshClaimedCatalog } from "../src/model-policy/catalog-refresh.js";
import { createModelPolicyService } from "../src/model-policy/service.js";
import { catalogSnapshotFixture } from "./support/catalog.js";

const workspaceId = "11000000-0000-4000-8000-000000000001";
const userId = "phase-eleven-upgrade-user";
const conversationId = "11000000-0000-4000-8000-000000000002";
const userMessageId = "11000000-0000-4000-8000-000000000003";
const assistantMessageId = "11000000-0000-4000-8000-000000000004";
const generationId = "11000000-0000-4000-8000-000000000005";
const catalogIds = {
  fast: "11000000-0000-4000-8000-000000000011",
  balanced: "11000000-0000-4000-8000-000000000012",
  pro: "11000000-0000-4000-8000-000000000013",
} as const;

function refreshedCatalogSnapshot(
  modelId: string,
  validatedAt: Date,
): ReturnType<typeof catalogSnapshotFixture> {
  return catalogSnapshotFixture({
    capability: Object.freeze({
      reasoning: Object.freeze({
        contractSource: "phase-eleven-upgrade-fixture",
        defaultEffort: null,
        defaultEnabled: false,
        effortSupport: Object.freeze({ kind: "all" as const }),
        exclusionVerifiedAt: validatedAt,
        kind: "optional" as const,
        maxTokensAccepted: true,
        traceSafety: "provider_excluded" as const,
      }),
      temperatureSupported: true,
    }),
    displayName: `Refreshed ${modelId}`,
    maximumOutputTokens: 16_384,
    modelId,
    supportedParameters: ["max_tokens", "reasoning", "reasoning_effort", "temperature"],
    validatedAt,
  });
}

async function applyThrough0008(pool: Pool): Promise<void> {
  const names = [
    "0000_bumpy_living_lightning.sql",
    "0001_conscious_giant_man.sql",
    "0002_great_serpent_society.sql",
    "0003_openrouter_cost_control.sql",
    "0004_compaction_administration.sql",
    "0005_observability_recovery.sql",
    "0006_conversation_generation_lookup.sql",
    "0007_sloppy_northstar.sql",
    "0008_resilient_responses_feedback.sql",
  ] as const;
  const appliedAt = [
    1_786_061_111_713, 1_786_071_863_036, 1_786_119_062_299, 1_786_205_271_465, 1_786_219_479_071,
    1_786_230_000_000, 1_786_294_883_632, 1_786_493_595_627, 1_786_830_339_705,
  ] as const;
  await pool.query("CREATE SCHEMA drizzle");
  await pool.query(`
    CREATE TABLE drizzle.__drizzle_migrations (
      id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint
    )
  `);
  for (const [index, name] of names.entries()) {
    const source = await readFile(resolve(migrationsFolder, name), "utf8");
    for (const statement of source.split("--> statement-breakpoint")) {
      if (statement.trim() !== "") await pool.query(statement);
    }
    await pool.query(
      "INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)",
      [createHash("sha256").update(source).digest("hex"), appliedAt[index]],
    );
  }
}

async function seedPopulated0008(pool: Pool): Promise<void> {
  await pool.query(`
    INSERT INTO workspaces (id, identity, display_name)
    VALUES ('${workspaceId}', 'phase-eleven-upgrade', 'Phase Eleven Upgrade');
    INSERT INTO "user" (id, name, email, email_verified)
    VALUES ('${userId}', 'Persona histórica', 'upgrade@example.test', true);
    INSERT INTO workspace_memberships (
      id, workspace_id, user_id, role, status, activated_at
    ) VALUES (
      '11000000-0000-4000-8000-000000000006', '${workspaceId}', '${userId}',
      'admin', 'active', '2026-07-01T12:00:00.000Z'
    );
    INSERT INTO employee_approvals (
      id, workspace_id, normalized_email, user_id, role, status, activated_at
    ) VALUES (
      '11000000-0000-4000-8000-000000000007', '${workspaceId}',
      'upgrade@example.test', '${userId}', 'admin', 'activated',
      '2026-07-01T12:00:00.000Z'
    );
    INSERT INTO session (id, expires_at, token, created_at, updated_at, user_id)
    VALUES (
      'phase-eleven-expired-session', '2026-07-02T12:00:00.000Z',
      'phase-eleven-expired-token', '2026-07-01T12:00:00.000Z',
      '2026-07-01T12:00:00.000Z', '${userId}'
    );

    INSERT INTO model_catalog (
      id, openrouter_model_id, display_name, canonical_slug, input_modalities,
      output_modalities, supported_parameters, context_length, maximum_output_tokens,
      prompt_price_per_token, completion_price_per_token, request_price_usd,
      metadata_source, approved, available, validated_at
    ) VALUES
      ('${catalogIds.fast}', 'fixture/fast', 'Fixture Fast', 'fixture/fast',
       '["text"]', '["text"]', '["max_tokens","reasoning"]', 128000, 4096,
       0.000001, 0.000002, 0, 'openrouter', true, true, '2026-07-01T12:00:00.000Z'),
      ('${catalogIds.balanced}', 'fixture/balanced', 'Fixture Balanced', 'fixture/balanced',
       '["text"]', '["text"]', '["max_tokens","reasoning"]', 128000, 8192,
       0.000001, 0.000002, 0, 'openrouter', true, true, '2026-07-01T12:00:00.000Z'),
      ('${catalogIds.pro}', 'fixture/pro', 'Fixture Pro', 'fixture/pro',
       '["text"]', '["text"]', '["max_tokens","reasoning"]', 128000, 16384,
       0.000001, 0.000002, 0, 'openrouter', true, true, '2026-07-01T12:00:00.000Z');
    INSERT INTO workspace_catalog_approvals (workspace_id, model_catalog_id)
    VALUES
      ('${workspaceId}', '${catalogIds.fast}'),
      ('${workspaceId}', '${catalogIds.balanced}'),
      ('${workspaceId}', '${catalogIds.pro}');
    INSERT INTO workspace_cost_policies (
      workspace_id, monthly_budget_usd, default_tier,
      employee_active_generation_limit, reservation_margin_basis_points, revision
    ) VALUES ('${workspaceId}', 123.45, 'balanced', 3, 1500, 7);
    INSERT INTO workspace_model_policies (
      workspace_id, tier, model_catalog_id, enabled, maximum_output_tokens
    ) VALUES
      ('${workspaceId}', 'fast', '${catalogIds.fast}', false, 3072),
      ('${workspaceId}', 'balanced', '${catalogIds.balanced}', true, 6144),
      ('${workspaceId}', 'pro', '${catalogIds.pro}', true, 4096);
    INSERT INTO openrouter_privacy_attestations (
      workspace_id, attestation_version, verified_at
    ) VALUES ('${workspaceId}', 'openrouter-privacy-v1', '2026-07-10T12:00:00.000Z');
    INSERT INTO production_initialization (
      singleton_id, schema_version, document_sha256, phase, completed_at
    ) VALUES (1, 1, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'complete', now());

    INSERT INTO conversations (
      id, workspace_id, user_id, title, preferred_tier, automatic_title_pending, revision
    ) VALUES (
      '${conversationId}', '${workspaceId}', '${userId}',
      'Conversación histórica', 'balanced', false, 4
    );
    INSERT INTO messages (id, conversation_id, parent_message_id, role, content)
    VALUES
      ('${userMessageId}', '${conversationId}', NULL, 'user',
       '[{"type":"text","text":"Pregunta histórica"}]'),
      ('${assistantMessageId}', '${conversationId}', '${userMessageId}', 'assistant',
       '[{"type":"text","text":"Respuesta histórica"}]');
    UPDATE conversations SET selected_leaf_message_id = '${assistantMessageId}'
    WHERE id = '${conversationId}';
    INSERT INTO generations (
      id, workspace_id, user_id, conversation_id, assistant_message_id,
      idempotency_key, requested_tier, purpose, requested_model, resolved_model,
      provider, openrouter_generation_id, system_prompt_version, effective_parameters,
      status, terminal_reason, prompt_tokens, completion_tokens, reasoning_tokens,
      cached_tokens, cost_usd, cost_basis, accounting_status, estimated_input_tokens,
      maximum_output_tokens, reserved_cost_usd, prompt_price_ceiling_per_token,
      completion_price_ceiling_per_token, request_price_ceiling_usd,
      reservation_margin_basis_points, budget_period_start, budget_period_end,
      reservation_expires_at, accounting_settled_at, started_at, first_token_at,
      completed_at, created_at, updated_at
    ) VALUES (
      '${generationId}', '${workspaceId}', '${userId}', '${conversationId}',
      '${assistantMessageId}', '11000000-0000-4000-8000-000000000008',
      'balanced', 'chat', 'fixture/balanced', 'fixture/balanced', 'openrouter',
      'provider-generation-history', 'capstone-chat-v1', '{"phase":10}',
      'completed', 'stop', 12, 8, 3, 2, 0.001, 'actual', 'actual',
      10, 6144, 0.01, 0.000001, 0.000002, 0, 1500,
      '2026-07-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z',
      '2026-07-10T13:00:00.000Z', '2026-07-10T12:01:00.000Z',
      '2026-07-10T12:00:00.000Z', '2026-07-10T12:00:01.000Z',
      '2026-07-10T12:01:00.000Z', '2026-07-10T12:00:00.000Z',
      '2026-07-10T12:01:00.000Z'
    );
    INSERT INTO answer_reports (
      id, workspace_id, user_id, conversation_id, generation_id,
      assistant_message_id, reason, note
    ) VALUES (
      '11000000-0000-4000-8000-000000000009', '${workspaceId}', '${userId}',
      '${conversationId}', '${generationId}', '${assistantMessageId}',
      'incorrect', 'Reporte histórico'
    );
  `);
}

describe("Phase 11 additive migration", () => {
  let container: StartedPostgreSqlContainer | undefined;
  let databaseUrl: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:18.4-alpine")
      .withDatabase("capstone_phase_eleven_upgrade")
      .withUsername("capstone")
      .withPassword("capstone-test-password")
      .start();
    databaseUrl = container.getConnectionUri();
  });

  afterAll(async () => container?.stop());

  it("preserves populated 0008 authority and permits predecessor generation writes", async () => {
    const pool = new Pool({ connectionString: databaseUrl });
    try {
      await applyThrough0008(pool);
      await seedPopulated0008(pool);
      const before = await pool.query(`
        SELECT
          (SELECT row_to_json(value) FROM (
            SELECT monthly_budget_usd::text, default_tier,
              employee_active_generation_limit, reservation_margin_basis_points, revision
            FROM workspace_cost_policies WHERE workspace_id = '${workspaceId}'
          ) AS value) AS cost,
          (SELECT row_to_json(value) FROM (
            SELECT system_prompt_version, status::text, cost_usd::text,
              prompt_tokens::text, completion_tokens::text, reasoning_tokens::text,
              cached_tokens::text, effective_parameters
            FROM generations WHERE id = '${generationId}'
          ) AS value) AS generation,
          (SELECT row_to_json(value) FROM (
            SELECT schema_version, document_sha256, phase
            FROM production_initialization WHERE singleton_id = 1
          ) AS value) AS authority
      `);

      await expect(migrateDatabase(databaseUrl)).resolves.toBeUndefined();
      await expect(migrateDatabase(databaseUrl)).resolves.toBeUndefined();

      const after = await pool.query(`
        SELECT
          (SELECT row_to_json(value) FROM (
            SELECT monthly_budget_usd::text, default_tier,
              employee_active_generation_limit, reservation_margin_basis_points, revision
            FROM workspace_cost_policies WHERE workspace_id = '${workspaceId}'
          ) AS value) AS cost,
          (SELECT row_to_json(value) FROM (
            SELECT system_prompt_version, status::text, cost_usd::text,
              prompt_tokens::text, completion_tokens::text, reasoning_tokens::text,
              cached_tokens::text, effective_parameters
            FROM generations WHERE id = '${generationId}'
          ) AS value) AS generation,
          (SELECT row_to_json(value) FROM (
            SELECT schema_version, document_sha256, phase
            FROM production_initialization WHERE singleton_id = 1
          ) AS value) AS authority
      `);
      expect(after.rows).toEqual(before.rows);

      const migrated = await pool.query(`
        SELECT
          (SELECT count(*)::integer FROM drizzle.__drizzle_migrations) AS migration_count,
          (SELECT jsonb_build_object(
            'revision', revision, 'text', workspace_text,
            'actor', actor_kind, 'change', change_kind
          ) FROM workspace_assistant_prompt_revisions
            WHERE workspace_id = '${workspaceId}') AS prompt,
          (SELECT jsonb_build_object(
            'revision', revision, 'defaultTier', default_tier,
            'budget', monthly_budget_usd::text, 'actor', actor_kind, 'change', change_kind
          ) FROM workspace_model_policy_revisions
            WHERE workspace_id = '${workspaceId}') AS policy,
          (SELECT jsonb_agg(jsonb_build_object(
            'tier', tier, 'catalogId', model_catalog_id, 'enabled', enabled,
            'output', maximum_output_tokens, 'effort', reasoning_effort,
            'budget', reasoning_budget_tokens, 'temperature', temperature_preset
          ) ORDER BY tier) FROM workspace_model_policy_revision_tiers
            WHERE workspace_id = '${workspaceId}') AS tiers,
          (SELECT jsonb_agg(jsonb_build_object(
            'available', available, 'mode', reasoning_mode, 'trace', reasoning_trace_safety
          ) ORDER BY openrouter_model_id) FROM model_catalog) AS catalog,
          (SELECT jsonb_build_object(
            'version', behavior_contract_version,
            'policy', model_policy_revision, 'prompt', workspace_prompt_revision
          ) FROM generations WHERE id = '${generationId}') AS generation_contract,
          (SELECT count(*)::integer FROM workspace_catalog_approvals) AS approvals,
          (SELECT count(*)::integer FROM answer_reports) AS reports,
          (SELECT count(*)::integer FROM session
            WHERE id = 'phase-eleven-expired-session') AS expired_sessions
      `);
      expect(migrated.rows[0]).toMatchObject({
        approvals: 3,
        expired_sessions: 1,
        generation_contract: { policy: null, prompt: null, version: 1 },
        migration_count: 10,
        policy: {
          actor: "system",
          budget: "123.450000000000000000",
          change: "migration",
          defaultTier: "balanced",
          revision: 7,
        },
        prompt: {
          actor: "system",
          change: "migration",
          revision: 1,
          text: DEFAULT_WORKSPACE_ASSISTANT_RULES,
        },
        reports: 1,
      });
      expect(migrated.rows[0]?.catalog).toEqual([
        { available: false, mode: "unverified", trace: "unverified" },
        { available: false, mode: "unverified", trace: "unverified" },
        { available: false, mode: "unverified", trace: "unverified" },
      ]);
      expect(migrated.rows[0]?.tiers).toEqual([
        {
          budget: 0,
          catalogId: catalogIds.balanced,
          effort: "off",
          enabled: true,
          output: 6144,
          temperature: "balanced",
          tier: "balanced",
        },
        {
          budget: 0,
          catalogId: catalogIds.fast,
          effort: "off",
          enabled: false,
          output: 3072,
          temperature: "precise",
          tier: "fast",
        },
        {
          budget: 8192,
          catalogId: catalogIds.pro,
          effort: "high",
          enabled: true,
          output: 4096,
          temperature: "balanced",
          tier: "pro",
        },
      ]);

      const predecessorWrite = await pool.query(`
        INSERT INTO generations (
          workspace_id, user_id, idempotency_key, requested_tier, purpose,
          system_prompt_version, effective_parameters, status, terminal_reason, completed_at
        ) VALUES (
          '${workspaceId}', '${userId}', '11000000-0000-4000-8000-000000000010',
          'balanced', 'chat', 'capstone-chat-v1', '{}', 'completed', 'stop', now()
        )
        RETURNING behavior_contract_version, model_policy_revision, workspace_prompt_revision
      `);
      expect(predecessorWrite.rows).toEqual([
        {
          behavior_contract_version: 1,
          model_policy_revision: null,
          workspace_prompt_revision: null,
        },
      ]);

      await pool.query(`
        INSERT INTO generations (
          workspace_id, user_id, idempotency_key, requested_tier, purpose,
          system_prompt_version, behavior_contract_version, model_policy_revision,
          workspace_prompt_revision, effective_parameters, status, terminal_reason, completed_at
        ) VALUES (
          '${workspaceId}', '${userId}', '11000000-0000-4000-8000-000000000011',
          'balanced', 'chat', 'capstone-chat-base-v2', 2, 7, 1,
          '{}', 'completed', 'stop', now()
        )
      `);
      await expect(migrateDatabase(databaseUrl)).resolves.toBeUndefined();

      const validatedAt = new Date("2026-08-19T12:00:00.000Z");
      const refresh = await refreshClaimedCatalog({
        force: true,
        loadSnapshots: async (modelIds) =>
          modelIds.map((modelId) => refreshedCatalogSnapshot(modelId, validatedAt)),
        modelPolicy: createModelPolicyService(createDatabase(pool)),
        ownerId: "11000000-0000-4000-8000-000000000020",
        signal: new AbortController().signal,
      });
      expect(refresh).toEqual({ available: 3, claimed: 3, unavailable: 0, updated: 3 });

      const refreshed = await pool.query(`
        SELECT available, reasoning_mode, reasoning_trace_safety,
          reasoning_effort_support_kind, temperature_supported, reasoning_contract_source
        FROM model_catalog
        ORDER BY openrouter_model_id
      `);
      expect(refreshed.rows).toEqual([
        {
          available: true,
          reasoning_contract_source: "phase-eleven-upgrade-fixture",
          reasoning_effort_support_kind: "all",
          reasoning_mode: "optional",
          reasoning_trace_safety: "provider_excluded",
          temperature_supported: true,
        },
        {
          available: true,
          reasoning_contract_source: "phase-eleven-upgrade-fixture",
          reasoning_effort_support_kind: "all",
          reasoning_mode: "optional",
          reasoning_trace_safety: "provider_excluded",
          temperature_supported: true,
        },
        {
          available: true,
          reasoning_contract_source: "phase-eleven-upgrade-fixture",
          reasoning_effort_support_kind: "all",
          reasoning_mode: "optional",
          reasoning_trace_safety: "provider_excluded",
          temperature_supported: true,
        },
      ]);
    } finally {
      await pool.end();
    }
  }, 120_000);
});

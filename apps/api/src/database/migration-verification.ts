import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool, QueryResultRow } from "pg";

const migrationFilePattern = /^\d{4}_.+\.sql$/u;

export const migrationsFolder = fileURLToPath(new URL("../../migrations", import.meta.url));

export type MigrationVerificationCode =
  | "history-diverged"
  | "history-unavailable"
  | "schema-incomplete"
  | "schema-without-history";

type MigrationObjectKind = "constraint" | "function" | "index" | "table";

interface MigrationObjectDiagnostic {
  readonly migrationObjectCount: number;
  readonly migrationObjectKind: MigrationObjectKind;
  readonly migrationObjectName: string;
}

export class MigrationVerificationError extends Error {
  readonly migrationObjectCount: number | undefined;
  readonly migrationObjectKind: MigrationObjectKind | undefined;
  readonly migrationObjectName: string | undefined;
  readonly operationalCode: MigrationVerificationCode;

  constructor(
    operationalCode: MigrationVerificationCode,
    message: string,
    options: ErrorOptions = {},
    diagnostic?: MigrationObjectDiagnostic,
  ) {
    super(message, options);
    this.name = "MigrationVerificationError";
    this.operationalCode = operationalCode;
    this.migrationObjectCount = diagnostic?.migrationObjectCount;
    this.migrationObjectKind = diagnostic?.migrationObjectKind;
    this.migrationObjectName = diagnostic?.migrationObjectName;
  }
}

export interface MigrationObjectsEvidence {
  readonly constraints: number;
  readonly functions: number;
  readonly indexes: number;
  readonly tables: number;
}

interface MigrationManifestEntry {
  readonly hash: string;
  readonly sentinelKind: "index" | "table";
  readonly sentinelRegclass: string;
  readonly tag: string;
  readonly timestamp: number;
}

export interface MigrationManifest extends MigrationObjectsEvidence {
  readonly constraintNames: readonly string[];
  readonly entries: readonly MigrationManifestEntry[];
  readonly functionNames: readonly string[];
  readonly indexNames: readonly string[];
  readonly tableNames: readonly string[];
}

interface MigrationJournal {
  readonly dialect?: unknown;
  readonly entries?: unknown;
  readonly version?: unknown;
}

interface JournalEntry {
  readonly idx?: unknown;
  readonly tag?: unknown;
  readonly when?: unknown;
}

interface NamedObjectRow extends QueryResultRow {
  readonly name: string;
}

interface CriticalIndexRow extends QueryResultRow {
  readonly definition: string;
  readonly name: string;
}

// PostgreSQL 18 renders these definitions deterministically. Hashing the reviewed definitions
// verifies future enforcement without scanning application rows during every migration job.
const criticalConstraintDefinitionHashes = Object.freeze({
  generations_model_policy_revision_fk:
    "3da5c0edf8746f457f170c256cc70ea13d89011b82d3736c9f5e9e2c09ec6392",
  generations_system_prompt_version_check:
    "57f9155b588fb149034bea48911ef0436a1c9a1bd60de07daaeb52f5ffbab9c2",
  generations_workspace_prompt_revision_fk:
    "410cd0587d1ec0b59f5f4bab9545eabf688c8d586f1b475a97089fd07276ab85",
  workspace_assistant_prompts_revision_fk:
    "05f0fa7b9afb050a1bf2eb29c19bf5c90907ade65ffd803c1319d2c6bcedcfee",
  workspace_cost_policies_revision_fk:
    "281321ad9443b00623b217f668fc612f32a35efee62afa1a3a4355799ca29307",
});

// This is a reviewed release contract. The database integration suite independently derives these
// names from the ordered migration SQL, so a new migration cannot silently omit owned objects.
const migrationObjectContract = Object.freeze({
  constraintNames: Object.freeze([
    "account_user_id_user_id_fk",
    "answer_reports_assistant_message_fk",
    "answer_reports_generation_id_generations_id_fk",
    "answer_reports_note_check",
    "answer_reports_owned_conversation_fk",
    "answer_reports_user_id_user_id_fk",
    "answer_reports_workspace_id_workspaces_id_fk",
    "client_error_rate_limit_count_check",
    "client_error_rate_limit_hash_check",
    "client_error_rate_limit_scope_check",
    "client_error_rate_limit_window_check",
    "client_error_rate_limit_windows_pk",
    "conversation_compactions_conversation_id_id_unique",
    "conversation_compactions_generation_id_generations_id_fk",
    "conversation_compactions_lifecycle_check",
    "conversation_compactions_nonempty_text_check",
    "conversation_compactions_owned_conversation_fk",
    "conversation_compactions_previous_compaction_fk",
    "conversation_compactions_previous_not_self_check",
    "conversation_compactions_through_message_fk",
    "conversation_compactions_timestamps_check",
    "conversations_automatic_title_settled_revision_check",
    "conversations_preferred_tier_check",
    "conversations_revision_nonnegative_check",
    "conversations_same_conversation_selected_leaf_fk",
    "conversations_title_nonempty_check",
    "conversations_user_id_user_id_fk",
    "conversations_workspace_id_workspaces_id_fk",
    "drafts_owned_conversation_fk",
    "drafts_revision_nonnegative_check",
    "drafts_user_id_user_id_fk",
    "drafts_workspace_id_workspaces_id_fk",
    "employee_approvals_lifecycle_check",
    "employee_approvals_user_id_user_id_fk",
    "employee_approvals_workspace_id_workspaces_id_fk",
    "generations_accounting_check",
    "generations_assistant_message_fk",
    "generations_content_references_check",
    "generations_effective_parameters_check",
    "generations_lifecycle_check",
    "generations_model_policy_revision_fk",
    "generations_owned_conversation_fk",
    "generations_requested_tier_check",
    "generations_system_prompt_version_check",
    "generations_timestamps_check",
    "generations_token_counts_check",
    "generations_user_id_user_id_fk",
    "generations_workspace_id_workspaces_id_fk",
    "generations_workspace_prompt_revision_fk",
    "messages_content_array_check",
    "messages_conversation_id_conversations_id_fk",
    "messages_conversation_id_id_unique",
    "messages_root_user_check",
    "messages_same_conversation_parent_fk",
    "model_catalog_array_metadata_check",
    "model_catalog_limits_check",
    "model_catalog_nonempty_text_check",
    "model_catalog_prices_check",
    "model_catalog_reasoning_check",
    "model_catalog_refresh_lease_check",
    "model_catalog_source_check",
    "model_catalog_timestamps_check",
    "openrouter_privacy_attestations_timestamps_check",
    "openrouter_privacy_attestations_version_check",
    "openrouter_privacy_attestations_workspace_id_workspaces_id_fk",
    "operational_recovery_markers_kind_check",
    "production_initialization_hash_check",
    "production_initialization_lifecycle_check",
    "production_initialization_phase_check",
    "production_initialization_schema_check",
    "production_initialization_singleton_check",
    "production_initialization_timestamps_check",
    "rate_limit_key_unique",
    "session_token_unique",
    "session_user_id_user_id_fk",
    "user_email_unique",
    "workspace_assistant_prompt_revisions_actor_check",
    "workspace_assistant_prompt_revisions_actor_membership_fk",
    "workspace_assistant_prompt_revisions_attribution_check",
    "workspace_assistant_prompt_revisions_change_check",
    "workspace_assistant_prompt_revisions_reverted_from_fk",
    "workspace_assistant_prompt_revisions_revision_check",
    "workspace_assistant_prompt_revisions_text_check",
    "workspace_assistant_prompt_revisions_workspace_id_workspaces_id",
    "workspace_assistant_prompt_revisions_workspace_revision_pk",
    "workspace_assistant_prompts_revision_check",
    "workspace_assistant_prompts_revision_fk",
    "workspace_assistant_prompts_workspace_id_workspaces_id_fk",
    "workspace_catalog_approvals_model_catalog_id_model_catalog_id_f",
    "workspace_catalog_approvals_workspace_catalog_pk",
    "workspace_catalog_approvals_workspace_id_workspaces_id_fk",
    "workspace_cost_policies_budget_check",
    "workspace_cost_policies_default_tier_check",
    "workspace_cost_policies_generation_limit_check",
    "workspace_cost_policies_margin_check",
    "workspace_cost_policies_revision_check",
    "workspace_cost_policies_revision_fk",
    "workspace_cost_policies_timestamps_check",
    "workspace_cost_policies_workspace_id_workspaces_id_fk",
    "workspace_memberships_lifecycle_check",
    "workspace_memberships_soft_budget_check",
    "workspace_memberships_user_id_user_id_fk",
    "workspace_memberships_workspace_id_workspaces_id_fk",
    "workspace_model_policies_controls_check",
    "workspace_model_policies_model_catalog_id_model_catalog_id_fk",
    "workspace_model_policies_tier_check",
    "workspace_model_policies_timestamps_check",
    "workspace_model_policies_workspace_id_workspaces_id_fk",
    "workspace_model_policies_workspace_tier_pk",
    "workspace_model_policy_revision_tiers_controls_check",
    "workspace_model_policy_revision_tiers_model_catalog_id_model_ca",
    "workspace_model_policy_revision_tiers_revision_fk",
    "workspace_model_policy_revision_tiers_tier_check",
    "workspace_model_policy_revision_tiers_workspace_revision_tier_p",
    "workspace_model_policy_revisions_actor_check",
    "workspace_model_policy_revisions_actor_membership_fk",
    "workspace_model_policy_revisions_attribution_check",
    "workspace_model_policy_revisions_change_check",
    "workspace_model_policy_revisions_reverted_from_fk",
    "workspace_model_policy_revisions_revision_check",
    "workspace_model_policy_revisions_values_check",
    "workspace_model_policy_revisions_workspace_id_workspaces_id_fk",
    "workspace_model_policy_revisions_workspace_revision_pk",
    "workspaces_identity_unique",
  ]),
  functionNames: Object.freeze(["capstone_search_normalize"]),
  indexNames: Object.freeze([
    "account_userId_idx",
    "answer_reports_assistant_message_unique",
    "answer_reports_generation_unique",
    "answer_reports_workspace_inbox_idx",
    "client_error_rate_limit_expiry_idx",
    "conversation_compactions_completed_boundary_unique",
    "conversation_compactions_conversation_status_idx",
    "conversation_compactions_generation_unique",
    "conversation_compactions_previous_idx",
    "conversations_owner_active_history_idx",
    "conversations_owner_archived_history_idx",
    "conversations_owner_id_unique",
    "conversations_title_search_idx",
    "drafts_conversation_scope_unique",
    "drafts_new_chat_scope_unique",
    "employee_approvals_user_idx",
    "employee_approvals_workspace_email_unique",
    "employee_approvals_workspace_user_unique",
    "generations_active_conversation_unique",
    "generations_assistant_message_unique",
    "generations_chat_workflow_conversation_unique",
    "generations_conversation_idx",
    "generations_finalizing_completed_idx",
    "generations_openrouter_generation_id_unique",
    "generations_reserved_expiry_idx",
    "generations_scoped_idempotency_unique",
    "generations_title_conversation_unique",
    "generations_workspace_budget_period_idx",
    "messages_content_search_idx",
    "messages_conversation_created_idx",
    "messages_parent_idx",
    "model_catalog_openrouter_model_id_unique",
    "model_catalog_refresh_lease_idx",
    "session_userId_idx",
    "verification_identifier_idx",
    "workspace_catalog_approvals_catalog_idx",
    "workspace_memberships_user_status_idx",
    "workspace_memberships_workspace_user_unique",
    "workspace_model_policies_catalog_idx",
    "workspace_model_policy_revision_tiers_catalog_idx",
  ]),
  tableNames: Object.freeze([
    "account",
    "answer_reports",
    "client_error_rate_limit_windows",
    "conversation_compactions",
    "conversations",
    "drafts",
    "employee_approvals",
    "generations",
    "messages",
    "model_catalog",
    "openrouter_privacy_attestations",
    "operational_recovery_markers",
    "production_initialization",
    "rate_limit",
    "session",
    "user",
    "verification",
    "workspace_assistant_prompt_revisions",
    "workspace_assistant_prompts",
    "workspace_catalog_approvals",
    "workspace_cost_policies",
    "workspace_memberships",
    "workspace_model_policies",
    "workspace_model_policy_revision_tiers",
    "workspace_model_policy_revisions",
    "workspaces",
  ]),
});

const migrationPrefixContract = Object.freeze([
  Object.freeze({ kind: "table", regclass: "public.account", tag: "0000_bumpy_living_lightning" }),
  Object.freeze({
    kind: "table",
    regclass: "public.conversations",
    tag: "0001_conscious_giant_man",
  }),
  Object.freeze({
    kind: "table",
    regclass: "public.generations",
    tag: "0002_great_serpent_society",
  }),
  Object.freeze({
    kind: "table",
    regclass: "public.model_catalog",
    tag: "0003_openrouter_cost_control",
  }),
  Object.freeze({
    kind: "table",
    regclass: "public.conversation_compactions",
    tag: "0004_compaction_administration",
  }),
  Object.freeze({
    kind: "table",
    regclass: "public.client_error_rate_limit_windows",
    tag: "0005_observability_recovery",
  }),
  Object.freeze({
    kind: "index",
    regclass: "public.generations_conversation_idx",
    tag: "0006_conversation_generation_lookup",
  }),
  Object.freeze({
    kind: "table",
    regclass: "public.production_initialization",
    tag: "0007_sloppy_northstar",
  }),
  Object.freeze({
    kind: "table",
    regclass: "public.answer_reports",
    tag: "0008_resilient_responses_feedback",
  }),
  Object.freeze({
    kind: "table",
    regclass: "public.workspace_assistant_prompts",
    tag: "0009_workspace_behavior_controls",
  }),
]);

function verificationFailed(
  operationalCode: MigrationVerificationCode,
  message: string,
  cause?: unknown,
  diagnostic?: MigrationObjectDiagnostic,
): never {
  throw new MigrationVerificationError(
    operationalCode,
    message,
    cause === undefined ? {} : { cause },
    diagnostic,
  );
}

function journalEntries(value: unknown): readonly Readonly<{
  idx: number;
  tag: string;
  timestamp: number;
}>[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    verificationFailed("history-unavailable", "Migration journal is invalid");
  }
  const journal = value as MigrationJournal;
  if (
    journal.version !== "7" ||
    journal.dialect !== "postgresql" ||
    !Array.isArray(journal.entries)
  ) {
    verificationFailed("history-unavailable", "Migration journal is invalid");
  }
  return journal.entries.map((candidate, position) => {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
      verificationFailed("history-unavailable", "Migration journal entry is invalid");
    }
    const entry = candidate as JournalEntry;
    if (
      entry.idx !== position ||
      typeof entry.tag !== "string" ||
      !/^\d{4}_[a-z0-9_]+$/u.test(entry.tag) ||
      typeof entry.when !== "number" ||
      !Number.isSafeInteger(entry.when) ||
      entry.when <= 0
    ) {
      verificationFailed("history-unavailable", "Migration journal entry is invalid");
    }
    return Object.freeze({ idx: position, tag: entry.tag, timestamp: entry.when });
  });
}

export async function loadMigrationManifest(): Promise<MigrationManifest> {
  let fileNames: readonly string[];
  let parsedJournal: unknown;
  try {
    [fileNames, parsedJournal] = await Promise.all([
      readdir(migrationsFolder).then((names) =>
        names.filter((fileName) => migrationFilePattern.test(fileName)).sort(),
      ),
      readFile(resolve(migrationsFolder, "meta/_journal.json"), "utf8").then((contents) =>
        JSON.parse(contents),
      ),
    ]);
  } catch (error: unknown) {
    verificationFailed("history-unavailable", "Migration history is unavailable", error);
  }

  const journal = journalEntries(parsedJournal);
  if (
    journal.length !== migrationPrefixContract.length ||
    journal.some((entry, index) => entry.tag !== migrationPrefixContract[index]?.tag)
  ) {
    verificationFailed("history-unavailable", "Migration prefix contract is incomplete");
  }
  const expectedFiles = journal.map(({ tag }) => `${tag}.sql`);
  if (
    journal.length === 0 ||
    fileNames.length !== expectedFiles.length ||
    fileNames.some((fileName, index) => fileName !== expectedFiles[index])
  ) {
    verificationFailed("history-unavailable", "Migration files do not match the journal");
  }

  let migrationSql: readonly string[];
  try {
    migrationSql = await Promise.all(
      expectedFiles.map((fileName) => readFile(resolve(migrationsFolder, fileName), "utf8")),
    );
  } catch (error: unknown) {
    verificationFailed("history-unavailable", "Migration history is unavailable", error);
  }
  return Object.freeze({
    constraintNames: migrationObjectContract.constraintNames,
    constraints: migrationObjectContract.constraintNames.length,
    entries: Object.freeze(
      journal.map((entry, index) =>
        Object.freeze({
          hash: createHash("sha256")
            .update(migrationSql[index] ?? "")
            .digest("hex"),
          sentinelKind: migrationPrefixContract[index]?.kind ?? "table",
          sentinelRegclass: migrationPrefixContract[index]?.regclass ?? "",
          tag: entry.tag,
          timestamp: entry.timestamp,
        }),
      ),
    ),
    functionNames: migrationObjectContract.functionNames,
    functions: migrationObjectContract.functionNames.length,
    indexNames: migrationObjectContract.indexNames,
    indexes: migrationObjectContract.indexNames.length,
    tableNames: migrationObjectContract.tableNames,
    tables: migrationObjectContract.tableNames.length,
  });
}

async function migrationLedger(
  pool: Pool,
): Promise<readonly Readonly<{ hash: string; timestamp: number }>[]> {
  const state = await pool.query<{ ledgerName: string | null; productTableCount: number }>(`
    SELECT
      to_regclass('drizzle.__drizzle_migrations')::text AS "ledgerName",
      (
        SELECT count(*)::integer
        FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ) AS "productTableCount"
  `);
  const row = state.rows[0];
  if (row === undefined) {
    verificationFailed("history-unavailable", "Migration state is unavailable");
  }
  if (row.ledgerName === null) {
    if (row.productTableCount !== 0) {
      verificationFailed(
        "schema-without-history",
        "Product schema exists without a migration ledger",
      );
    }
    return [];
  }

  const ledger = await pool.query<{ hash: string; timestamp: string | null }>(`
    SELECT hash, created_at::text AS timestamp
    FROM drizzle.__drizzle_migrations
    ORDER BY created_at, id
  `);
  if (ledger.rows.length === 0 && row.productTableCount !== 0) {
    verificationFailed("schema-without-history", "Product schema exists without migration history");
  }
  return ledger.rows.map(({ hash, timestamp }) => {
    const parsed = Number(timestamp);
    if (!/^[a-f0-9]{64}$/u.test(hash) || !Number.isSafeInteger(parsed) || parsed <= 0) {
      verificationFailed("history-diverged", "Migration ledger contains an invalid entry");
    }
    return Object.freeze({ hash, timestamp: parsed });
  });
}

export async function verifyMigrationPrefix(
  pool: Pool,
  manifest: MigrationManifest,
  allowedMissingAppliedSentinels: ReadonlySet<string> = new Set(),
): Promise<number> {
  const ledger = await migrationLedger(pool);
  if (ledger.length > manifest.entries.length) {
    verificationFailed("history-diverged", "Migration ledger is ahead of this release");
  }
  for (const [index, actual] of ledger.entries()) {
    const expected = manifest.entries[index];
    if (
      expected === undefined ||
      actual.hash !== expected.hash ||
      actual.timestamp !== expected.timestamp
    ) {
      verificationFailed("history-diverged", "Migration ledger diverges from this release");
    }
  }
  const sentinels = await pool.query<{ ordinal: number; present: boolean }>(
    `
      SELECT sentinel.ordinality::integer AS ordinal,
        to_regclass(sentinel.name) IS NOT NULL AS present
      FROM unnest($1::text[]) WITH ORDINALITY AS sentinel(name, ordinality)
      ORDER BY sentinel.ordinality
    `,
    [manifest.entries.map((entry) => entry.sentinelRegclass)],
  );
  if (sentinels.rows.length !== manifest.entries.length) {
    verificationFailed("history-unavailable", "Migration prefix contract is unavailable");
  }
  for (const sentinel of sentinels.rows) {
    const migrationIndex = sentinel.ordinal - 1;
    const sentinelName = manifest.entries[migrationIndex]?.sentinelRegclass;
    if (
      migrationIndex < ledger.length &&
      !sentinel.present &&
      (sentinelName === undefined || !allowedMissingAppliedSentinels.has(sentinelName))
    ) {
      const entry = manifest.entries[migrationIndex];
      verificationFailed(
        "schema-incomplete",
        "Applied migration schema is incomplete",
        undefined,
        entry === undefined
          ? undefined
          : {
              migrationObjectCount: 1,
              migrationObjectKind: entry.sentinelKind,
              migrationObjectName: entry.sentinelRegclass.replace(/^public\./u, ""),
            },
      );
    }
    if (migrationIndex >= ledger.length && sentinel.present) {
      verificationFailed("history-diverged", "Database schema is ahead of its migration ledger");
    }
  }
  return ledger.length;
}

function assertObjectNames(
  actualRows: readonly NamedObjectRow[],
  expectedNames: readonly string[],
  kind: MigrationObjectKind,
): void {
  const actualNames = new Set(actualRows.map((row) => row.name));
  const missingNames = expectedNames.filter((name) => !actualNames.has(name));
  const firstMissing = missingNames[0];
  if (firstMissing !== undefined) {
    verificationFailed(
      "schema-incomplete",
      `Migration-owned ${kind} objects are incomplete`,
      undefined,
      {
        migrationObjectCount: missingNames.length,
        migrationObjectKind: kind,
        migrationObjectName: firstMissing,
      },
    );
  }
}

export async function verifyMigrationObjects(
  pool: Pool,
  manifest: MigrationManifest,
): Promise<void> {
  const appliedCount = await verifyMigrationPrefix(pool, manifest);
  if (appliedCount !== manifest.entries.length) {
    verificationFailed("schema-incomplete", "Migration history is incomplete after execution");
  }

  const [
    tables,
    indexes,
    constraints,
    functions,
    extension,
    generatedColumns,
    criticalIndexes,
    criticalConstraints,
  ] = await Promise.all([
    pool.query<NamedObjectRow>(`
        SELECT table_name AS name
        FROM information_schema.tables
        WHERE table_schema = 'public'
      `),
    pool.query<NamedObjectRow>(`
        SELECT indexname AS name
        FROM pg_catalog.pg_indexes
        WHERE schemaname = 'public'
      `),
    pool.query<NamedObjectRow>(`
        SELECT constraint_record.conname AS name
        FROM pg_catalog.pg_constraint AS constraint_record
        INNER JOIN pg_catalog.pg_namespace AS namespace
          ON namespace.oid = constraint_record.connamespace
        WHERE namespace.nspname = 'public' AND constraint_record.convalidated
      `),
    pool.query<NamedObjectRow>(`
        SELECT procedure.proname AS name
        FROM pg_catalog.pg_proc AS procedure
        INNER JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
        WHERE namespace.nspname = 'public'
      `),
    pool.query<{ schemaName: string }>(`
        SELECT namespace.nspname AS "schemaName"
        FROM pg_catalog.pg_extension AS extension
        INNER JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = extension.extnamespace
        WHERE extension.extname = 'unaccent'
      `),
    pool.query<{ columnName: string; generated: string }>(`
        SELECT column_name AS "columnName", is_generated AS generated
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND (table_name, column_name) IN (
            ('conversations', 'title_search_vector'),
            ('messages', 'content_search_vector')
          )
      `),
    pool.query<CriticalIndexRow>(`
        SELECT indexname AS name, indexdef AS definition
        FROM pg_catalog.pg_indexes
        WHERE schemaname = 'public'
          AND indexname IN (
            'conversations_title_search_idx',
            'messages_content_search_idx',
            'generations_conversation_idx'
          )
      `),
    pool.query<CriticalIndexRow>(
      `
        SELECT constraint_record.conname AS name,
          pg_get_constraintdef(constraint_record.oid, false) AS definition
        FROM pg_catalog.pg_constraint AS constraint_record
        WHERE constraint_record.conname = ANY($1::text[])
      `,
      [Object.keys(criticalConstraintDefinitionHashes)],
    ),
  ]);

  assertObjectNames(tables.rows, manifest.tableNames, "table");
  assertObjectNames(indexes.rows, manifest.indexNames, "index");
  assertObjectNames(constraints.rows, manifest.constraintNames, "constraint");
  assertObjectNames(functions.rows, manifest.functionNames, "function");
  if (extension.rows[0]?.schemaName !== "public") {
    verificationFailed("schema-incomplete", "Required unaccent extension is unavailable");
  }
  if (
    generatedColumns.rows.length !== 2 ||
    generatedColumns.rows.some((column) => column.generated !== "ALWAYS")
  ) {
    verificationFailed("schema-incomplete", "Generated search columns are unavailable");
  }
  const criticalIndexDefinitions = new Map(
    criticalIndexes.rows.map((row) => [row.name, row.definition]),
  );
  const criticalIndexContract = [
    ["conversations_title_search_idx", /USING gin \(title_search_vector\)/u],
    ["messages_content_search_idx", /USING gin \(content_search_vector\)/u],
    [
      "generations_conversation_idx",
      /USING btree \(conversation_id\).*WHERE \(conversation_id IS NOT NULL\)/u,
    ],
  ] as const;
  const invalidCriticalIndex = criticalIndexContract.find(
    ([name, pattern]) => !pattern.test(criticalIndexDefinitions.get(name) ?? ""),
  );
  if (invalidCriticalIndex !== undefined) {
    verificationFailed(
      "schema-incomplete",
      "Critical migration index definition is invalid",
      undefined,
      {
        migrationObjectCount: 1,
        migrationObjectKind: "index",
        migrationObjectName: invalidCriticalIndex[0],
      },
    );
  }
  const criticalConstraintDefinitions = new Map(
    criticalConstraints.rows.map((row) => [row.name, row.definition]),
  );
  const invalidCriticalConstraint = Object.entries(criticalConstraintDefinitionHashes).find(
    ([name, expectedHash]) =>
      createHash("sha256")
        .update(criticalConstraintDefinitions.get(name) ?? "")
        .digest("hex") !== expectedHash,
  );
  if (invalidCriticalConstraint !== undefined) {
    verificationFailed(
      "schema-incomplete",
      "Critical migration constraint definition is invalid",
      undefined,
      {
        migrationObjectCount: 1,
        migrationObjectKind: "constraint",
        migrationObjectName: invalidCriticalConstraint[0],
      },
    );
  }
  const selectedLeafConstraint = await pool.query<{
    deferred: boolean;
    deferrable: boolean;
  }>(`
    SELECT condeferrable AS deferrable, condeferred AS deferred
    FROM pg_catalog.pg_constraint
    WHERE conname = 'conversations_same_conversation_selected_leaf_fk'
  `);
  if (
    selectedLeafConstraint.rows[0]?.deferrable !== true ||
    selectedLeafConstraint.rows[0]?.deferred !== true
  ) {
    verificationFailed("schema-incomplete", "Deferred conversation leaf constraint is invalid");
  }
  const searchProbe = await pool.query<{ normalized: string }>(
    "SELECT public.capstone_search_normalize('ÁRBOL') AS normalized",
  );
  if (searchProbe.rows[0]?.normalized !== "arbol") {
    verificationFailed("schema-incomplete", "Search normalization function is invalid");
  }
}

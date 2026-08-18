import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Pool, QueryResultRow } from "pg";
import { applyMigrations, migrationsFolder } from "./migrate.js";
import { recoveryPreparationFailed } from "./recovery-error.js";

const migrationFilePattern = /^\d{4}_.+\.sql$/u;
const manualRepairStatements = [
  `
    CREATE OR REPLACE FUNCTION public.capstone_search_normalize(value text)
    RETURNS text
    LANGUAGE sql
    IMMUTABLE
    PARALLEL SAFE
    STRICT
    AS $function$
      SELECT lower(public.unaccent('public.unaccent', value))
    $function$
  `,
  `
    CREATE INDEX IF NOT EXISTS conversations_title_search_idx
    ON public.conversations USING gin (title_search_vector)
  `,
  `
    CREATE INDEX IF NOT EXISTS messages_content_search_idx
    ON public.messages USING gin (content_search_vector)
  `,
  `
    CREATE INDEX IF NOT EXISTS generations_conversation_idx
    ON public.generations USING btree (conversation_id)
    WHERE conversation_id IS NOT NULL
  `,
] as const;

export interface MigrationObjectsEvidence {
  readonly constraints: number;
  readonly functions: number;
  readonly indexes: number;
  readonly tables: number;
}

interface MigrationManifest extends MigrationObjectsEvidence {
  readonly constraintNames: readonly string[];
  readonly functionNames: readonly string[];
  readonly hashes: readonly string[];
  readonly indexNames: readonly string[];
  readonly tableNames: readonly string[];
}

interface NamedObjectRow extends QueryResultRow {
  readonly name: string;
}

interface CriticalIndexRow extends QueryResultRow {
  readonly definition: string;
  readonly name: string;
}

function extractNames(source: string, pattern: RegExp): readonly string[] {
  return [...source.matchAll(pattern)].flatMap((match) =>
    match[1] === undefined ? [] : [match[1]],
  );
}

function finalConstraintNames(source: string): readonly string[] {
  const names = new Set<string>();
  for (const match of source.matchAll(
    /DROP\s+CONSTRAINT\s+"([^"]+)"|(?:ADD\s+)?CONSTRAINT\s+"([^"]+)"/giu,
  )) {
    const dropped = match[1];
    const added = match[2];
    if (dropped !== undefined) {
      names.delete(dropped.slice(0, 63));
    } else if (added !== undefined) {
      names.add(added.slice(0, 63));
    }
  }
  return [...names].sort();
}

async function loadMigrationManifest(): Promise<MigrationManifest> {
  const fileNames = (await readdir(migrationsFolder))
    .filter((fileName) => migrationFilePattern.test(fileName))
    .sort();
  if (fileNames.length === 0) {
    recoveryPreparationFailed("Migration history is unavailable");
  }
  const migrationSql = await Promise.all(
    fileNames.map((fileName) => readFile(resolve(migrationsFolder, fileName), "utf8")),
  );
  const combined = migrationSql.join("\n");
  // PostgreSQL stores identifiers in NAMEDATALEN-1 bytes even when migration SQL quotes them.
  const uniqueSorted = (values: readonly string[]): readonly string[] =>
    [...new Set(values.map((value) => value.slice(0, 63)))].sort();
  const constraintNames = finalConstraintNames(combined);
  const functionNames = uniqueSorted(
    extractNames(combined, /CREATE\s+FUNCTION\s+(?:"?public"?\.)?"?([a-z0-9_]+)"?/giu),
  );
  const indexNames = uniqueSorted(
    extractNames(combined, /CREATE\s+(?:UNIQUE\s+)?INDEX\s+"([^"]+)"/giu),
  );
  const tableNames = uniqueSorted(extractNames(combined, /CREATE\s+TABLE\s+"([^"]+)"/giu));

  return Object.freeze({
    constraintNames,
    constraints: constraintNames.length,
    functionNames,
    functions: functionNames.length,
    hashes: migrationSql.map((contents) => createHash("sha256").update(contents).digest("hex")),
    indexNames,
    indexes: indexNames.length,
    tableNames,
    tables: tableNames.length,
  });
}

function assertObjectNames(
  actualRows: readonly NamedObjectRow[],
  expectedNames: readonly string[],
  label: string,
): void {
  const actualNames = new Set(actualRows.map((row) => row.name));
  const missingNames = expectedNames.filter((name) => !actualNames.has(name));
  if (missingNames.length > 0) {
    recoveryPreparationFailed(
      `Migration-owned ${label} are incomplete: ${missingNames.join(", ")}`,
    );
  }
}

async function repairManualObjects(migrationPool: Pool): Promise<void> {
  const client = await migrationPool.connect();
  try {
    await client.query("BEGIN");
    for (const statement of manualRepairStatements) {
      await client.query(statement);
    }
    await client.query("COMMIT");
  } catch (error: unknown) {
    await client.query("ROLLBACK").catch(() => undefined);
    recoveryPreparationFailed("Manual migration object preparation failed", error);
  } finally {
    client.release();
  }
}

async function verifyMigrationObjects(
  migrationPool: Pool,
  manifest: MigrationManifest,
): Promise<void> {
  const [ledger, tables, indexes, constraints, functions, extension, generatedColumns, critical] =
    await Promise.all([
      migrationPool.query<{ hash: string }>(
        "SELECT hash FROM drizzle.__drizzle_migrations ORDER BY created_at, id",
      ),
      migrationPool.query<NamedObjectRow>(`
        SELECT table_name AS name
        FROM information_schema.tables
        WHERE table_schema = 'public'
      `),
      migrationPool.query<NamedObjectRow>(`
        SELECT indexname AS name
        FROM pg_catalog.pg_indexes
        WHERE schemaname = 'public'
      `),
      migrationPool.query<NamedObjectRow>(`
        SELECT constraint_record.conname AS name
        FROM pg_catalog.pg_constraint AS constraint_record
        INNER JOIN pg_catalog.pg_namespace AS namespace
          ON namespace.oid = constraint_record.connamespace
        WHERE namespace.nspname = 'public' AND constraint_record.convalidated
      `),
      migrationPool.query<NamedObjectRow>(`
        SELECT procedure.proname AS name
        FROM pg_catalog.pg_proc AS procedure
        INNER JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
        WHERE namespace.nspname = 'public'
      `),
      migrationPool.query<{ schemaName: string }>(`
        SELECT namespace.nspname AS "schemaName"
        FROM pg_catalog.pg_extension AS extension
        INNER JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = extension.extnamespace
        WHERE extension.extname = 'unaccent'
      `),
      migrationPool.query<{ columnName: string; generated: string }>(`
        SELECT column_name AS "columnName", is_generated AS generated
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND (table_name, column_name) IN (
            ('conversations', 'title_search_vector'),
            ('messages', 'content_search_vector')
          )
      `),
      migrationPool.query<CriticalIndexRow>(`
        SELECT indexname AS name, indexdef AS definition
        FROM pg_catalog.pg_indexes
        WHERE schemaname = 'public'
          AND indexname IN (
            'conversations_title_search_idx',
            'messages_content_search_idx',
            'generations_conversation_idx'
          )
      `),
    ]);

  const ledgerHashes = ledger.rows.map((row) => row.hash).sort();
  const expectedHashes = [...manifest.hashes].sort();
  if (
    ledgerHashes.length !== expectedHashes.length ||
    ledgerHashes.some((hash, index) => hash !== expectedHashes[index])
  ) {
    recoveryPreparationFailed("Migration ledger does not match the release migration history");
  }
  assertObjectNames(tables.rows, manifest.tableNames, "tables");
  assertObjectNames(indexes.rows, manifest.indexNames, "indexes");
  assertObjectNames(constraints.rows, manifest.constraintNames, "constraints");
  assertObjectNames(functions.rows, manifest.functionNames, "functions");
  if (extension.rows[0]?.schemaName !== "public") {
    recoveryPreparationFailed("Required unaccent extension is unavailable");
  }
  if (
    generatedColumns.rows.length !== 2 ||
    generatedColumns.rows.some((column) => column.generated !== "ALWAYS")
  ) {
    recoveryPreparationFailed("Generated search columns are unavailable");
  }
  const criticalDefinitions = new Map(critical.rows.map((row) => [row.name, row.definition]));
  if (
    !/USING gin \(title_search_vector\)/u.test(
      criticalDefinitions.get("conversations_title_search_idx") ?? "",
    ) ||
    !/USING gin \(content_search_vector\)/u.test(
      criticalDefinitions.get("messages_content_search_idx") ?? "",
    ) ||
    !/USING btree \(conversation_id\).*WHERE \(conversation_id IS NOT NULL\)/u.test(
      criticalDefinitions.get("generations_conversation_idx") ?? "",
    )
  ) {
    recoveryPreparationFailed("Critical migration index definitions are invalid");
  }
  const selectedLeafConstraint = await migrationPool.query<{
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
    recoveryPreparationFailed("Deferred conversation leaf constraint is invalid");
  }
  const behaviorIntegrity = await migrationPool.query<{
    generationReferencesValid: boolean;
    policyHeadsValid: boolean;
    policyTiersComplete: boolean;
    promptHeadsValid: boolean;
  }>(`
    SELECT
      NOT EXISTS (
        SELECT 1
        FROM public.workspace_assistant_prompts AS head
        LEFT JOIN public.workspace_assistant_prompt_revisions AS revision
          ON revision.workspace_id = head.workspace_id
          AND revision.revision = head.revision
        WHERE revision.workspace_id IS NULL
      ) AS "promptHeadsValid",
      NOT EXISTS (
        SELECT 1
        FROM public.workspace_cost_policies AS head
        LEFT JOIN public.workspace_model_policy_revisions AS revision
          ON revision.workspace_id = head.workspace_id
          AND revision.revision = head.revision
        WHERE revision.workspace_id IS NULL
      ) AS "policyHeadsValid",
      NOT EXISTS (
        SELECT 1
        FROM public.workspace_model_policy_revisions AS revision
        LEFT JOIN public.workspace_model_policy_revision_tiers AS tier
          ON tier.workspace_id = revision.workspace_id
          AND tier.revision = revision.revision
        GROUP BY revision.workspace_id, revision.revision
        HAVING count(*) <> 3
          OR count(DISTINCT tier.tier) <> 3
          OR count(*) FILTER (WHERE tier.tier IN ('fast', 'balanced', 'pro')) <> 3
      ) AS "policyTiersComplete",
      NOT EXISTS (
        SELECT 1
        FROM public.generations AS generation
        LEFT JOIN public.workspace_model_policy_revisions AS policy
          ON policy.workspace_id = generation.workspace_id
          AND policy.revision = generation.model_policy_revision
        LEFT JOIN public.workspace_assistant_prompt_revisions AS prompt
          ON prompt.workspace_id = generation.workspace_id
          AND prompt.revision = generation.workspace_prompt_revision
        WHERE policy.workspace_id IS NULL
          OR (
            (generation.purpose IS NULL OR generation.purpose = 'chat')
            AND prompt.workspace_id IS NULL
          )
          OR (
            generation.purpose IN ('compaction', 'title')
            AND generation.workspace_prompt_revision IS NOT NULL
          )
      ) AS "generationReferencesValid"
  `);
  const integrity = behaviorIntegrity.rows[0];
  if (
    integrity === undefined ||
    !integrity.promptHeadsValid ||
    !integrity.policyHeadsValid ||
    !integrity.policyTiersComplete ||
    !integrity.generationReferencesValid
  ) {
    recoveryPreparationFailed("Workspace behavior ledger integrity is invalid");
  }
  const searchProbe = await migrationPool.query<{ normalized: string }>(
    "SELECT public.capstone_search_normalize('ÁRBOL') AS normalized",
  );
  if (searchProbe.rows[0]?.normalized !== "arbol") {
    recoveryPreparationFailed("Search normalization function is invalid");
  }
}

export async function prepareAndVerifyMigrationObjects(
  migrationPool: Pool,
): Promise<{ readonly migrationCount: number; readonly objects: MigrationObjectsEvidence }> {
  const manifest = await loadMigrationManifest();
  // Restored PlanetScale branches omit extensions even when the migration ledger is complete.
  await migrationPool.query("CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA public");
  await applyMigrations(migrationPool);
  await repairManualObjects(migrationPool);
  await verifyMigrationObjects(migrationPool, manifest);
  return Object.freeze({
    migrationCount: manifest.hashes.length,
    objects: Object.freeze({
      constraints: manifest.constraints,
      functions: manifest.functions,
      indexes: manifest.indexes,
      tables: manifest.tables,
    }),
  });
}

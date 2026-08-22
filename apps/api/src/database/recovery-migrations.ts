import type { Pool } from "pg";
import { applyMigrations } from "./migrate.js";
import {
  loadMigrationManifest,
  type MigrationObjectsEvidence,
  MigrationVerificationError,
  verifyMigrationObjects,
  verifyMigrationPrefix,
} from "./migration-verification.js";
import { recoveryPreparationFailed } from "./recovery-error.js";

export type { MigrationObjectsEvidence } from "./migration-verification.js";

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
const recoverableMissingMigrationSentinels = new Set(["public.generations_conversation_idx"]);

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

async function verifyRecoveryPolicyCompleteness(migrationPool: Pool): Promise<void> {
  const result = await migrationPool.query<{ complete: boolean }>(`
    SELECT NOT EXISTS (
      SELECT 1
      FROM public.workspace_model_policy_revisions AS revision
      LEFT JOIN public.workspace_model_policy_revision_tiers AS tier
        ON tier.workspace_id = revision.workspace_id
        AND tier.revision = revision.revision
      GROUP BY revision.workspace_id, revision.revision
      HAVING count(*) <> 3
        OR count(DISTINCT tier.tier) <> 3
        OR count(*) FILTER (WHERE tier.tier IN ('fast', 'balanced', 'pro')) <> 3
    ) AS complete
  `);
  if (result.rows[0]?.complete !== true) {
    recoveryPreparationFailed("Restored model policy history is incomplete");
  }
}

export async function prepareAndVerifyMigrationObjects(
  migrationPool: Pool,
): Promise<{ readonly migrationCount: number; readonly objects: MigrationObjectsEvidence }> {
  try {
    const manifest = await loadMigrationManifest();
    await verifyMigrationPrefix(migrationPool, manifest, recoverableMissingMigrationSentinels);
    // Restored PlanetScale branches omit extensions even when the migration ledger is complete.
    await migrationPool.query("CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA public");
    await applyMigrations(migrationPool);
    await repairManualObjects(migrationPool);
    await verifyMigrationObjects(migrationPool, manifest);
    await verifyRecoveryPolicyCompleteness(migrationPool);
    return Object.freeze({
      migrationCount: manifest.entries.length,
      objects: Object.freeze({
        constraints: manifest.constraints,
        functions: manifest.functions,
        indexes: manifest.indexes,
        tables: manifest.tables,
      }),
    });
  } catch (error: unknown) {
    if (error instanceof MigrationVerificationError) {
      recoveryPreparationFailed("Restored migration verification failed", error);
    }
    throw error;
  }
}

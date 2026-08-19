import { sql } from "drizzle-orm";
import type { AppDatabase } from "../database/database.js";
import type { ModelTier } from "../model-policy/catalog.js";
import {
  type GenerationPolicyRow,
  generationPolicyRowsQuery,
} from "../model-policy/generation-policy-query.js";
import type { ModelPolicyMode, ModelPolicyService } from "../model-policy/service.js";
import {
  type ContextWindow,
  type ContextWindowRow,
  contextWindowFromRow,
  contextWindowQuery,
} from "./context-service.js";
import { generationTuning } from "./settings.js";

interface DraftContextPreloadInput {
  readonly conversationId: string;
  readonly mode: ModelPolicyMode;
  readonly observedRevision: number;
  readonly parentMessageId: string | null;
  readonly tier: ModelTier;
  readonly userId: string;
  readonly workspaceId: string;
}

export interface PreloadedDraftContext {
  readonly endpointMessageId: string | null;
  readonly maximumSourceBytes: number;
  readonly revision: number;
  readonly window: ContextWindow;
}

type NullableGenerationPolicyRow = {
  readonly [Key in keyof GenerationPolicyRow]: GenerationPolicyRow[Key] | null;
};

interface DraftContextPreloadRow extends Record<string, unknown>, NullableGenerationPolicyRow {
  readonly contextWindow: unknown | null;
  readonly revision: number;
  readonly rowKind: "context" | "policy";
  readonly selectedLeafMessageId: string | null;
}

function emptyContextWindow(): ContextWindow {
  return Object.freeze({
    previousCompaction: null,
    recentTurns: [],
    sourceOverflow: false,
    sourceTurns: [],
  });
}

export async function preloadDraftContext(
  database: AppDatabase,
  modelPolicy: ModelPolicyService,
  input: DraftContextPreloadInput,
): Promise<PreloadedDraftContext | null> {
  const requestedTiers =
    input.tier === "fast" ? (["fast"] as const) : ([input.tier, "fast"] as const);
  const result = await database.execute<DraftContextPreloadRow>(sql`
    WITH eligible_conversation AS MATERIALIZED (
      SELECT conversation.id,
        conversation.revision,
        conversation.selected_leaf_message_id
      FROM conversations AS conversation
      WHERE conversation.id = ${input.conversationId}::uuid
        AND conversation.workspace_id = ${input.workspaceId}::uuid
        AND conversation.user_id = ${input.userId}
        AND conversation.archived_at IS NULL
        AND conversation.revision = ${input.observedRevision}
        AND conversation.selected_leaf_message_id
          IS NOT DISTINCT FROM ${input.parentMessageId}::uuid
      LIMIT 1
    ),
    context_preload AS MATERIALIZED (
      SELECT
        eligible.revision,
        eligible.selected_leaf_message_id,
        context_window.*
      FROM eligible_conversation AS eligible
      LEFT JOIN LATERAL (
        ${contextWindowQuery(
          sql`eligible.id`,
          sql`eligible.selected_leaf_message_id`,
          generationTuning.maximumContextBytes,
        )}
      ) AS context_window
        ON eligible.selected_leaf_message_id IS NOT NULL
    ),
    policy_preload AS MATERIALIZED (
      SELECT
        eligible.revision,
        eligible.selected_leaf_message_id,
        policy_rows.*
      FROM eligible_conversation AS eligible
      CROSS JOIN LATERAL (
        ${generationPolicyRowsQuery(input.workspaceId, requestedTiers, { lockRows: false })}
      ) AS policy_rows
    )
    SELECT
      'context'::text AS "rowKind",
      context_preload.revision,
      context_preload.selected_leaf_message_id AS "selectedLeafMessageId",
      jsonb_build_object(
        'branchFound', context_preload."branchFound",
        'branchValid', context_preload."branchValid",
        'previousCompactionId', context_preload."previousCompactionId",
        'previousSummary', context_preload."previousSummary",
        'previousThroughMessageId', context_preload."previousThroughMessageId",
        'recentTurns', context_preload."recentTurns",
        'sourceOverflow', context_preload."sourceOverflow",
        'sourceTurns', context_preload."sourceTurns"
      ) AS "contextWindow",
      NULL AS "approvedCatalogId",
      NULL AS "attestationVerifiedAt",
      NULL AS "attestationVersion",
      NULL AS available,
      NULL AS "catalogMaximumOutputTokens",
      NULL AS "completionPricePerToken",
      NULL AS "contextLength",
      NULL AS "employeeActiveGenerationLimit",
      NULL AS enabled,
      NULL AS "maximumOutputTokens",
      NULL AS "metadataSource",
      NULL AS "monthlyBudgetUsd",
      NULL AS "promptPricePerToken",
      NULL AS "requestPriceUsd",
      NULL AS "reservationMarginBasisPoints",
      NULL AS "resolvedModel",
      NULL AS tier
    FROM context_preload
    UNION ALL
    SELECT
      'policy'::text AS "rowKind",
      policy_preload.revision,
      policy_preload.selected_leaf_message_id AS "selectedLeafMessageId",
      NULL::jsonb AS "contextWindow",
      policy_preload."approvedCatalogId",
      policy_preload."attestationVerifiedAt",
      policy_preload."attestationVersion",
      policy_preload.available,
      policy_preload."catalogMaximumOutputTokens",
      policy_preload."completionPricePerToken",
      policy_preload."contextLength",
      policy_preload."employeeActiveGenerationLimit",
      policy_preload.enabled,
      policy_preload."maximumOutputTokens",
      policy_preload."metadataSource",
      policy_preload."monthlyBudgetUsd",
      policy_preload."promptPricePerToken",
      policy_preload."requestPriceUsd",
      policy_preload."reservationMarginBasisPoints",
      policy_preload."resolvedModel",
      policy_preload.tier
    FROM policy_preload
  `);
  const contextRow = result.rows.find((row) => row.rowKind === "context");
  if (contextRow === undefined) {
    return null;
  }
  const policyRows = result.rows.flatMap((row): readonly GenerationPolicyRow[] =>
    row.rowKind === "policy" ? [row as unknown as GenerationPolicyRow] : [],
  );
  modelPolicy.resolveGenerationPolicyRows(policyRows, input.tier, input.mode);
  const window =
    contextRow.selectedLeafMessageId === null
      ? emptyContextWindow()
      : contextWindowFromRow(contextRow.contextWindow as ContextWindowRow);
  return Object.freeze({
    endpointMessageId: contextRow.selectedLeafMessageId,
    maximumSourceBytes: generationTuning.maximumContextBytes,
    revision: contextRow.revision,
    window,
  });
}

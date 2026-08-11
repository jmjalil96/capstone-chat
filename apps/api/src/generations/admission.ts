import { type SQL, sql } from "drizzle-orm";
import { type AppTransaction, executePrepared } from "../database/database.js";
import {
  type BudgetAdmissionStateRow,
  budgetAdmissionFromState,
  budgetAdmissionStateQuery,
} from "../model-policy/budget-service.js";
import type { ModelTier } from "../model-policy/catalog.js";
import {
  type GenerationPolicyRow,
  generationPolicyRowsQuery,
} from "../model-policy/generation-policy-query.js";
import type {
  ModelPolicyMode,
  ModelPolicyService,
  ResolvedGenerationAdmission,
} from "../model-policy/service.js";

export interface ConversationAdmission {
  readonly activeGeneration: boolean | null;
  readonly archivedAt: Date | null;
  readonly conversationId: string | null;
  readonly draftContent: string | null;
  readonly draftId: string | null;
  readonly draftRevision: number | null;
  readonly hasMessages: boolean | null;
  readonly idempotencyFound: boolean;
  readonly revision: number | null;
  readonly selectedLeafMessageId: string | null;
  readonly title: string | null;
}

interface ConversationAdmissionInput {
  readonly conversationId: string;
  readonly idempotencyKey: string;
  readonly lockDraft: boolean;
  readonly userId: string;
  readonly workspaceId: string;
}

export interface DraftGenerationAdmissionInput {
  readonly at: Date;
  readonly conversationId: string;
  readonly draftContent: string;
  readonly draftRevision: number;
  readonly idempotencyKey: string;
  readonly mode: ModelPolicyMode;
  readonly observedRevision: number;
  readonly parentMessageId: string | null;
  readonly tier: ModelTier;
  readonly userId: string;
  readonly workspaceId: string;
}

export interface PendingDraftGenerationAdmission {
  readonly conversation: ConversationAdmission;
  readonly resolve: () => ResolvedGenerationAdmission;
}

interface ConversationAdmissionRow extends ConversationAdmission, Record<string, unknown> {}

type NullableBudgetAdmissionStateRow = {
  readonly [Key in keyof BudgetAdmissionStateRow]: BudgetAdmissionStateRow[Key] | null;
};

type NullableGenerationPolicyRow = {
  readonly [Key in keyof GenerationPolicyRow]: GenerationPolicyRow[Key] | null;
};

interface DraftGenerationAdmissionRow
  extends ConversationAdmissionRow,
    NullableBudgetAdmissionStateRow,
    NullableGenerationPolicyRow {
  readonly admissionEligible: boolean;
}

function conversationAdmissionCtes(input: ConversationAdmissionInput): SQL {
  return sql`
    idempotency AS MATERIALIZED (
      SELECT EXISTS (
        SELECT 1
        FROM generations AS existing_generation
        WHERE existing_generation.workspace_id = ${input.workspaceId}::uuid
          AND existing_generation.user_id = ${input.userId}
          AND existing_generation.idempotency_key = ${input.idempotencyKey}::uuid
      ) AS found
    ),
    locked_conversation AS MATERIALIZED (
      SELECT
        conversation.id,
        conversation.archived_at,
        conversation.revision,
        conversation.selected_leaf_message_id,
        conversation.title,
        (
          ${input.lockDraft}
          AND conversation.selected_leaf_message_id IS NULL
          AND EXISTS (
            SELECT 1
            FROM messages AS stored_message
            WHERE stored_message.conversation_id = conversation.id
          )
        ) AS has_messages,
        EXISTS (
          SELECT 1
          FROM generations AS active_generation
          WHERE active_generation.conversation_id = conversation.id
            AND active_generation.status IN ('preparing', 'active')
            AND active_generation.assistant_message_id IS NOT NULL
            AND (active_generation.purpose IS NULL OR active_generation.purpose = 'chat')
        ) AS active_generation
      FROM conversations AS conversation
      CROSS JOIN idempotency
      WHERE NOT idempotency.found
        AND conversation.id = ${input.conversationId}::uuid
        AND conversation.workspace_id = ${input.workspaceId}::uuid
        AND conversation.user_id = ${input.userId}
      LIMIT 1
      FOR UPDATE OF conversation
    ),
    locked_draft AS MATERIALIZED (
      SELECT draft.id, draft.content, draft.revision
      FROM drafts AS draft
      CROSS JOIN locked_conversation
      WHERE ${input.lockDraft}
        AND draft.workspace_id = ${input.workspaceId}::uuid
        AND draft.user_id = ${input.userId}
        AND draft.conversation_id = locked_conversation.id
      LIMIT 1
      FOR UPDATE OF draft
    )
  `;
}

function selectConversationAdmission(): SQL {
  return sql`
    SELECT
      idempotency.found AS "idempotencyFound",
      locked_conversation.id AS "conversationId",
      locked_conversation.archived_at AS "archivedAt",
      locked_conversation.revision,
      locked_conversation.selected_leaf_message_id AS "selectedLeafMessageId",
      locked_conversation.title,
      locked_conversation.has_messages AS "hasMessages",
      locked_conversation.active_generation AS "activeGeneration",
      locked_draft.id AS "draftId",
      locked_draft.content AS "draftContent",
      locked_draft.revision AS "draftRevision"
    FROM idempotency
    LEFT JOIN locked_conversation ON true
    LEFT JOIN locked_draft ON true
  `;
}

function toConversationAdmission(row: ConversationAdmissionRow): ConversationAdmission {
  return Object.freeze({
    activeGeneration: row.activeGeneration,
    archivedAt: row.archivedAt,
    conversationId: row.conversationId,
    draftContent: row.draftContent,
    draftId: row.draftId,
    draftRevision: row.draftRevision,
    hasMessages: row.hasMessages,
    idempotencyFound: row.idempotencyFound,
    revision: row.revision,
    selectedLeafMessageId: row.selectedLeafMessageId,
    title: row.title,
  });
}

export async function lockConversationAdmission(
  transaction: AppTransaction,
  input: Omit<ConversationAdmissionInput, "lockDraft">,
): Promise<ConversationAdmission> {
  const result = await transaction.execute<ConversationAdmissionRow>(sql`
    WITH ${conversationAdmissionCtes({ ...input, lockDraft: false })}
    ${selectConversationAdmission()}
  `);
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error("Conversation admission returned no row");
  }
  return toConversationAdmission(row);
}

export async function lockDraftGenerationAdmission(
  transaction: AppTransaction,
  input: DraftGenerationAdmissionInput,
  modelPolicy: ModelPolicyService,
): Promise<PendingDraftGenerationAdmission> {
  const requestedTiers =
    input.tier === "fast" ? (["fast"] as const) : ([input.tier, "fast"] as const);
  const result = await executePrepared<DraftGenerationAdmissionRow>(
    transaction,
    requestedTiers.length === 1
      ? "generation-draft-admission-single-tier-v1"
      : "generation-draft-admission-with-fast-v1",
    sql`
    WITH ${conversationAdmissionCtes({ ...input, lockDraft: true })},
    lock_barrier AS MATERIALIZED (
      SELECT
        conversation_admission.*,
        (
          NOT conversation_admission."idempotencyFound"
          AND conversation_admission."conversationId" IS NOT NULL
          AND NOT COALESCE(conversation_admission."activeGeneration", false)
          AND conversation_admission."archivedAt" IS NULL
          AND conversation_admission.revision = ${input.observedRevision}
          AND conversation_admission."selectedLeafMessageId"
            IS NOT DISTINCT FROM ${input.parentMessageId}::uuid
          AND (
            conversation_admission."selectedLeafMessageId" IS NOT NULL
            OR NOT COALESCE(conversation_admission."hasMessages", false)
          )
          AND conversation_admission."draftId" IS NOT NULL
          AND conversation_admission."draftRevision" = ${input.draftRevision}
          AND conversation_admission."draftContent" = ${input.draftContent}
        ) AS "admissionEligible"
      FROM (${selectConversationAdmission()}) AS conversation_admission
    ),
    admission_state AS MATERIALIZED (
      SELECT state.*
      FROM lock_barrier
      CROSS JOIN LATERAL (
        SELECT budget_state.*
        FROM (${budgetAdmissionStateQuery(input.workspaceId, input.userId, input.at)}) AS budget_state
        WHERE lock_barrier."admissionEligible"
      ) AS state
    ),
    resolved_tiers AS MATERIALIZED (
      SELECT policy_rows.*
      FROM lock_barrier
      CROSS JOIN LATERAL (
        ${generationPolicyRowsQuery(input.workspaceId, requestedTiers, {
          gate: sql`lock_barrier."admissionEligible"`,
          lockRows: true,
        })}
      ) AS policy_rows
    )
    SELECT
      lock_barrier."idempotencyFound",
      lock_barrier."conversationId",
      lock_barrier."archivedAt",
      lock_barrier.revision,
      lock_barrier."selectedLeafMessageId",
      lock_barrier.title,
      lock_barrier."hasMessages",
      lock_barrier."activeGeneration",
      lock_barrier."draftId",
      lock_barrier."draftContent",
      lock_barrier."draftRevision",
      lock_barrier."admissionEligible",
      admission_state."activeGenerationCount",
      admission_state."consumedUsd",
      admission_state."periodEnd",
      admission_state."periodStart",
      resolved_tiers."approvedCatalogId",
      resolved_tiers."attestationVerifiedAt",
      resolved_tiers."attestationVersion",
      resolved_tiers.available,
      resolved_tiers."catalogMaximumOutputTokens",
      resolved_tiers."completionPricePerToken",
      resolved_tiers."contextLength",
      resolved_tiers."employeeActiveGenerationLimit",
      resolved_tiers.enabled,
      resolved_tiers."maximumOutputTokens",
      resolved_tiers."metadataSource",
      resolved_tiers."monthlyBudgetUsd",
      resolved_tiers."promptPricePerToken",
      resolved_tiers."requestPriceUsd",
      resolved_tiers."reservationMarginBasisPoints",
      resolved_tiers."resolvedModel",
      resolved_tiers.tier
    FROM lock_barrier
    LEFT JOIN admission_state ON true
    LEFT JOIN resolved_tiers ON true
    `,
  );
  const first = result.rows[0];
  if (first === undefined) {
    throw new Error("Draft generation admission returned no row");
  }
  const policyRows = result.rows.flatMap((row): readonly GenerationPolicyRow[] =>
    row.tier === null ? [] : [row as unknown as GenerationPolicyRow],
  );
  const conversation = toConversationAdmission(first);

  return Object.freeze({
    conversation,
    resolve(): ResolvedGenerationAdmission {
      const state =
        first.activeGenerationCount === null || first.consumedUsd === null
          ? undefined
          : {
              activeGenerationCount: first.activeGenerationCount,
              consumedUsd: first.consumedUsd,
              periodEnd: first.periodEnd,
              periodStart: first.periodStart,
            };
      const admission = budgetAdmissionFromState(state, input.workspaceId, input.userId);
      const policies = modelPolicy.resolveGenerationPolicyRows(policyRows, input.tier, input.mode);
      return Object.freeze({ admission, policies });
    },
  });
}

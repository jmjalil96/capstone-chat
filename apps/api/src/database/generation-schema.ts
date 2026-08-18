import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { workspaceAssistantPromptRevisions } from "./assistant-rules-schema.js";
import { user } from "./auth-schema.generated.js";
import { conversations, messages } from "./conversation-schema.js";
import { workspaces } from "./identity-schema.js";
import { workspaceModelPolicyRevisions } from "./model-policy-schema.js";

export const generationStatus = pgEnum("generation_status", [
  "preparing",
  "active",
  "finalizing",
  "completed",
  "cancelled",
  "incomplete",
  "failed",
]);

/** Generation statuses that still own a conversation workflow slot. */
export const nonterminalGenerationStatuses = Object.freeze([
  "preparing",
  "active",
  "finalizing",
] as const);

/** Generation statuses whose row is settled and immutable except for late accounting. */
export const terminalGenerationStatuses = Object.freeze([
  "completed",
  "cancelled",
  "incomplete",
  "failed",
] as const);

export type NonterminalGenerationStatus = (typeof nonterminalGenerationStatuses)[number];
export type TerminalGenerationStatus = (typeof terminalGenerationStatuses)[number];
export type GenerationLifecycleStatus = NonterminalGenerationStatus | TerminalGenerationStatus;

export function isNonterminalGenerationStatus(
  status: GenerationLifecycleStatus,
): status is NonterminalGenerationStatus {
  return (nonterminalGenerationStatuses as readonly string[]).includes(status);
}

export function isTerminalGenerationStatus(
  status: GenerationLifecycleStatus,
): status is TerminalGenerationStatus {
  return !isNonterminalGenerationStatus(status);
}

export const generationTerminalReason = pgEnum("generation_terminal_reason", [
  "stop",
  "length",
  "refusal",
  "content_filter",
  "cancelled",
  "error",
]);

export const generations = pgTable(
  "generations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "restrict" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    conversationId: uuid("conversation_id"),
    assistantMessageId: uuid("assistant_message_id"),
    idempotencyKey: uuid("idempotency_key").notNull(),
    requestedTier: text("requested_tier").notNull(),
    purpose: text("purpose"),
    requestedModel: text("requested_model"),
    resolvedModel: text("resolved_model"),
    provider: text("provider"),
    openRouterGenerationId: text("openrouter_generation_id"),
    systemPromptVersion: text("system_prompt_version").notNull(),
    modelPolicyRevision: integer("model_policy_revision").notNull(),
    workspacePromptRevision: integer("workspace_prompt_revision"),
    effectiveParameters: jsonb("effective_parameters").$type<Record<string, unknown>>().notNull(),
    status: generationStatus("status").notNull(),
    terminalReason: generationTerminalReason("terminal_reason"),
    errorCode: text("error_code"),
    promptTokens: bigint("prompt_tokens", { mode: "bigint" }),
    completionTokens: bigint("completion_tokens", { mode: "bigint" }),
    reasoningTokens: bigint("reasoning_tokens", { mode: "bigint" }),
    cachedTokens: bigint("cached_tokens", { mode: "bigint" }),
    costUsd: numeric("cost_usd", { precision: 38, scale: 18 }),
    costBasis: text("cost_basis"),
    accountingStatus: text("accounting_status"),
    estimatedInputTokens: bigint("estimated_input_tokens", { mode: "bigint" }),
    maximumOutputTokens: integer("maximum_output_tokens"),
    reservedCostUsd: numeric("reserved_cost_usd", { precision: 38, scale: 18 }),
    promptPriceCeilingPerToken: numeric("prompt_price_ceiling_per_token", {
      precision: 38,
      scale: 24,
    }),
    completionPriceCeilingPerToken: numeric("completion_price_ceiling_per_token", {
      precision: 38,
      scale: 24,
    }),
    requestPriceCeilingUsd: numeric("request_price_ceiling_usd", {
      precision: 38,
      scale: 18,
    }),
    reservationMarginBasisPoints: integer("reservation_margin_basis_points"),
    budgetPeriodStart: timestamp("budget_period_start", { precision: 3, withTimezone: true }),
    budgetPeriodEnd: timestamp("budget_period_end", { precision: 3, withTimezone: true }),
    reservationExpiresAt: timestamp("reservation_expires_at", {
      precision: 3,
      withTimezone: true,
    }),
    accountingSettledAt: timestamp("accounting_settled_at", {
      precision: 3,
      withTimezone: true,
    }),
    startedAt: timestamp("started_at", { precision: 3, withTimezone: true }).defaultNow().notNull(),
    firstTokenAt: timestamp("first_token_at", { precision: 3, withTimezone: true }),
    completedAt: timestamp("completed_at", { precision: 3, withTimezone: true }),
    createdAt: timestamp("created_at", { precision: 3, withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { precision: 3, withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.workspaceId, table.userId, table.conversationId],
      foreignColumns: [conversations.workspaceId, conversations.userId, conversations.id],
      name: "generations_owned_conversation_fk",
    }).onDelete("no action"),
    foreignKey({
      columns: [table.conversationId, table.assistantMessageId],
      foreignColumns: [messages.conversationId, messages.id],
      name: "generations_assistant_message_fk",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.workspaceId, table.modelPolicyRevision],
      foreignColumns: [
        workspaceModelPolicyRevisions.workspaceId,
        workspaceModelPolicyRevisions.revision,
      ],
      name: "generations_model_policy_revision_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.workspaceId, table.workspacePromptRevision],
      foreignColumns: [
        workspaceAssistantPromptRevisions.workspaceId,
        workspaceAssistantPromptRevisions.revision,
      ],
      name: "generations_workspace_prompt_revision_fk",
    }).onDelete("restrict"),
    uniqueIndex("generations_scoped_idempotency_unique").on(
      table.workspaceId,
      table.userId,
      table.idempotencyKey,
    ),
    uniqueIndex("generations_assistant_message_unique")
      .on(table.assistantMessageId)
      .where(sql`${table.assistantMessageId} IS NOT NULL`),
    uniqueIndex("generations_active_conversation_unique")
      .on(table.conversationId)
      .where(sql`${table.status} = 'active' AND ${table.conversationId} IS NOT NULL`),
    uniqueIndex("generations_chat_workflow_conversation_unique")
      .on(table.conversationId)
      .where(
        sql`${table.status} IN ('preparing', 'active', 'finalizing')
          AND ${table.conversationId} IS NOT NULL
          AND ${table.assistantMessageId} IS NOT NULL`,
      ),
    uniqueIndex("generations_title_conversation_unique")
      .on(table.conversationId)
      .where(sql`${table.purpose} = 'title' AND ${table.conversationId} IS NOT NULL`),
    index("generations_finalizing_completed_idx")
      .on(table.completedAt)
      .where(sql`${table.status} = 'finalizing'`),
    uniqueIndex("generations_openrouter_generation_id_unique")
      .on(table.openRouterGenerationId)
      .where(sql`${table.openRouterGenerationId} IS NOT NULL`),
    index("generations_conversation_idx")
      .on(table.conversationId)
      .where(sql`${table.conversationId} IS NOT NULL`),
    index("generations_workspace_budget_period_idx").on(
      table.workspaceId,
      table.budgetPeriodStart,
      table.accountingStatus,
    ),
    index("generations_reserved_expiry_idx")
      .on(table.reservationExpiresAt, table.id)
      .where(sql`${table.accountingStatus} = 'reserved'`),
    check(
      "generations_content_references_check",
      sql`(${table.conversationId} IS NULL AND ${table.assistantMessageId} IS NULL)
        OR (
          ${table.conversationId} IS NOT NULL
          AND ${table.assistantMessageId} IS NOT NULL
          AND (${table.purpose} IS NULL OR ${table.purpose} = 'chat')
        )
        OR (
          ${table.conversationId} IS NOT NULL
          AND ${table.assistantMessageId} IS NULL
          AND ${table.purpose} IS NOT NULL
          AND ${table.purpose} IN ('compaction', 'title')
        )`,
    ),
    check(
      "generations_requested_tier_check",
      sql`${table.requestedTier} IN ('fast', 'balanced', 'pro')`,
    ),
    check(
      "generations_system_prompt_version_check",
      sql`(
          ${table.purpose} IS NOT NULL
          AND ${table.purpose} = 'compaction'
          AND ${table.systemPromptVersion} = 'capstone-compaction-v1'
          AND ${table.workspacePromptRevision} IS NULL
        ) OR (
          ${table.purpose} IS NOT NULL
          AND ${table.purpose} = 'title'
          AND ${table.systemPromptVersion} = 'capstone-title-v1'
          AND ${table.workspacePromptRevision} IS NULL
        ) OR (
          (${table.purpose} IS NULL OR ${table.purpose} = 'chat')
          AND ${table.systemPromptVersion} = 'capstone-chat-base-v2'
          AND ${table.workspacePromptRevision} IS NOT NULL
        )`,
    ),
    check(
      "generations_effective_parameters_check",
      sql`jsonb_typeof(${table.effectiveParameters}) = 'object'`,
    ),
    check(
      "generations_accounting_check",
      sql`(
          ${table.accountingStatus} IS NULL
          AND (
            ${table.purpose} IS NULL
            OR ${table.purpose} IN ('chat', 'compaction', 'title')
          )
          AND ${table.requestedModel} IS NULL
          AND ${table.resolvedModel} IS NULL
          AND ${table.provider} IS NULL
          AND ${table.openRouterGenerationId} IS NULL
          AND ${table.promptTokens} IS NULL
          AND ${table.completionTokens} IS NULL
          AND ${table.reasoningTokens} IS NULL
          AND ${table.cachedTokens} IS NULL
          AND ${table.costUsd} IS NULL
          AND ${table.costBasis} IS NULL
          AND ${table.estimatedInputTokens} IS NULL
          AND ${table.maximumOutputTokens} IS NULL
          AND ${table.reservedCostUsd} IS NULL
          AND ${table.promptPriceCeilingPerToken} IS NULL
          AND ${table.completionPriceCeilingPerToken} IS NULL
          AND ${table.requestPriceCeilingUsd} IS NULL
          AND ${table.reservationMarginBasisPoints} IS NULL
          AND ${table.budgetPeriodStart} IS NULL
          AND ${table.budgetPeriodEnd} IS NULL
          AND ${table.reservationExpiresAt} IS NULL
          AND ${table.accountingSettledAt} IS NULL
        ) OR (
          ${table.accountingStatus} IS NOT NULL
          AND ${table.accountingStatus} IN ('reserved', 'actual', 'estimated')
          AND ${table.purpose} IS NOT NULL
          AND ${table.purpose} IN ('chat', 'compaction', 'title')
          AND ${table.requestedModel} IS NOT NULL
          AND ${table.requestedModel} ~ '[^[:space:]]'
          AND ${table.resolvedModel} IS NOT NULL
          AND ${table.resolvedModel} ~ '[^[:space:]]'
          AND ${table.estimatedInputTokens} IS NOT NULL
          AND ${table.estimatedInputTokens} >= 0
          AND ${table.maximumOutputTokens} IS NOT NULL
          AND ${table.maximumOutputTokens} > 0
          AND ${table.reservedCostUsd} IS NOT NULL
          AND ${table.reservedCostUsd} >= 0
          AND ${table.promptPriceCeilingPerToken} IS NOT NULL
          AND ${table.promptPriceCeilingPerToken} >= 0
          AND ${table.completionPriceCeilingPerToken} IS NOT NULL
          AND ${table.completionPriceCeilingPerToken} >= 0
          AND ${table.requestPriceCeilingUsd} IS NOT NULL
          AND ${table.requestPriceCeilingUsd} >= 0
          AND ${table.reservationMarginBasisPoints} IS NOT NULL
          AND ${table.reservationMarginBasisPoints} >= 0
          AND ${table.budgetPeriodStart} IS NOT NULL
          AND ${table.budgetPeriodEnd} IS NOT NULL
          AND ${table.budgetPeriodStart} < ${table.budgetPeriodEnd}
          AND ${table.reservationExpiresAt} IS NOT NULL
          AND ${table.reservationExpiresAt} > ${table.startedAt}
          AND (
            ${table.accountingStatus} = 'reserved'
            AND ${table.costUsd} IS NULL
            AND ${table.costBasis} IS NULL
            AND ${table.accountingSettledAt} IS NULL
          OR
            ${table.accountingStatus} IN ('actual', 'estimated')
            AND ${table.costUsd} IS NOT NULL
            AND ${table.costUsd} >= 0
            AND ${table.costBasis} IS NOT NULL
            AND ${table.costBasis} = ${table.accountingStatus}
            AND ${table.accountingSettledAt} IS NOT NULL
          )
        )`,
    ),
    check(
      "generations_token_counts_check",
      sql`(${table.promptTokens} IS NULL OR ${table.promptTokens} >= 0)
        AND (${table.completionTokens} IS NULL OR ${table.completionTokens} >= 0)
        AND (${table.reasoningTokens} IS NULL OR ${table.reasoningTokens} >= 0)
        AND (${table.cachedTokens} IS NULL OR ${table.cachedTokens} >= 0)`,
    ),
    check(
      "generations_lifecycle_check",
      sql`(
          ${table.status} = 'preparing'
          AND ${table.purpose} IS NOT NULL
          AND ${table.purpose} = 'chat'
          AND ${table.terminalReason} IS NULL
          AND ${table.errorCode} IS NULL
          AND ${table.firstTokenAt} IS NULL
          AND ${table.completedAt} IS NULL
          AND ${table.conversationId} IS NOT NULL
          AND ${table.assistantMessageId} IS NOT NULL
        ) OR (
          ${table.status} = 'active'
          AND ${table.terminalReason} IS NULL
          AND ${table.errorCode} IS NULL
          AND ${table.completedAt} IS NULL
          AND ${table.conversationId} IS NOT NULL
          AND (
            (
              ${table.assistantMessageId} IS NOT NULL
              AND (${table.purpose} IS NULL OR ${table.purpose} = 'chat')
            )
            OR (
              ${table.assistantMessageId} IS NULL
              AND ${table.purpose} IS NOT NULL
              AND ${table.purpose} IN ('compaction', 'title')
            )
          )
        ) OR (
          ${table.status} = 'finalizing'
          AND ${table.purpose} IS NOT NULL
          AND ${table.purpose} = 'chat'
          AND ${table.terminalReason} IS NOT NULL
          AND ${table.terminalReason} IN ('stop', 'length')
          AND ${table.errorCode} IS NULL
          AND ${table.completedAt} IS NOT NULL
          AND ${table.conversationId} IS NOT NULL
          AND ${table.assistantMessageId} IS NOT NULL
        ) OR (
          ${table.status} = 'completed'
          AND ${table.terminalReason} IS NOT NULL
          AND ${table.terminalReason} IN ('stop', 'length', 'refusal', 'content_filter')
          AND ${table.errorCode} IS NULL
          AND ${table.completedAt} IS NOT NULL
        ) OR (
          ${table.status} = 'cancelled'
          AND ${table.terminalReason} IS NOT NULL
          AND ${table.terminalReason} = 'cancelled'
          AND ${table.errorCode} IS NULL
          AND ${table.completedAt} IS NOT NULL
        ) OR (
          ${table.status} IN ('incomplete', 'failed')
          AND ${table.terminalReason} IS NOT NULL
          AND ${table.terminalReason} = 'error'
          AND ${table.errorCode} IS NOT NULL
          AND ${table.errorCode} IN (
            'EMPTY_RESPONSE',
            'GENERATION_FAILED',
            'GENERATION_TIMEOUT',
            'MODEL_UNAVAILABLE',
            'STREAM_INTERRUPTED'
          )
          AND ${table.completedAt} IS NOT NULL
        )`,
    ),
    check(
      "generations_timestamps_check",
      sql`${table.startedAt} >= ${table.createdAt}
        AND (${table.firstTokenAt} IS NULL OR ${table.firstTokenAt} >= ${table.startedAt})
        AND (${table.completedAt} IS NULL OR ${table.completedAt} >= ${table.startedAt})
        AND (${table.completedAt} IS NULL OR ${table.firstTokenAt} IS NULL
          OR ${table.completedAt} >= ${table.firstTokenAt})
        AND ${table.updatedAt} >= ${table.createdAt}
        AND ${table.updatedAt} >= ${table.startedAt}
        AND (${table.firstTokenAt} IS NULL OR ${table.updatedAt} >= ${table.firstTokenAt})
        AND (${table.completedAt} IS NULL OR ${table.updatedAt} >= ${table.completedAt})`,
    ),
  ],
);

// The reviewed migration makes the owned-conversation foreign key deferred so a conversation
// deletion can first terminalize its generation and then null both content references through the
// assistant-message foreign key without discarding the retained lifecycle row.

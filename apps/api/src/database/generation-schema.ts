import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { user } from "./auth-schema.generated.js";
import { conversations, messages } from "./conversation-schema.js";
import { workspaces } from "./identity-schema.js";

export const generationStatus = pgEnum("generation_status", [
  "active",
  "completed",
  "cancelled",
  "incomplete",
  "failed",
]);

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
    systemPromptVersion: text("system_prompt_version").notNull(),
    effectiveParameters: jsonb("effective_parameters").$type<Record<string, unknown>>().notNull(),
    status: generationStatus("status").notNull(),
    terminalReason: generationTerminalReason("terminal_reason"),
    errorCode: text("error_code"),
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
    check(
      "generations_content_references_check",
      sql`(${table.conversationId} IS NULL AND ${table.assistantMessageId} IS NULL)
        OR (${table.conversationId} IS NOT NULL AND ${table.assistantMessageId} IS NOT NULL)`,
    ),
    check("generations_requested_tier_check", sql`${table.requestedTier} = 'balanced'`),
    check(
      "generations_system_prompt_version_check",
      sql`${table.systemPromptVersion} = 'capstone-chat-v1'`,
    ),
    check(
      "generations_effective_parameters_check",
      sql`jsonb_typeof(${table.effectiveParameters}) = 'object'
        AND ${table.effectiveParameters} = '{}'::jsonb`,
    ),
    check(
      "generations_lifecycle_check",
      sql`(
          ${table.status} = 'active'
          AND ${table.terminalReason} IS NULL
          AND ${table.errorCode} IS NULL
          AND ${table.completedAt} IS NULL
          AND ${table.conversationId} IS NOT NULL
          AND ${table.assistantMessageId} IS NOT NULL
        ) OR (
          ${table.status} = 'completed'
          AND ${table.terminalReason} IN ('stop', 'length', 'refusal', 'content_filter')
          AND ${table.errorCode} IS NULL
          AND ${table.completedAt} IS NOT NULL
        ) OR (
          ${table.status} = 'cancelled'
          AND ${table.terminalReason} = 'cancelled'
          AND ${table.errorCode} IS NULL
          AND ${table.completedAt} IS NOT NULL
        ) OR (
          ${table.status} IN ('incomplete', 'failed')
          AND ${table.terminalReason} = 'error'
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

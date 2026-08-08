import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { conversations, messages } from "./conversation-schema.js";
import { generations } from "./generation-schema.js";

export const conversationCompactionStatus = pgEnum("conversation_compaction_status", [
  "active",
  "completed",
  "failed",
  "cancelled",
  "incomplete",
]);

export const conversationCompactions = pgTable(
  "conversation_compactions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id").notNull(),
    userId: text("user_id").notNull(),
    conversationId: uuid("conversation_id").notNull(),
    throughMessageId: uuid("through_message_id").notNull(),
    previousCompactionId: uuid("previous_compaction_id"),
    generationId: uuid("generation_id")
      .notNull()
      .references(() => generations.id, { onDelete: "restrict" }),
    summary: text("summary"),
    sourceTokenCount: bigint("source_token_count", { mode: "bigint" }),
    summaryTokenCount: bigint("summary_token_count", { mode: "bigint" }),
    modelUsed: text("model_used").notNull(),
    promptVersion: text("prompt_version").notNull(),
    status: conversationCompactionStatus("status").notNull(),
    createdAt: timestamp("created_at", { precision: 3, withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp("completed_at", { precision: 3, withTimezone: true }),
    updatedAt: timestamp("updated_at", { precision: 3, withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique("conversation_compactions_conversation_id_id_unique").on(table.conversationId, table.id),
    foreignKey({
      columns: [table.workspaceId, table.userId, table.conversationId],
      foreignColumns: [conversations.workspaceId, conversations.userId, conversations.id],
      name: "conversation_compactions_owned_conversation_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.conversationId, table.throughMessageId],
      foreignColumns: [messages.conversationId, messages.id],
      name: "conversation_compactions_through_message_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.conversationId, table.previousCompactionId],
      foreignColumns: [table.conversationId, table.id],
      name: "conversation_compactions_previous_compaction_fk",
    }).onDelete("cascade"),
    uniqueIndex("conversation_compactions_generation_unique").on(table.generationId),
    uniqueIndex("conversation_compactions_completed_boundary_unique")
      .on(table.conversationId, table.throughMessageId, table.promptVersion)
      .where(sql`${table.status} = 'completed'`),
    index("conversation_compactions_conversation_status_idx").on(
      table.conversationId,
      table.status,
      table.createdAt.desc(),
      table.id.desc(),
    ),
    index("conversation_compactions_previous_idx").on(
      table.conversationId,
      table.previousCompactionId,
    ),
    check(
      "conversation_compactions_previous_not_self_check",
      sql`${table.previousCompactionId} IS NULL OR ${table.previousCompactionId} <> ${table.id}`,
    ),
    check(
      "conversation_compactions_nonempty_text_check",
      sql`${table.modelUsed} ~ '[^[:space:]]'
        AND ${table.promptVersion} = 'capstone-compaction-v1'`,
    ),
    check(
      "conversation_compactions_lifecycle_check",
      sql`(
          ${table.status} = 'active'
          AND ${table.summary} IS NULL
          AND ${table.sourceTokenCount} IS NULL
          AND ${table.summaryTokenCount} IS NULL
          AND ${table.completedAt} IS NULL
        ) OR (
          ${table.status} = 'completed'
          AND ${table.summary} IS NOT NULL
          AND ${table.summary} ~ '[^[:space:]]'
          AND ${table.sourceTokenCount} IS NOT NULL
          AND ${table.sourceTokenCount} >= 0
          AND ${table.summaryTokenCount} IS NOT NULL
          AND ${table.summaryTokenCount} >= 0
          AND ${table.completedAt} IS NOT NULL
        ) OR (
          ${table.status} IN ('failed', 'cancelled', 'incomplete')
          AND ${table.summary} IS NULL
          AND ${table.sourceTokenCount} IS NULL
          AND ${table.summaryTokenCount} IS NULL
          AND ${table.completedAt} IS NOT NULL
        )`,
    ),
    check(
      "conversation_compactions_timestamps_check",
      sql`${table.updatedAt} >= ${table.createdAt}
        AND (${table.completedAt} IS NULL OR ${table.completedAt} >= ${table.createdAt})
        AND (${table.completedAt} IS NULL OR ${table.updatedAt} >= ${table.completedAt})`,
    ),
  ],
);

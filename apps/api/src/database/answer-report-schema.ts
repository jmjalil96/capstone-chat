import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { user } from "./auth-schema.generated.js";
import { conversations, messages } from "./conversation-schema.js";
import { generations } from "./generation-schema.js";
import { workspaces } from "./identity-schema.js";

export const answerReportReason = pgEnum("answer_report_reason", [
  "incorrect",
  "outdated",
  "incomplete",
  "instructions_not_followed",
  "unsafe",
  "other",
]);

// A report stores no prompt or answer text. Administrators read the pair through the immutable
// assistant message and its direct user parent, so deleting either source removes the report.
export const answerReports = pgTable(
  "answer_reports",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id").notNull(),
    generationId: uuid("generation_id")
      .notNull()
      .references(() => generations.id, { onDelete: "cascade" }),
    assistantMessageId: uuid("assistant_message_id").notNull(),
    reason: answerReportReason("reason").notNull(),
    note: text("note"),
    createdAt: timestamp("created_at", { precision: 3, withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.workspaceId, table.userId, table.conversationId],
      foreignColumns: [conversations.workspaceId, conversations.userId, conversations.id],
      name: "answer_reports_owned_conversation_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.conversationId, table.assistantMessageId],
      foreignColumns: [messages.conversationId, messages.id],
      name: "answer_reports_assistant_message_fk",
    }).onDelete("cascade"),
    uniqueIndex("answer_reports_generation_unique").on(table.generationId),
    uniqueIndex("answer_reports_assistant_message_unique").on(table.assistantMessageId),
    index("answer_reports_workspace_inbox_idx").on(
      table.workspaceId,
      table.createdAt.desc(),
      table.id.desc(),
    ),
    check(
      "answer_reports_note_check",
      sql`${table.note} IS NULL OR (${table.note} ~ '[^[:space:]]' AND char_length(${table.note}) <= 1000)`,
    ),
  ],
);

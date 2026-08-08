import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { user } from "./auth-schema.generated.js";
import { workspaces } from "./identity-schema.js";

export const conversationMessageRole = pgEnum("conversation_message_role", ["user", "assistant"]);

export const conversations = pgTable(
  "conversations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    title: text("title"),
    selectedLeafMessageId: uuid("selected_leaf_message_id"),
    preferredTier: text("preferred_tier").default("balanced").notNull(),
    revision: integer("revision").default(0).notNull(),
    archivedAt: timestamp("archived_at", { precision: 3, withTimezone: true }),
    createdAt: timestamp("created_at", { precision: 3, withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { precision: 3, withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check("conversations_revision_nonnegative_check", sql`${table.revision} >= 0`),
    check(
      "conversations_preferred_tier_check",
      sql`${table.preferredTier} IN ('fast', 'balanced', 'pro')`,
    ),
    check(
      "conversations_title_nonempty_check",
      sql`${table.title} IS NULL OR ${table.title} ~ '[^[:space:]]'`,
    ),
    index("conversations_owner_active_history_idx")
      .on(table.workspaceId, table.userId, table.updatedAt.desc(), table.id.desc())
      .where(sql`${table.archivedAt} IS NULL`),
    index("conversations_owner_archived_history_idx")
      .on(table.workspaceId, table.userId, table.updatedAt.desc(), table.id.desc())
      .where(sql`${table.archivedAt} IS NOT NULL`),
    uniqueIndex("conversations_owner_id_unique").on(table.workspaceId, table.userId, table.id),
  ],
);

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    parentMessageId: uuid("parent_message_id"),
    role: conversationMessageRole("role").notNull(),
    content: jsonb("content").notNull(),
    createdAt: timestamp("created_at", { precision: 3, withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique("messages_conversation_id_id_unique").on(table.conversationId, table.id),
    foreignKey({
      columns: [table.conversationId, table.parentMessageId],
      foreignColumns: [table.conversationId, table.id],
      name: "messages_same_conversation_parent_fk",
    }).onDelete("cascade"),
    check(
      "messages_content_array_check",
      sql`jsonb_typeof(${table.content}) = 'array' AND jsonb_array_length(${table.content}) = 1`,
    ),
    check(
      "messages_root_user_check",
      sql`${table.parentMessageId} IS NOT NULL OR ${table.role} = 'user'`,
    ),
    index("messages_conversation_created_idx").on(
      table.conversationId,
      table.createdAt.desc(),
      table.id.desc(),
    ),
    index("messages_parent_idx").on(table.conversationId, table.parentMessageId),
  ],
);

export const drafts = pgTable(
  "drafts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id"),
    content: text("content").default("").notNull(),
    revision: integer("revision").default(0).notNull(),
    updatedAt: timestamp("updated_at", { precision: 3, withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check("drafts_revision_nonnegative_check", sql`${table.revision} >= 0`),
    foreignKey({
      columns: [table.workspaceId, table.userId, table.conversationId],
      foreignColumns: [conversations.workspaceId, conversations.userId, conversations.id],
      name: "drafts_owned_conversation_fk",
    }).onDelete("cascade"),
    uniqueIndex("drafts_conversation_scope_unique")
      .on(table.workspaceId, table.userId, table.conversationId)
      .where(sql`${table.conversationId} IS NOT NULL`),
    uniqueIndex("drafts_new_chat_scope_unique")
      .on(table.workspaceId, table.userId)
      .where(sql`${table.conversationId} IS NULL`),
  ],
);

// The migration additionally owns the composite deferred selected-leaf foreign key and generated
// tsvector columns. Keeping those PostgreSQL-specific objects in reviewed SQL avoids a circular
// table initialization and exposes their exact immutable search expressions for inspection.

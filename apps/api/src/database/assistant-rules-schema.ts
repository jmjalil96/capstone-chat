import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { workspaceMemberships, workspaces } from "./identity-schema.js";

export const workspaceAssistantPromptRevisions = pgTable(
  "workspace_assistant_prompt_revisions",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    revision: integer("revision").notNull(),
    workspaceText: text("workspace_text").notNull(),
    actorKind: text("actor_kind").notNull(),
    actorUserId: text("actor_user_id"),
    actorDisplayName: text("actor_display_name"),
    changeKind: text("change_kind").notNull(),
    revertedFromRevision: integer("reverted_from_revision"),
    createdAt: timestamp("created_at", { precision: 3, withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.workspaceId, table.revision],
      name: "workspace_assistant_prompt_revisions_workspace_revision_pk",
    }),
    foreignKey({
      columns: [table.workspaceId, table.actorUserId],
      foreignColumns: [workspaceMemberships.workspaceId, workspaceMemberships.userId],
      name: "workspace_assistant_prompt_revisions_actor_membership_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.workspaceId, table.revertedFromRevision],
      foreignColumns: [table.workspaceId, table.revision],
      name: "workspace_assistant_prompt_revisions_reverted_from_fk",
    }).onDelete("restrict"),
    check("workspace_assistant_prompt_revisions_revision_check", sql`${table.revision} > 0`),
    check(
      "workspace_assistant_prompt_revisions_text_check",
      sql`char_length(${table.workspaceText}) <= 3200
        AND octet_length(${table.workspaceText}) <= 12800
        AND regexp_replace(${table.workspaceText}, E'[\\t\\n]', '', 'g') !~ '[[:cntrl:]]'`,
    ),
    check(
      "workspace_assistant_prompt_revisions_actor_check",
      sql`(
          ${table.actorKind} = 'system'
          AND ${table.actorUserId} IS NULL
          AND ${table.actorDisplayName} IS NULL
        ) OR (
          ${table.actorKind} = 'user'
          AND ${table.actorUserId} IS NOT NULL
          AND ${table.actorDisplayName} IS NOT NULL
          AND ${table.actorDisplayName} ~ '[^[:space:]]'
        )`,
    ),
    check(
      "workspace_assistant_prompt_revisions_attribution_check",
      sql`(
          ${table.actorKind} = 'system'
          AND ${table.changeKind} = 'bootstrap'
        ) OR (
          ${table.actorKind} = 'user'
          AND ${table.changeKind} <> 'bootstrap'
        )`,
    ),
    check(
      "workspace_assistant_prompt_revisions_change_check",
      sql`(
          ${table.changeKind} IN ('bootstrap', 'save', 'reset')
          AND ${table.revertedFromRevision} IS NULL
        ) OR (
          ${table.changeKind} = 'revert'
          AND ${table.revertedFromRevision} IS NOT NULL
          AND ${table.revertedFromRevision} < ${table.revision}
        )`,
    ),
  ],
);

export const workspaceAssistantPrompts = pgTable(
  "workspace_assistant_prompts",
  {
    workspaceId: uuid("workspace_id")
      .primaryKey()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    revision: integer("revision").notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.workspaceId, table.revision],
      foreignColumns: [
        workspaceAssistantPromptRevisions.workspaceId,
        workspaceAssistantPromptRevisions.revision,
      ],
      name: "workspace_assistant_prompts_revision_fk",
    }).onDelete("restrict"),
    check("workspace_assistant_prompts_revision_check", sql`${table.revision} > 0`),
  ],
);

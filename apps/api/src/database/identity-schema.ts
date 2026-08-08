import { relations, sql } from "drizzle-orm";
import {
  check,
  index,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { user } from "./auth-schema.generated.js";

export const workspaceRole = pgEnum("workspace_role", ["admin", "member"]);
export const approvalStatus = pgEnum("employee_approval_status", [
  "pending",
  "activated",
  "revoked",
]);
export const membershipStatus = pgEnum("workspace_membership_status", ["active", "deactivated"]);

export const workspaces = pgTable("workspaces", {
  id: uuid("id").defaultRandom().primaryKey(),
  identity: text("identity").notNull().unique(),
  displayName: text("display_name").notNull(),
  timezone: text("timezone").default("America/Guayaquil").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const employeeApprovals = pgTable(
  "employee_approvals",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    normalizedEmail: text("normalized_email").notNull(),
    userId: text("user_id").references(() => user.id, { onDelete: "restrict" }),
    role: workspaceRole("role").notNull(),
    status: approvalStatus("status").default("pending").notNull(),
    approvedAt: timestamp("approved_at", { withTimezone: true }).defaultNow().notNull(),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("employee_approvals_workspace_email_unique").on(
      table.workspaceId,
      table.normalizedEmail,
    ),
    uniqueIndex("employee_approvals_workspace_user_unique").on(table.workspaceId, table.userId),
    index("employee_approvals_user_idx").on(table.userId),
    check(
      "employee_approvals_lifecycle_check",
      sql`(${table.status} = 'pending' AND ${table.activatedAt} IS NULL AND ${table.revokedAt} IS NULL)
        OR (${table.status} = 'activated' AND ${table.activatedAt} IS NOT NULL AND ${table.revokedAt} IS NULL)
        OR (${table.status} = 'revoked' AND ${table.revokedAt} IS NOT NULL)`,
    ),
  ],
);

export const workspaceMemberships = pgTable(
  "workspace_memberships",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: workspaceRole("role").notNull(),
    status: membershipStatus("status").default("active").notNull(),
    monthlySoftBudgetUsd: numeric("monthly_soft_budget_usd", {
      precision: 38,
      scale: 18,
    }),
    activatedAt: timestamp("activated_at", { withTimezone: true }).defaultNow().notNull(),
    deactivatedAt: timestamp("deactivated_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("workspace_memberships_workspace_user_unique").on(table.workspaceId, table.userId),
    index("workspace_memberships_user_status_idx").on(table.userId, table.status),
    check(
      "workspace_memberships_lifecycle_check",
      sql`(${table.status} = 'active' AND ${table.deactivatedAt} IS NULL)
        OR (${table.status} = 'deactivated' AND ${table.deactivatedAt} IS NOT NULL)`,
    ),
    check(
      "workspace_memberships_soft_budget_check",
      sql`${table.monthlySoftBudgetUsd} IS NULL OR ${table.monthlySoftBudgetUsd} >= 0`,
    ),
  ],
);

export const workspacesRelations = relations(workspaces, ({ many }) => ({
  approvals: many(employeeApprovals),
  memberships: many(workspaceMemberships),
}));

export const employeeApprovalsRelations = relations(employeeApprovals, ({ one }) => ({
  user: one(user, {
    fields: [employeeApprovals.userId],
    references: [user.id],
  }),
  workspace: one(workspaces, {
    fields: [employeeApprovals.workspaceId],
    references: [workspaces.id],
  }),
}));

export const workspaceMembershipsRelations = relations(workspaceMemberships, ({ one }) => ({
  user: one(user, {
    fields: [workspaceMemberships.userId],
    references: [user.id],
  }),
  workspace: one(workspaces, {
    fields: [workspaceMemberships.workspaceId],
    references: [workspaces.id],
  }),
}));

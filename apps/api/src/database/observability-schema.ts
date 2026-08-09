import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

export const clientErrorRateLimitWindows = pgTable(
  "client_error_rate_limit_windows",
  {
    scope: text("scope").notNull(),
    keyHash: text("key_hash").notNull(),
    windowStartedAt: timestamp("window_started_at", {
      precision: 0,
      withTimezone: true,
    }).notNull(),
    requestCount: integer("request_count").notNull(),
    expiresAt: timestamp("expires_at", { precision: 0, withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.scope, table.keyHash, table.windowStartedAt],
      name: "client_error_rate_limit_windows_pk",
    }),
    check("client_error_rate_limit_scope_check", sql`${table.scope} IN ('global', 'client')`),
    check("client_error_rate_limit_hash_check", sql`${table.keyHash} ~ '^[a-f0-9]{64}$'`),
    check(
      "client_error_rate_limit_count_check",
      sql`${table.requestCount} > 0 AND ${table.requestCount} <= 200`,
    ),
    check(
      "client_error_rate_limit_window_check",
      sql`${table.expiresAt} > ${table.windowStartedAt}`,
    ),
    index("client_error_rate_limit_expiry_idx").on(table.expiresAt),
  ],
);

export const operationalRecoveryMarkers = pgTable(
  "operational_recovery_markers",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    kind: text("kind").notNull(),
    createdAt: timestamp("created_at", { precision: 3, withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check("operational_recovery_markers_kind_check", sql`${table.kind} IN ('pre', 'post')`),
  ],
);

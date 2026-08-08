import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { workspaces } from "./identity-schema.js";

export const modelCatalog = pgTable(
  "model_catalog",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    openRouterModelId: text("openrouter_model_id").notNull(),
    displayName: text("display_name").notNull(),
    canonicalSlug: text("canonical_slug"),
    inputModalities: jsonb("input_modalities").$type<readonly string[]>().notNull(),
    outputModalities: jsonb("output_modalities").$type<readonly string[]>().notNull(),
    supportedParameters: jsonb("supported_parameters").$type<readonly string[]>().notNull(),
    contextLength: integer("context_length").notNull(),
    maximumOutputTokens: integer("maximum_output_tokens").notNull(),
    promptPricePerToken: numeric("prompt_price_per_token", {
      precision: 38,
      scale: 24,
    }).notNull(),
    completionPricePerToken: numeric("completion_price_per_token", {
      precision: 38,
      scale: 24,
    }).notNull(),
    requestPriceUsd: numeric("request_price_usd", { precision: 38, scale: 18 }).notNull(),
    metadataSource: text("metadata_source").notNull(),
    approved: boolean("approved").default(true).notNull(),
    available: boolean("available").notNull(),
    validatedAt: timestamp("validated_at", { precision: 3, withTimezone: true }).notNull(),
    refreshAttemptedAt: timestamp("refresh_attempted_at", { precision: 3, withTimezone: true }),
    refreshLeaseOwner: uuid("refresh_lease_owner"),
    refreshLeaseExpiresAt: timestamp("refresh_lease_expires_at", {
      precision: 3,
      withTimezone: true,
    }),
    createdAt: timestamp("created_at", { precision: 3, withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { precision: 3, withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("model_catalog_openrouter_model_id_unique").on(table.openRouterModelId),
    index("model_catalog_refresh_lease_idx").on(table.refreshLeaseExpiresAt),
    check(
      "model_catalog_nonempty_text_check",
      sql`${table.openRouterModelId} ~ '[^[:space:]]'
        AND ${table.displayName} ~ '[^[:space:]]'
        AND (${table.canonicalSlug} IS NULL OR ${table.canonicalSlug} ~ '[^[:space:]]')`,
    ),
    check(
      "model_catalog_array_metadata_check",
      sql`jsonb_typeof(${table.inputModalities}) = 'array'
        AND jsonb_typeof(${table.outputModalities}) = 'array'
        AND jsonb_typeof(${table.supportedParameters}) = 'array'`,
    ),
    check(
      "model_catalog_limits_check",
      sql`${table.contextLength} > 0
        AND ${table.maximumOutputTokens} > 0
        AND ${table.maximumOutputTokens} <= ${table.contextLength}`,
    ),
    check(
      "model_catalog_prices_check",
      sql`${table.promptPricePerToken} >= 0
        AND ${table.completionPricePerToken} >= 0
        AND ${table.requestPriceUsd} >= 0`,
    ),
    check(
      "model_catalog_source_check",
      sql`${table.metadataSource} IN ('openrouter', 'simulated')`,
    ),
    check(
      "model_catalog_refresh_lease_check",
      sql`(${table.refreshLeaseOwner} IS NULL AND ${table.refreshLeaseExpiresAt} IS NULL)
        OR (${table.refreshLeaseOwner} IS NOT NULL AND ${table.refreshLeaseExpiresAt} IS NOT NULL)`,
    ),
    check(
      "model_catalog_timestamps_check",
      sql`${table.updatedAt} >= ${table.createdAt}
        AND ${table.updatedAt} >= ${table.validatedAt}
        AND (${table.refreshAttemptedAt} IS NULL
          OR (${table.refreshAttemptedAt} >= ${table.validatedAt}
            AND ${table.updatedAt} >= ${table.refreshAttemptedAt}))`,
    ),
  ],
);

export const workspaceModelPolicies = pgTable(
  "workspace_model_policies",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    tier: text("tier").notNull(),
    modelCatalogId: uuid("model_catalog_id")
      .notNull()
      .references(() => modelCatalog.id, { onDelete: "restrict" }),
    enabled: boolean("enabled").default(true).notNull(),
    maximumOutputTokens: integer("maximum_output_tokens").notNull(),
    createdAt: timestamp("created_at", { precision: 3, withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { precision: 3, withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.workspaceId, table.tier],
      name: "workspace_model_policies_workspace_tier_pk",
    }),
    index("workspace_model_policies_catalog_idx").on(table.modelCatalogId),
    check("workspace_model_policies_tier_check", sql`${table.tier} IN ('fast', 'balanced', 'pro')`),
    check("workspace_model_policies_output_limit_check", sql`${table.maximumOutputTokens} > 0`),
    check(
      "workspace_model_policies_timestamps_check",
      sql`${table.updatedAt} >= ${table.createdAt}`,
    ),
  ],
);

export const workspaceCostPolicies = pgTable(
  "workspace_cost_policies",
  {
    workspaceId: uuid("workspace_id")
      .primaryKey()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    monthlyBudgetUsd: numeric("monthly_budget_usd", { precision: 38, scale: 18 }).notNull(),
    defaultTier: text("default_tier").notNull(),
    employeeActiveGenerationLimit: integer("employee_active_generation_limit").notNull(),
    reservationMarginBasisPoints: integer("reservation_margin_basis_points").notNull(),
    createdAt: timestamp("created_at", { precision: 3, withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { precision: 3, withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check("workspace_cost_policies_budget_check", sql`${table.monthlyBudgetUsd} >= 0`),
    check(
      "workspace_cost_policies_default_tier_check",
      sql`${table.defaultTier} IN ('fast', 'balanced', 'pro')`,
    ),
    check(
      "workspace_cost_policies_generation_limit_check",
      sql`${table.employeeActiveGenerationLimit} > 0`,
    ),
    check(
      "workspace_cost_policies_margin_check",
      sql`${table.reservationMarginBasisPoints} >= 0
        AND ${table.reservationMarginBasisPoints} <= 1000000`,
    ),
    check(
      "workspace_cost_policies_timestamps_check",
      sql`${table.updatedAt} >= ${table.createdAt}`,
    ),
  ],
);

export const openRouterPrivacyAttestations = pgTable(
  "openrouter_privacy_attestations",
  {
    workspaceId: uuid("workspace_id")
      .primaryKey()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    attestationVersion: text("attestation_version").notNull(),
    verifiedAt: timestamp("verified_at", { precision: 3, withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { precision: 3, withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { precision: 3, withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check(
      "openrouter_privacy_attestations_version_check",
      sql`${table.attestationVersion} = 'openrouter-privacy-v1'`,
    ),
    check(
      "openrouter_privacy_attestations_timestamps_check",
      sql`${table.updatedAt} >= ${table.createdAt}
        AND ${table.updatedAt} >= ${table.verifiedAt}`,
    ),
  ],
);

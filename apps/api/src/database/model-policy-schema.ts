import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
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
import { workspaceMemberships, workspaces } from "./identity-schema.js";

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
    temperatureSupported: boolean("temperature_supported").default(false).notNull(),
    reasoningMode: text("reasoning_mode").default("unverified").notNull(),
    reasoningEffortSupportKind: text("reasoning_effort_support_kind").default("none").notNull(),
    reasoningEfforts: jsonb("reasoning_efforts")
      .$type<readonly string[]>()
      .default(sql`'[]'::jsonb`)
      .notNull(),
    reasoningDefaultEffort: text("reasoning_default_effort"),
    reasoningDefaultEnabled: boolean("reasoning_default_enabled"),
    reasoningMaxTokensAccepted: boolean("reasoning_max_tokens_accepted").default(false).notNull(),
    reasoningMandatory: boolean("reasoning_mandatory").default(false).notNull(),
    reasoningTraceSafety: text("reasoning_trace_safety").default("unverified").notNull(),
    reasoningContractSource: text("reasoning_contract_source")
      .default("phase11-migration-unverified")
      .notNull(),
    reasoningExclusionVerifiedAt: timestamp("reasoning_exclusion_verified_at", {
      precision: 3,
      withTimezone: true,
    }),
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
        AND jsonb_typeof(${table.supportedParameters}) = 'array'
        AND jsonb_typeof(${table.reasoningEfforts}) = 'array'`,
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
      "model_catalog_reasoning_check",
      sql`${table.reasoningMode} IN ('none', 'optional', 'mandatory', 'unverified')
        AND ${table.reasoningEffortSupportKind} IN ('none', 'all', 'listed')
        AND (
          ${table.reasoningEffortSupportKind} <> 'listed'
          OR jsonb_array_length(${table.reasoningEfforts}) > 0
        )
        AND (
          ${table.reasoningDefaultEffort} IS NULL
          OR ${table.reasoningDefaultEffort}
            IN ('none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max')
        )
        AND ${table.reasoningTraceSafety}
          IN ('non_reasoning', 'provider_excluded', 'unverified')
        AND ${table.reasoningContractSource} ~ '[^[:space:]]'
        AND (
          ${table.reasoningMode} = 'none'
          AND ${table.reasoningMandatory} = false
          AND ${table.reasoningMaxTokensAccepted} = false
          AND ${table.reasoningTraceSafety} = 'non_reasoning'
          AND ${table.reasoningExclusionVerifiedAt} IS NULL
        OR
          ${table.reasoningMode} IN ('optional', 'mandatory')
          AND ${table.reasoningTraceSafety} = 'provider_excluded'
          AND ${table.reasoningExclusionVerifiedAt} IS NOT NULL
          AND ${table.reasoningMandatory} = (${table.reasoningMode} = 'mandatory')
        OR
          ${table.reasoningMode} = 'unverified'
          AND ${table.reasoningTraceSafety} = 'unverified'
          AND ${table.reasoningExclusionVerifiedAt} IS NULL
        )`,
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

export const workspaceModelPolicyRevisions = pgTable(
  "workspace_model_policy_revisions",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    revision: integer("revision").notNull(),
    defaultTier: text("default_tier").notNull(),
    monthlyBudgetUsd: numeric("monthly_budget_usd", { precision: 38, scale: 18 }).notNull(),
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
      name: "workspace_model_policy_revisions_workspace_revision_pk",
    }),
    foreignKey({
      columns: [table.workspaceId, table.actorUserId],
      foreignColumns: [workspaceMemberships.workspaceId, workspaceMemberships.userId],
      name: "workspace_model_policy_revisions_actor_membership_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.workspaceId, table.revertedFromRevision],
      foreignColumns: [table.workspaceId, table.revision],
      name: "workspace_model_policy_revisions_reverted_from_fk",
    }).onDelete("restrict"),
    check("workspace_model_policy_revisions_revision_check", sql`${table.revision} > 0`),
    check(
      "workspace_model_policy_revisions_values_check",
      sql`${table.defaultTier} IN ('fast', 'balanced', 'pro')
        AND ${table.monthlyBudgetUsd} >= 0`,
    ),
    check(
      "workspace_model_policy_revisions_actor_check",
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
      "workspace_model_policy_revisions_attribution_check",
      sql`(
          ${table.actorKind} = 'system'
          AND ${table.changeKind} IN ('bootstrap', 'migration')
        ) OR (
          ${table.actorKind} = 'user'
          AND ${table.changeKind} NOT IN ('bootstrap', 'migration')
        )`,
    ),
    check(
      "workspace_model_policy_revisions_change_check",
      sql`(
          ${table.changeKind} IN ('bootstrap', 'migration', 'update')
          AND ${table.revertedFromRevision} IS NULL
        ) OR (
          ${table.changeKind} = 'revert'
          AND ${table.revertedFromRevision} IS NOT NULL
          AND ${table.revertedFromRevision} < ${table.revision}
        )`,
    ),
  ],
);

export const workspaceModelPolicyRevisionTiers = pgTable(
  "workspace_model_policy_revision_tiers",
  {
    workspaceId: uuid("workspace_id").notNull(),
    revision: integer("revision").notNull(),
    tier: text("tier").notNull(),
    modelCatalogId: uuid("model_catalog_id")
      .notNull()
      .references(() => modelCatalog.id, { onDelete: "restrict" }),
    enabled: boolean("enabled").notNull(),
    maximumOutputTokens: integer("maximum_output_tokens").notNull(),
    reasoningEffort: text("reasoning_effort").notNull(),
    reasoningBudgetTokens: integer("reasoning_budget_tokens").notNull(),
    temperaturePreset: text("temperature_preset").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.workspaceId, table.revision, table.tier],
      name: "workspace_model_policy_revision_tiers_workspace_revision_tier_pk",
    }),
    foreignKey({
      columns: [table.workspaceId, table.revision],
      foreignColumns: [
        workspaceModelPolicyRevisions.workspaceId,
        workspaceModelPolicyRevisions.revision,
      ],
      name: "workspace_model_policy_revision_tiers_revision_fk",
    }).onDelete("cascade"),
    index("workspace_model_policy_revision_tiers_catalog_idx").on(table.modelCatalogId),
    check(
      "workspace_model_policy_revision_tiers_tier_check",
      sql`${table.tier} IN ('fast', 'balanced', 'pro')`,
    ),
    check(
      "workspace_model_policy_revision_tiers_controls_check",
      sql`${table.maximumOutputTokens} > 0
        AND ${table.reasoningEffort} IN ('off', 'low', 'medium', 'high')
        AND ${table.reasoningBudgetTokens} IN (0, 1024, 2048, 4096, 8192)
        AND (
          (${table.reasoningEffort} = 'off' AND ${table.reasoningBudgetTokens} = 0)
          OR (
            ${table.reasoningEffort} <> 'off'
            AND ${table.reasoningBudgetTokens} > 0
          )
        )
        AND ${table.temperaturePreset} IN ('precise', 'balanced', 'flexible', 'creative')`,
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
    reasoningEffort: text("reasoning_effort").default("off").notNull(),
    reasoningBudgetTokens: integer("reasoning_budget_tokens").default(0).notNull(),
    temperaturePreset: text("temperature_preset").default("balanced").notNull(),
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
    check(
      "workspace_model_policies_controls_check",
      sql`${table.maximumOutputTokens} > 0
        AND ${table.reasoningEffort} IN ('off', 'low', 'medium', 'high')
        AND ${table.reasoningBudgetTokens} IN (0, 1024, 2048, 4096, 8192)
        AND (
          (${table.reasoningEffort} = 'off' AND ${table.reasoningBudgetTokens} = 0)
          OR (
            ${table.reasoningEffort} <> 'off'
            AND ${table.reasoningBudgetTokens} > 0
          )
        )
        AND ${table.temperaturePreset} IN ('precise', 'balanced', 'flexible', 'creative')`,
    ),
    check(
      "workspace_model_policies_timestamps_check",
      sql`${table.updatedAt} >= ${table.createdAt}`,
    ),
  ],
);

export const workspaceCatalogApprovals = pgTable(
  "workspace_catalog_approvals",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    modelCatalogId: uuid("model_catalog_id")
      .notNull()
      .references(() => modelCatalog.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { precision: 3, withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.workspaceId, table.modelCatalogId],
      name: "workspace_catalog_approvals_workspace_catalog_pk",
    }),
    index("workspace_catalog_approvals_catalog_idx").on(table.modelCatalogId),
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
    revision: integer("revision").default(1).notNull(),
    createdAt: timestamp("created_at", { precision: 3, withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { precision: 3, withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.workspaceId, table.revision],
      foreignColumns: [
        workspaceModelPolicyRevisions.workspaceId,
        workspaceModelPolicyRevisions.revision,
      ],
      name: "workspace_cost_policies_revision_fk",
    }).onDelete("restrict"),
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
    check("workspace_cost_policies_revision_check", sql`${table.revision} > 0`),
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

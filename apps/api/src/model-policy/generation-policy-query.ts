import { type SQL, sql } from "drizzle-orm";
import type { ModelTier } from "./catalog.js";

export interface GenerationPolicyRow extends Record<string, unknown> {
  readonly approvedCatalogId: string | null;
  readonly attestationVerifiedAt: Date | string | null;
  readonly attestationVersion: string | null;
  readonly available: boolean;
  readonly catalogMaximumOutputTokens: number;
  readonly completionPricePerToken: string;
  readonly contextLength: number;
  readonly employeeActiveGenerationLimit: number;
  readonly enabled: boolean;
  readonly maximumOutputTokens: number;
  readonly metadataSource: string;
  readonly monthlyBudgetUsd: string;
  readonly promptPricePerToken: string;
  readonly policyRevision: number;
  readonly reasoningBudgetTokens: number;
  readonly reasoningDefaultEffort: string | null;
  readonly reasoningDefaultEnabled: boolean | null;
  readonly reasoningEffort: string;
  readonly reasoningEffortSupportKind: string;
  readonly reasoningEfforts: readonly string[];
  readonly reasoningMaxTokensAccepted: boolean;
  readonly reasoningMode: string;
  readonly reasoningTraceSafety: string;
  readonly requestPriceUsd: string;
  readonly reservationMarginBasisPoints: number;
  readonly resolvedModel: string;
  readonly temperaturePreset: string;
  readonly temperatureSupported: boolean;
  readonly tier: string;
}

export function generationPolicyRowsQuery(
  workspaceId: string,
  tiers: readonly ModelTier[],
  options: { readonly gate?: SQL; readonly lockRows: boolean },
): SQL<GenerationPolicyRow> {
  const gate = options.gate ?? sql`true`;
  const rowLock = options.lockRows
    ? sql`FOR SHARE OF policy, cost_policy, policy_revision, revision_tier, catalog, approval`
    : sql``;
  return sql<GenerationPolicyRow>`
    SELECT
      approval.model_catalog_id AS "approvedCatalogId",
      privacy.verified_at AS "attestationVerifiedAt",
      privacy.attestation_version AS "attestationVersion",
      catalog.available,
      catalog.maximum_output_tokens AS "catalogMaximumOutputTokens",
      catalog.completion_price_per_token AS "completionPricePerToken",
      catalog.context_length AS "contextLength",
      cost_policy.employee_active_generation_limit AS "employeeActiveGenerationLimit",
      policy.enabled,
      policy.maximum_output_tokens AS "maximumOutputTokens",
      catalog.metadata_source AS "metadataSource",
      cost_policy.monthly_budget_usd AS "monthlyBudgetUsd",
      catalog.prompt_price_per_token AS "promptPricePerToken",
      cost_policy.revision AS "policyRevision",
      policy.reasoning_budget_tokens AS "reasoningBudgetTokens",
      catalog.reasoning_default_effort AS "reasoningDefaultEffort",
      catalog.reasoning_default_enabled AS "reasoningDefaultEnabled",
      policy.reasoning_effort AS "reasoningEffort",
      catalog.reasoning_effort_support_kind AS "reasoningEffortSupportKind",
      catalog.reasoning_efforts AS "reasoningEfforts",
      catalog.reasoning_max_tokens_accepted AS "reasoningMaxTokensAccepted",
      catalog.reasoning_mode AS "reasoningMode",
      catalog.reasoning_trace_safety AS "reasoningTraceSafety",
      catalog.request_price_usd AS "requestPriceUsd",
      cost_policy.reservation_margin_basis_points AS "reservationMarginBasisPoints",
      catalog.openrouter_model_id AS "resolvedModel",
      policy.temperature_preset AS "temperaturePreset",
      catalog.temperature_supported AS "temperatureSupported",
      policy.tier
    FROM workspace_model_policies AS policy
    INNER JOIN workspace_cost_policies AS cost_policy
      ON cost_policy.workspace_id = policy.workspace_id
    INNER JOIN workspace_model_policy_revisions AS policy_revision
      ON policy_revision.workspace_id = cost_policy.workspace_id
      AND policy_revision.revision = cost_policy.revision
      AND policy_revision.default_tier = cost_policy.default_tier
      AND policy_revision.monthly_budget_usd = cost_policy.monthly_budget_usd
    INNER JOIN workspace_model_policy_revision_tiers AS revision_tier
      ON revision_tier.workspace_id = policy.workspace_id
      AND revision_tier.revision = cost_policy.revision
      AND revision_tier.tier = policy.tier
      AND revision_tier.model_catalog_id = policy.model_catalog_id
      AND revision_tier.enabled = policy.enabled
      AND revision_tier.maximum_output_tokens = policy.maximum_output_tokens
      AND revision_tier.reasoning_effort = policy.reasoning_effort
      AND revision_tier.reasoning_budget_tokens = policy.reasoning_budget_tokens
      AND revision_tier.temperature_preset = policy.temperature_preset
    INNER JOIN model_catalog AS catalog
      ON catalog.id = policy.model_catalog_id
    INNER JOIN workspace_catalog_approvals AS approval
      ON approval.workspace_id = policy.workspace_id
      AND approval.model_catalog_id = policy.model_catalog_id
    LEFT JOIN openrouter_privacy_attestations AS privacy
      ON privacy.workspace_id = policy.workspace_id
    WHERE ${gate}
      AND policy.workspace_id = ${workspaceId}::uuid
      AND policy.tier IN (${sql.join(
        tiers.map((tier) => sql`${tier}`),
        sql`, `,
      )})
    ${rowLock}
  `;
}

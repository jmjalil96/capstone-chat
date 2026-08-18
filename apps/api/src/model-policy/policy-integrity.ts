import { and, eq } from "drizzle-orm";
import type { AppDatabaseExecutor } from "../database/database.js";
import {
  workspaceCostPolicies,
  workspaceModelPolicies,
  workspaceModelPolicyRevisions,
  workspaceModelPolicyRevisionTiers,
} from "../database/model-policy-schema.js";
import { modelTiers } from "./catalog.js";
import { ModelPolicyConflictError } from "./errors.js";
import { compareDecimal } from "./money.js";

function drift(): never {
  throw new ModelPolicyConflictError("Live model policy does not match its immutable head");
}

export async function assertLivePolicyMatchesHead(
  executor: AppDatabaseExecutor,
  workspaceId: string,
): Promise<number> {
  const headRows = await executor
    .select({
      defaultTier: workspaceCostPolicies.defaultTier,
      monthlyBudgetUsd: workspaceCostPolicies.monthlyBudgetUsd,
      revision: workspaceCostPolicies.revision,
    })
    .from(workspaceCostPolicies)
    .where(eq(workspaceCostPolicies.workspaceId, workspaceId))
    .limit(1);
  const head = headRows[0];
  if (head === undefined) {
    return drift();
  }

  const revisionRows = await executor
    .select({
      defaultTier: workspaceModelPolicyRevisions.defaultTier,
      monthlyBudgetUsd: workspaceModelPolicyRevisions.monthlyBudgetUsd,
    })
    .from(workspaceModelPolicyRevisions)
    .where(
      and(
        eq(workspaceModelPolicyRevisions.workspaceId, workspaceId),
        eq(workspaceModelPolicyRevisions.revision, head.revision),
      ),
    )
    .limit(1);
  const revision = revisionRows[0];
  if (
    revision === undefined ||
    revision.defaultTier !== head.defaultTier ||
    compareDecimal(revision.monthlyBudgetUsd, head.monthlyBudgetUsd) !== 0
  ) {
    return drift();
  }

  const liveRows = await executor
    .select({
      enabled: workspaceModelPolicies.enabled,
      maximumOutputTokens: workspaceModelPolicies.maximumOutputTokens,
      modelCatalogId: workspaceModelPolicies.modelCatalogId,
      reasoningBudgetTokens: workspaceModelPolicies.reasoningBudgetTokens,
      reasoningEffort: workspaceModelPolicies.reasoningEffort,
      temperaturePreset: workspaceModelPolicies.temperaturePreset,
      tier: workspaceModelPolicies.tier,
    })
    .from(workspaceModelPolicies)
    .where(eq(workspaceModelPolicies.workspaceId, workspaceId));
  const tierRows = await executor
    .select({
      enabled: workspaceModelPolicyRevisionTiers.enabled,
      maximumOutputTokens: workspaceModelPolicyRevisionTiers.maximumOutputTokens,
      modelCatalogId: workspaceModelPolicyRevisionTiers.modelCatalogId,
      reasoningBudgetTokens: workspaceModelPolicyRevisionTiers.reasoningBudgetTokens,
      reasoningEffort: workspaceModelPolicyRevisionTiers.reasoningEffort,
      temperaturePreset: workspaceModelPolicyRevisionTiers.temperaturePreset,
      tier: workspaceModelPolicyRevisionTiers.tier,
    })
    .from(workspaceModelPolicyRevisionTiers)
    .where(
      and(
        eq(workspaceModelPolicyRevisionTiers.workspaceId, workspaceId),
        eq(workspaceModelPolicyRevisionTiers.revision, head.revision),
      ),
    );
  if (liveRows.length !== modelTiers.length || tierRows.length !== modelTiers.length) {
    return drift();
  }

  for (const tier of modelTiers) {
    const live = liveRows.find((row) => row.tier === tier);
    const immutable = tierRows.find((row) => row.tier === tier);
    if (
      live === undefined ||
      immutable === undefined ||
      live.modelCatalogId !== immutable.modelCatalogId ||
      live.enabled !== immutable.enabled ||
      live.maximumOutputTokens !== immutable.maximumOutputTokens ||
      live.reasoningEffort !== immutable.reasoningEffort ||
      live.reasoningBudgetTokens !== immutable.reasoningBudgetTokens ||
      live.temperaturePreset !== immutable.temperaturePreset
    ) {
      return drift();
    }
  }

  return head.revision;
}

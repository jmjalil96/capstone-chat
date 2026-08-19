import type { AdminModelPolicyResponse, AdminUpdateModelPolicyRequest } from "@capstone/protocol";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { AppDatabase, AppDatabaseExecutor } from "../database/database.js";
import { workspaces } from "../database/identity-schema.js";
import {
  modelCatalog,
  workspaceCatalogApprovals,
  workspaceCostPolicies,
  workspaceModelPolicies,
} from "../database/model-policy-schema.js";
import { workspaceBudgetConsumptionUsd, workspaceBudgetPeriod } from "./budget-period.js";
import type { ModelTier } from "./catalog.js";
import { modelTiers } from "./catalog.js";
import {
  ModelPolicyChangedError,
  ModelPolicyConflictError,
  ModelPolicyUnavailableError,
} from "./errors.js";
import { canonicalUsd, compareDecimal } from "./money.js";

type ModelPolicyMode = "openrouter" | "simulated";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

interface LockedPolicyRow {
  readonly createdAt: Date;
  readonly enabled: boolean;
  readonly maximumOutputTokens: number;
  readonly modelCatalogId: string;
  readonly tier: string;
  readonly updatedAt: Date;
}

export interface PolicyAdministrationOptions {
  readonly now: () => Date;
  readonly privacyIsVerified: (
    database: AppDatabaseExecutor,
    workspaceId: string,
    at: Date,
  ) => Promise<boolean>;
}

function latestDate(...dates: readonly Date[]): Date {
  return new Date(Math.max(...dates.map((date) => date.getTime())));
}

function assertUuid(value: string, label: string): void {
  if (!uuidPattern.test(value)) {
    throw new ModelPolicyConflictError(`${label} must be a UUID`);
  }
}

function validatePolicyInput(input: AdminUpdateModelPolicyRequest): string {
  if (
    !Number.isSafeInteger(input.observedRevision) ||
    input.observedRevision <= 0 ||
    input.observedRevision >= 2_147_483_647
  ) {
    throw new ModelPolicyConflictError("Observed policy revision is invalid");
  }
  if (input.tiers.length !== modelTiers.length) {
    throw new ModelPolicyConflictError("Model policy must contain exactly three tiers");
  }
  for (const [index, tier] of modelTiers.entries()) {
    const candidate = input.tiers[index];
    if (candidate?.tier !== tier) {
      throw new ModelPolicyConflictError("Model policy tiers are not in canonical order");
    }
    assertUuid(candidate.catalogId, `${tier} catalog ID`);
    if (
      !Number.isSafeInteger(candidate.maximumOutputTokens) ||
      candidate.maximumOutputTokens <= 0
    ) {
      throw new ModelPolicyConflictError(`${tier} output allowance is invalid`);
    }
  }
  if (!input.tiers.some(({ enabled }) => enabled)) {
    throw new ModelPolicyConflictError("At least one model tier must remain enabled");
  }
  const defaultPolicy = input.tiers.find(({ tier }) => tier === input.defaultTier);
  if (defaultPolicy?.enabled !== true) {
    throw new ModelPolicyConflictError("The default model tier must be enabled");
  }
  try {
    return canonicalUsd(input.monthlyBudgetUsd, "monthly workspace budget");
  } catch {
    throw new ModelPolicyConflictError("Monthly workspace budget is invalid");
  }
}

function tierFromStored(value: string): ModelTier {
  const tier = modelTiers.find((candidate) => candidate === value);
  if (tier === undefined) {
    throw new ModelPolicyUnavailableError("Workspace model policy contains an invalid tier");
  }
  return tier;
}

export function createPolicyAdministration(
  database: AppDatabase,
  options: PolicyAdministrationOptions,
) {
  async function selectAdminPolicy(
    executor: AppDatabaseExecutor,
    workspaceId: string,
    mode: ModelPolicyMode,
    checkedAt: Date,
  ): Promise<AdminModelPolicyResponse> {
    const [costRows, rows, attested] = await Promise.all([
      executor
        .select({
          defaultTier: workspaceCostPolicies.defaultTier,
          monthlyBudgetUsd: workspaceCostPolicies.monthlyBudgetUsd,
          revision: workspaceCostPolicies.revision,
        })
        .from(workspaceCostPolicies)
        .where(eq(workspaceCostPolicies.workspaceId, workspaceId))
        .limit(1),
      executor
        .select({
          approvedCatalogId: workspaceCatalogApprovals.modelCatalogId,
          catalogAvailable: modelCatalog.available,
          catalogContextLength: modelCatalog.contextLength,
          catalogDisplayName: modelCatalog.displayName,
          catalogId: modelCatalog.id,
          catalogMaximumOutputTokens: modelCatalog.maximumOutputTokens,
          catalogModelId: modelCatalog.openRouterModelId,
          catalogValidatedAt: modelCatalog.validatedAt,
          enabled: workspaceModelPolicies.enabled,
          metadataSource: modelCatalog.metadataSource,
          policyMaximumOutputTokens: workspaceModelPolicies.maximumOutputTokens,
          tier: workspaceModelPolicies.tier,
        })
        .from(workspaceModelPolicies)
        .innerJoin(modelCatalog, eq(modelCatalog.id, workspaceModelPolicies.modelCatalogId))
        .leftJoin(
          workspaceCatalogApprovals,
          and(
            eq(workspaceCatalogApprovals.workspaceId, workspaceModelPolicies.workspaceId),
            eq(workspaceCatalogApprovals.modelCatalogId, workspaceModelPolicies.modelCatalogId),
          ),
        )
        .where(eq(workspaceModelPolicies.workspaceId, workspaceId)),
      mode === "simulated"
        ? Promise.resolve(true)
        : options.privacyIsVerified(executor, workspaceId, checkedAt),
    ]);
    const cost = costRows[0];
    if (cost === undefined || rows.length !== modelTiers.length) {
      throw new ModelPolicyUnavailableError("Workspace model policy is not bootstrapped");
    }
    const defaultTier = tierFromStored(cost.defaultTier);
    const tiers = modelTiers.map((tier) => {
      const row = rows.find((candidate) => candidate.tier === tier);
      if (row === undefined) {
        throw new ModelPolicyUnavailableError("Workspace model policy is incomplete");
      }
      return Object.freeze({
        available:
          row.enabled &&
          row.approvedCatalogId !== null &&
          row.catalogAvailable &&
          row.metadataSource === mode &&
          row.policyMaximumOutputTokens <= row.catalogMaximumOutputTokens &&
          attested,
        catalog: Object.freeze({
          available: row.catalogAvailable,
          contextLength: row.catalogContextLength,
          displayName: row.catalogDisplayName,
          maximumOutputTokens: row.catalogMaximumOutputTokens,
          modelId: row.catalogModelId,
          validatedAt: row.catalogValidatedAt.toISOString(),
        }),
        catalogId: row.catalogId,
        enabled: row.enabled,
        maximumOutputTokens: row.policyMaximumOutputTokens,
        tier,
      });
    }) as AdminModelPolicyResponse["tiers"];
    return Object.freeze({
      currency: "USD",
      defaultTier,
      monthlyBudgetUsd: canonicalUsd(cost.monthlyBudgetUsd),
      revision: cost.revision,
      tiers,
    });
  }

  async function readAdminPolicy(
    workspaceId: string,
    mode: ModelPolicyMode,
  ): Promise<AdminModelPolicyResponse> {
    return selectAdminPolicy(database, workspaceId, mode, options.now());
  }

  async function replaceAdminPolicy(
    workspaceId: string,
    mode: ModelPolicyMode,
    input: AdminUpdateModelPolicyRequest,
  ): Promise<AdminModelPolicyResponse> {
    const monthlyBudgetUsd = validatePolicyInput(input);
    return database.transaction(async (transaction) => {
      const workspaceRows = await transaction
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId))
        .limit(1)
        .for("update");
      if (workspaceRows[0] === undefined) {
        throw new ModelPolicyUnavailableError("Workspace model policy is unavailable");
      }
      const changedAt = options.now();

      const costRows = await transaction
        .select()
        .from(workspaceCostPolicies)
        .where(eq(workspaceCostPolicies.workspaceId, workspaceId))
        .limit(1)
        .for("update");
      const cost = costRows[0];
      if (cost === undefined) {
        throw new ModelPolicyUnavailableError("Workspace model policy is not bootstrapped");
      }
      if (cost.revision !== input.observedRevision) {
        throw new ModelPolicyChangedError();
      }

      const oldRows = await transaction
        .select({
          createdAt: workspaceModelPolicies.createdAt,
          enabled: workspaceModelPolicies.enabled,
          maximumOutputTokens: workspaceModelPolicies.maximumOutputTokens,
          modelCatalogId: workspaceModelPolicies.modelCatalogId,
          tier: workspaceModelPolicies.tier,
          updatedAt: workspaceModelPolicies.updatedAt,
        })
        .from(workspaceModelPolicies)
        .where(eq(workspaceModelPolicies.workspaceId, workspaceId))
        .orderBy(asc(workspaceModelPolicies.tier))
        .for("update");
      if (
        oldRows.length !== modelTiers.length ||
        !modelTiers.every((tier) => oldRows.some((row) => row.tier === tier))
      ) {
        throw new ModelPolicyUnavailableError("Workspace model policy is incomplete");
      }

      const targetIds = [...new Set(input.tiers.map(({ catalogId }) => catalogId))].sort();
      const catalogs = await transaction
        .select({
          available: modelCatalog.available,
          id: modelCatalog.id,
          maximumOutputTokens: modelCatalog.maximumOutputTokens,
          metadataSource: modelCatalog.metadataSource,
          validatedAt: modelCatalog.validatedAt,
        })
        .from(modelCatalog)
        .innerJoin(
          workspaceCatalogApprovals,
          and(
            eq(workspaceCatalogApprovals.modelCatalogId, modelCatalog.id),
            eq(workspaceCatalogApprovals.workspaceId, workspaceId),
          ),
        )
        .where(inArray(modelCatalog.id, targetIds))
        .orderBy(asc(modelCatalog.id))
        .for("share");
      if (catalogs.length !== targetIds.length) {
        throw new ModelPolicyConflictError(
          "Every model mapping must be approved for this workspace",
        );
      }
      const catalogById = new Map(catalogs.map((catalog) => [catalog.id, catalog]));
      const attested =
        mode === "simulated"
          ? true
          : await options.privacyIsVerified(transaction, workspaceId, changedAt);
      for (const next of input.tiers) {
        const previous = oldRows.find((row) => row.tier === next.tier) as
          | LockedPolicyRow
          | undefined;
        const catalog = catalogById.get(next.catalogId);
        if (previous === undefined || catalog === undefined || catalog.metadataSource !== mode) {
          throw new ModelPolicyConflictError("Model mapping does not match the gateway mode");
        }
        const requiresCurrentMetadata =
          (!previous.enabled && next.enabled) ||
          previous.modelCatalogId !== next.catalogId ||
          next.maximumOutputTokens > previous.maximumOutputTokens ||
          (cost.defaultTier !== input.defaultTier && next.tier === input.defaultTier);
        const currentMetadataIsValid =
          catalog.available &&
          next.maximumOutputTokens <= catalog.maximumOutputTokens &&
          catalog.validatedAt.getTime() <= changedAt.getTime() &&
          attested;
        if (requiresCurrentMetadata && !currentMetadataIsValid) {
          throw new ModelPolicyConflictError(
            `${next.tier} requires current eligible catalog metadata`,
          );
        }
      }

      const period = await workspaceBudgetPeriod(transaction, workspaceId, changedAt);
      if (period === null) {
        throw new ModelPolicyUnavailableError("Workspace budget period is unavailable");
      }
      const consumedUsd = await workspaceBudgetConsumptionUsd(transaction, workspaceId, period);
      if (compareDecimal(monthlyBudgetUsd, consumedUsd) < 0) {
        throw new ModelPolicyConflictError(
          "Monthly workspace budget cannot be lower than current consumption",
        );
      }

      const safeCostUpdatedAt = latestDate(changedAt, cost.createdAt, cost.updatedAt);
      const updatedCost = await transaction
        .update(workspaceCostPolicies)
        .set({
          defaultTier: input.defaultTier,
          monthlyBudgetUsd,
          revision: input.observedRevision + 1,
          updatedAt: safeCostUpdatedAt,
        })
        .where(
          and(
            eq(workspaceCostPolicies.workspaceId, workspaceId),
            eq(workspaceCostPolicies.revision, input.observedRevision),
          ),
        )
        .returning({ revision: workspaceCostPolicies.revision });
      if (updatedCost[0] === undefined) {
        throw new ModelPolicyChangedError();
      }
      for (const next of input.tiers) {
        const previous = oldRows.find((row) => row.tier === next.tier);
        if (previous === undefined) {
          throw new ModelPolicyUnavailableError("Workspace model policy is incomplete");
        }
        await transaction
          .update(workspaceModelPolicies)
          .set({
            enabled: next.enabled,
            maximumOutputTokens: next.maximumOutputTokens,
            modelCatalogId: next.catalogId,
            updatedAt: latestDate(changedAt, previous.createdAt, previous.updatedAt),
          })
          .where(
            and(
              eq(workspaceModelPolicies.workspaceId, workspaceId),
              eq(workspaceModelPolicies.tier, next.tier),
            ),
          );
      }
      return selectAdminPolicy(transaction, workspaceId, mode, changedAt);
    });
  }

  return Object.freeze({ readAdminPolicy, replaceAdminPolicy });
}

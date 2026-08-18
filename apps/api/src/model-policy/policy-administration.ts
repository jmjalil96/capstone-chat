import {
  ADMIN_POLICY_HISTORY_PAGE_SIZE,
  type AdminGatewayEffort,
  type AdminModelCapability,
  type AdminModelPolicyHistoryResponse,
  type AdminModelPolicyResponse,
  type AdminParameterSupport,
  type AdminRevisionActor,
  type AdminUpdateModelPolicyRequest,
} from "@capstone/protocol";
import { and, asc, desc, eq, inArray, lt } from "drizzle-orm";
import { type CursorCodec, cursorInteger, cursorString } from "../conversations/cursor.js";
import type { AppDatabase, AppDatabaseExecutor } from "../database/database.js";
import { workspaces } from "../database/identity-schema.js";
import {
  modelCatalog,
  workspaceCatalogApprovals,
  workspaceCostPolicies,
  workspaceModelPolicies,
  workspaceModelPolicyRevisions,
  workspaceModelPolicyRevisionTiers,
} from "../database/model-policy-schema.js";
import { ApplicationError } from "../errors.js";
import type { RequestActor } from "../identity/authorization.js";
import { workspaceBudgetConsumptionUsd, workspaceBudgetPeriod } from "./budget-period.js";
import type { ModelTier } from "./catalog.js";
import { modelTiers } from "./catalog.js";
import { resolveEffectiveModelParameters } from "./effective-parameters.js";
import {
  ModelPolicyChangedError,
  ModelPolicyConflictError,
  ModelPolicyRevisionNotFoundError,
  ModelPolicyUnavailableError,
} from "./errors.js";
import { canonicalUsd, compareDecimal } from "./money.js";
import { assertLivePolicyMatchesHead } from "./policy-integrity.js";

type ModelPolicyMode = "openrouter" | "simulated";
type PolicyChangeKind = "bootstrap" | "revert" | "update";

const historyCursorKind = "admin-model-policy-history";
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

interface LockedPolicyRow {
  readonly createdAt: Date;
  readonly enabled: boolean;
  readonly maximumOutputTokens: number;
  readonly modelCatalogId: string;
  readonly reasoningBudgetTokens: number;
  readonly reasoningEffort: string;
  readonly temperaturePreset: string;
  readonly tier: string;
  readonly updatedAt: Date;
}

export interface PolicyAdministrationOptions {
  readonly cursorCodec?: CursorCodec;
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
    if (
      (candidate.reasoningEffort === "off" && candidate.reasoningBudgetTokens !== 0) ||
      (candidate.reasoningEffort !== "off" &&
        (candidate.reasoningBudgetTokens === 0 ||
          candidate.reasoningBudgetTokens > candidate.maximumOutputTokens - 1_024))
    ) {
      throw new ModelPolicyConflictError(`${tier} reasoning budget is invalid`);
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

function revisionActor(row: {
  readonly actorDisplayName: string | null;
  readonly actorKind: string;
  readonly actorUserId: string | null;
}): AdminRevisionActor {
  if (row.actorKind === "system") {
    return Object.freeze({ kind: "system", label: "Sistema" });
  }
  if (row.actorKind !== "user" || row.actorUserId === null || row.actorDisplayName === null) {
    throw new ModelPolicyUnavailableError("Stored policy actor is invalid");
  }
  return Object.freeze({
    displayName: row.actorDisplayName,
    kind: "user",
    userId: row.actorUserId,
  });
}

function capabilityFromRow(row: {
  readonly reasoningDefaultEffort: string | null;
  readonly reasoningDefaultEnabled: boolean | null;
  readonly reasoningEffortSupportKind: string;
  readonly reasoningEfforts: readonly string[];
  readonly reasoningMaxTokensAccepted: boolean;
  readonly reasoningMode: string;
  readonly reasoningTraceSafety: string;
  readonly temperatureSupported: boolean;
}): AdminModelCapability {
  const efforts = row.reasoningEfforts.filter((effort) =>
    ["none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(effort),
  ) as AdminGatewayEffort[];
  const effortSupport =
    row.reasoningEffortSupportKind === "all"
      ? ({ kind: "all" } as const)
      : row.reasoningEffortSupportKind === "listed" && efforts.length > 0
        ? ({ kind: "listed", values: efforts } as const)
        : ({ kind: "none" } as const);
  if (
    !["none", "optional", "mandatory", "unverified"].includes(row.reasoningMode) ||
    !["non_reasoning", "provider_excluded", "unverified"].includes(row.reasoningTraceSafety)
  ) {
    throw new ModelPolicyUnavailableError("Stored catalog capability is invalid");
  }
  return Object.freeze({
    reasoning: Object.freeze({
      defaultEffort:
        (["none", "minimal", "low", "medium", "high", "xhigh", "max"].find(
          (effort) => effort === row.reasoningDefaultEffort,
        ) as AdminGatewayEffort | undefined) ?? null,
      defaultEnabled: row.reasoningDefaultEnabled,
      effortSupport: Object.freeze(effortSupport),
      kind: row.reasoningMode as AdminModelCapability["reasoning"]["kind"],
      maxTokensAccepted: row.reasoningMaxTokensAccepted,
      traceSafety: row.reasoningTraceSafety as AdminModelCapability["reasoning"]["traceSafety"],
    }),
    temperatureSupported: row.temperatureSupported,
  });
}

function policyChangeKind(value: string): PolicyChangeKind {
  if (value !== "bootstrap" && value !== "update" && value !== "revert") {
    throw new ModelPolicyUnavailableError("Stored policy change kind is invalid");
  }
  return value;
}

export function createPolicyAdministration(
  database: AppDatabase,
  options: PolicyAdministrationOptions,
) {
  async function selectRevisionPolicy(
    executor: AppDatabaseExecutor,
    workspaceId: string,
    mode: ModelPolicyMode,
    revision: number,
    checkedAt: Date,
  ): Promise<AdminModelPolicyResponse> {
    const parentRows = await executor
      .select()
      .from(workspaceModelPolicyRevisions)
      .where(
        and(
          eq(workspaceModelPolicyRevisions.workspaceId, workspaceId),
          eq(workspaceModelPolicyRevisions.revision, revision),
        ),
      )
      .limit(1);
    const parent = parentRows[0];
    if (parent === undefined) {
      throw new ModelPolicyRevisionNotFoundError();
    }
    const rows = await executor
      .select({
        approvedCatalogId: workspaceCatalogApprovals.modelCatalogId,
        catalogAvailable: modelCatalog.available,
        catalogContextLength: modelCatalog.contextLength,
        catalogDisplayName: modelCatalog.displayName,
        catalogId: modelCatalog.id,
        catalogMaximumOutputTokens: modelCatalog.maximumOutputTokens,
        catalogModelId: modelCatalog.openRouterModelId,
        catalogValidatedAt: modelCatalog.validatedAt,
        enabled: workspaceModelPolicyRevisionTiers.enabled,
        metadataSource: modelCatalog.metadataSource,
        policyMaximumOutputTokens: workspaceModelPolicyRevisionTiers.maximumOutputTokens,
        reasoningBudgetTokens: workspaceModelPolicyRevisionTiers.reasoningBudgetTokens,
        reasoningDefaultEffort: modelCatalog.reasoningDefaultEffort,
        reasoningDefaultEnabled: modelCatalog.reasoningDefaultEnabled,
        reasoningEffort: workspaceModelPolicyRevisionTiers.reasoningEffort,
        reasoningEffortSupportKind: modelCatalog.reasoningEffortSupportKind,
        reasoningEfforts: modelCatalog.reasoningEfforts,
        reasoningMaxTokensAccepted: modelCatalog.reasoningMaxTokensAccepted,
        reasoningMode: modelCatalog.reasoningMode,
        reasoningTraceSafety: modelCatalog.reasoningTraceSafety,
        temperaturePreset: workspaceModelPolicyRevisionTiers.temperaturePreset,
        temperatureSupported: modelCatalog.temperatureSupported,
        tier: workspaceModelPolicyRevisionTiers.tier,
      })
      .from(workspaceModelPolicyRevisionTiers)
      .innerJoin(
        modelCatalog,
        eq(modelCatalog.id, workspaceModelPolicyRevisionTiers.modelCatalogId),
      )
      .leftJoin(
        workspaceCatalogApprovals,
        and(
          eq(workspaceCatalogApprovals.workspaceId, workspaceId),
          eq(
            workspaceCatalogApprovals.modelCatalogId,
            workspaceModelPolicyRevisionTiers.modelCatalogId,
          ),
        ),
      )
      .where(
        and(
          eq(workspaceModelPolicyRevisionTiers.workspaceId, workspaceId),
          eq(workspaceModelPolicyRevisionTiers.revision, revision),
        ),
      );
    if (rows.length !== modelTiers.length) {
      throw new ModelPolicyUnavailableError("Workspace model policy revision is incomplete");
    }
    const attested =
      mode === "simulated"
        ? true
        : await options.privacyIsVerified(executor, workspaceId, checkedAt);
    const tiers = modelTiers.map((tier) => {
      const row = rows.find((candidate) => candidate.tier === tier);
      if (row === undefined) {
        throw new ModelPolicyUnavailableError("Workspace model policy revision is incomplete");
      }
      const capability = capabilityFromRow(row);
      if (
        !["off", "low", "medium", "high"].includes(row.reasoningEffort) ||
        ![0, 1_024, 2_048, 4_096, 8_192].includes(row.reasoningBudgetTokens) ||
        !["precise", "balanced", "flexible", "creative"].includes(row.temperaturePreset)
      ) {
        throw new ModelPolicyUnavailableError("Stored tier behavior is invalid");
      }
      const resolved = resolveEffectiveModelParameters({
        capability: {
          reasoning: {
            ...capability.reasoning,
            contractSource: "stored-catalog",
            exclusionVerifiedAt:
              capability.reasoning.traceSafety === "provider_excluded" ? checkedAt : null,
          },
          temperatureSupported: capability.temperatureSupported,
        },
        maximumOutputTokens: row.policyMaximumOutputTokens,
        purpose: "chat",
        reasoningBudgetTokens: row.reasoningBudgetTokens as 0 | 1_024 | 2_048 | 4_096 | 8_192,
        reasoningEffort: row.reasoningEffort as "off" | "low" | "medium" | "high",
        temperaturePreset: row.temperaturePreset as
          | "precise"
          | "balanced"
          | "flexible"
          | "creative",
        tier,
      });
      return Object.freeze({
        available:
          row.enabled &&
          row.approvedCatalogId !== null &&
          row.catalogAvailable &&
          row.metadataSource === mode &&
          row.policyMaximumOutputTokens <= row.catalogMaximumOutputTokens &&
          capability.reasoning.kind !== "unverified" &&
          attested,
        budgetStatus: resolved.budgetStatus as AdminParameterSupport,
        catalog: Object.freeze({
          available: row.catalogAvailable,
          capability,
          contextLength: row.catalogContextLength,
          displayName: row.catalogDisplayName,
          maximumOutputTokens: row.catalogMaximumOutputTokens,
          modelId: row.catalogModelId,
          validatedAt: row.catalogValidatedAt.toISOString(),
        }),
        catalogId: row.catalogId,
        effortStatus: resolved.effortStatus as AdminParameterSupport,
        enabled: row.enabled,
        maximumOutputTokens: row.policyMaximumOutputTokens,
        reasoningBudgetTokens: row.reasoningBudgetTokens as 0 | 1_024 | 2_048 | 4_096 | 8_192,
        reasoningEffort: row.reasoningEffort as "off" | "low" | "medium" | "high",
        temperaturePreset: row.temperaturePreset as
          | "precise"
          | "balanced"
          | "flexible"
          | "creative",
        temperatureStatus: resolved.temperatureStatus as AdminParameterSupport,
        tier,
      });
    }) as AdminModelPolicyResponse["tiers"];
    return Object.freeze({
      actor: revisionActor(parent),
      changeKind: policyChangeKind(parent.changeKind),
      currency: "USD",
      defaultTier: tierFromStored(parent.defaultTier),
      monthlyBudgetUsd: canonicalUsd(parent.monthlyBudgetUsd),
      revertedFromRevision: parent.revertedFromRevision,
      revision: parent.revision,
      tiers,
      updatedAt: parent.createdAt.toISOString(),
    });
  }

  async function readAdminPolicy(
    workspaceId: string,
    mode: ModelPolicyMode,
  ): Promise<AdminModelPolicyResponse> {
    return database.transaction(async (transaction) => {
      const workspaceRows = await transaction
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId))
        .limit(1)
        .for("share");
      if (workspaceRows[0] === undefined) {
        throw new ModelPolicyUnavailableError("Workspace model policy is unavailable");
      }
      const revision = await assertLivePolicyMatchesHead(transaction, workspaceId);
      return selectRevisionPolicy(transaction, workspaceId, mode, revision, options.now());
    });
  }

  async function appendPolicy(
    workspaceId: string,
    mode: ModelPolicyMode,
    actor: RequestActor,
    input: AdminUpdateModelPolicyRequest,
    changeKind: "revert" | "update",
    revertedFromRevision: number | null,
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
          reasoningBudgetTokens: workspaceModelPolicies.reasoningBudgetTokens,
          reasoningEffort: workspaceModelPolicies.reasoningEffort,
          temperaturePreset: workspaceModelPolicies.temperaturePreset,
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
          reasoningMode: modelCatalog.reasoningMode,
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
          changeKind === "revert" ||
          (!previous.enabled && next.enabled) ||
          previous.modelCatalogId !== next.catalogId ||
          next.maximumOutputTokens > previous.maximumOutputTokens ||
          previous.reasoningEffort !== next.reasoningEffort ||
          previous.reasoningBudgetTokens !== next.reasoningBudgetTokens ||
          previous.temperaturePreset !== next.temperaturePreset ||
          (cost.defaultTier !== input.defaultTier && next.tier === input.defaultTier);
        const currentMetadataIsValid =
          catalog.available &&
          catalog.reasoningMode !== "unverified" &&
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
      const revision = input.observedRevision + 1;
      await transaction.insert(workspaceModelPolicyRevisions).values({
        actorDisplayName: actor.employee.name,
        actorKind: "user",
        actorUserId: actor.employee.id,
        changeKind,
        createdAt: changedAt,
        defaultTier: input.defaultTier,
        monthlyBudgetUsd,
        revertedFromRevision,
        revision,
        workspaceId,
      });
      await transaction.insert(workspaceModelPolicyRevisionTiers).values(
        input.tiers.map((tier) => ({
          enabled: tier.enabled,
          maximumOutputTokens: tier.maximumOutputTokens,
          modelCatalogId: tier.catalogId,
          reasoningBudgetTokens: tier.reasoningBudgetTokens,
          reasoningEffort: tier.reasoningEffort,
          revision,
          temperaturePreset: tier.temperaturePreset,
          tier: tier.tier,
          workspaceId,
        })),
      );
      const safeCostUpdatedAt = latestDate(changedAt, cost.createdAt, cost.updatedAt);
      const updatedCost = await transaction
        .update(workspaceCostPolicies)
        .set({
          defaultTier: input.defaultTier,
          monthlyBudgetUsd,
          revision,
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
            reasoningBudgetTokens: next.reasoningBudgetTokens,
            reasoningEffort: next.reasoningEffort,
            temperaturePreset: next.temperaturePreset,
            updatedAt: latestDate(changedAt, previous.createdAt, previous.updatedAt),
          })
          .where(
            and(
              eq(workspaceModelPolicies.workspaceId, workspaceId),
              eq(workspaceModelPolicies.tier, next.tier),
            ),
          );
      }
      return selectRevisionPolicy(transaction, workspaceId, mode, revision, changedAt);
    });
  }

  async function replaceAdminPolicy(
    workspaceId: string,
    mode: ModelPolicyMode,
    actor: RequestActor,
    input: AdminUpdateModelPolicyRequest,
  ): Promise<AdminModelPolicyResponse> {
    return appendPolicy(workspaceId, mode, actor, input, "update", null);
  }

  async function sourcePolicyInput(
    workspaceId: string,
    revision: number,
    observedRevision: number,
  ): Promise<AdminUpdateModelPolicyRequest> {
    const parentRows = await database
      .select({
        defaultTier: workspaceModelPolicyRevisions.defaultTier,
        monthlyBudgetUsd: workspaceModelPolicyRevisions.monthlyBudgetUsd,
      })
      .from(workspaceModelPolicyRevisions)
      .where(
        and(
          eq(workspaceModelPolicyRevisions.workspaceId, workspaceId),
          eq(workspaceModelPolicyRevisions.revision, revision),
        ),
      )
      .limit(1);
    const parent = parentRows[0];
    if (parent === undefined) {
      throw new ModelPolicyRevisionNotFoundError();
    }
    const rows = await database
      .select()
      .from(workspaceModelPolicyRevisionTiers)
      .where(
        and(
          eq(workspaceModelPolicyRevisionTiers.workspaceId, workspaceId),
          eq(workspaceModelPolicyRevisionTiers.revision, revision),
        ),
      );
    if (rows.length !== modelTiers.length) {
      throw new ModelPolicyUnavailableError("Source policy revision is incomplete");
    }
    return {
      defaultTier: tierFromStored(parent.defaultTier),
      monthlyBudgetUsd: canonicalUsd(parent.monthlyBudgetUsd),
      observedRevision,
      tiers: modelTiers.map((tier) => {
        const row = rows.find((candidate) => candidate.tier === tier);
        if (row === undefined) {
          throw new ModelPolicyUnavailableError("Source policy revision is incomplete");
        }
        return {
          catalogId: row.modelCatalogId,
          enabled: row.enabled,
          maximumOutputTokens: row.maximumOutputTokens,
          reasoningBudgetTokens: row.reasoningBudgetTokens as 0 | 1_024 | 2_048 | 4_096 | 8_192,
          reasoningEffort: row.reasoningEffort as "off" | "low" | "medium" | "high",
          temperaturePreset: row.temperaturePreset as
            | "precise"
            | "balanced"
            | "flexible"
            | "creative",
          tier,
        };
      }) as AdminUpdateModelPolicyRequest["tiers"],
    };
  }

  async function revertAdminPolicy(
    workspaceId: string,
    mode: ModelPolicyMode,
    actor: RequestActor,
    sourceRevision: number,
    observedRevision: number,
  ): Promise<AdminModelPolicyResponse> {
    const input = await sourcePolicyInput(workspaceId, sourceRevision, observedRevision);
    return appendPolicy(workspaceId, mode, actor, input, "revert", sourceRevision);
  }

  async function listAdminPolicyHistory(
    workspaceId: string,
    mode: ModelPolicyMode,
    cursor?: string,
  ): Promise<AdminModelPolicyHistoryResponse> {
    let beforeRevision: number | null = null;
    if (cursor !== undefined) {
      if (options.cursorCodec === undefined) {
        throw new ModelPolicyConflictError("Policy cursor support is not configured");
      }
      const payload = options.cursorCodec.decode(cursor, historyCursorKind);
      if (cursorString(payload, "workspaceId") !== workspaceId) {
        throw new ApplicationError(400, "INVALID_CURSOR", "El cursor de paginación no es válido.");
      }
      beforeRevision = cursorInteger(payload, "beforeRevision");
    }
    const rows = await database
      .select({ revision: workspaceModelPolicyRevisions.revision })
      .from(workspaceModelPolicyRevisions)
      .where(
        and(
          eq(workspaceModelPolicyRevisions.workspaceId, workspaceId),
          beforeRevision === null
            ? undefined
            : lt(workspaceModelPolicyRevisions.revision, beforeRevision),
        ),
      )
      .orderBy(desc(workspaceModelPolicyRevisions.revision))
      .limit(ADMIN_POLICY_HISTORY_PAGE_SIZE + 1);
    const visible = rows.slice(0, ADMIN_POLICY_HISTORY_PAGE_SIZE);
    const checkedAt = options.now();
    const items: AdminModelPolicyResponse[] = [];
    for (const row of visible) {
      items.push(await selectRevisionPolicy(database, workspaceId, mode, row.revision, checkedAt));
    }
    const last = visible.at(-1);
    if (
      rows.length > ADMIN_POLICY_HISTORY_PAGE_SIZE &&
      last !== undefined &&
      options.cursorCodec === undefined
    ) {
      throw new ModelPolicyConflictError("Policy cursor support is not configured");
    }
    return Object.freeze({
      items,
      nextCursor:
        rows.length <= ADMIN_POLICY_HISTORY_PAGE_SIZE || last === undefined
          ? null
          : (options.cursorCodec?.encode({
              beforeRevision: last.revision,
              kind: historyCursorKind,
              version: 1,
              workspaceId,
            }) ?? null),
    });
  }

  return Object.freeze({
    listAdminPolicyHistory,
    readAdminPolicy,
    replaceAdminPolicy,
    revertAdminPolicy,
  });
}

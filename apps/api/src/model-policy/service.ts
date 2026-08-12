import { and, eq, isNull, lte, or, sql } from "drizzle-orm";
import type { CursorCodec } from "../conversations/cursor.js";
import { conversations } from "../database/conversation-schema.js";
import type { AppDatabase, AppDatabaseExecutor, AppTransaction } from "../database/database.js";
import { workspaces } from "../database/identity-schema.js";
import {
  modelCatalog,
  openRouterPrivacyAttestations,
  workspaceCatalogApprovals,
  workspaceCostPolicies,
  workspaceModelPolicies,
} from "../database/model-policy-schema.js";
import { createModelPolicyAdministration } from "./administration.js";
import {
  type BudgetAdmission,
  type BudgetAdmissionStateRow,
  budgetAdmissionFromState,
  budgetAdmissionStateQuery,
} from "./budget-service.js";
import {
  type CatalogModelSnapshot,
  type ModelTier,
  modelTiers,
  type VerifiedPrivacyAttestation,
} from "./catalog.js";
import {
  ModelPolicyConflictError,
  ModelPolicyNotFoundError,
  ModelPolicyUnavailableError,
} from "./errors.js";
import { type GenerationPolicyRow, generationPolicyRowsQuery } from "./generation-policy-query.js";
import {
  applyReservationMarginToUnitPrice,
  applyReservationMarginToUsd,
  canonicalUnitPrice,
  canonicalUsd,
} from "./money.js";
import { costControlTuning } from "./settings.js";

export {
  CatalogRefreshActiveError,
  ModelPolicyChangedError,
  ModelPolicyConflictError,
  ModelPolicyNotFoundError,
  ModelPolicyUnavailableError,
} from "./errors.js";

export type ModelPolicyMode = "openrouter" | "simulated";

export interface TierAvailability {
  readonly available: boolean;
  readonly enabled: boolean;
  readonly tier: ModelTier;
}

export interface EmployeeTierPolicy {
  readonly defaultTier: ModelTier;
  readonly tiers: readonly TierAvailability[];
}

export interface ConversationOwner {
  readonly conversationId: string;
  readonly userId: string;
  readonly workspaceId: string;
}

export interface ResolvedTierPolicy {
  readonly completionPriceCeilingPerToken: string;
  readonly contextLength: number;
  readonly employeeActiveGenerationLimit: number;
  readonly maximumOutputTokens: number;
  readonly monthlyBudgetUsd: string;
  readonly promptPriceCeilingPerToken: string;
  readonly requestPriceCeilingUsd: string;
  readonly reservationMarginBasisPoints: number;
  readonly resolvedModel: string;
  readonly tier: ModelTier;
}

export interface ResolvedGenerationAdmission {
  readonly admission: BudgetAdmission;
  readonly policies: {
    readonly chat: ResolvedTierPolicy;
    readonly fast: ResolvedTierPolicy | null;
  };
}

export interface ModelPolicyBootstrapInput {
  readonly catalog: Readonly<Record<ModelTier, CatalogModelSnapshot>>;
  readonly employeeActiveGenerationLimit: number;
  readonly maximumOutputTokens: Readonly<Record<ModelTier, number>>;
  readonly mode: ModelPolicyMode;
  readonly monthlyBudgetUsd: string;
  readonly privacyAttestation: VerifiedPrivacyAttestation | null;
  readonly reservationMarginBasisPoints: number;
  readonly workspaceIdentity: string;
}

export interface ModelPolicyBootstrapResult {
  readonly repeated: boolean;
  readonly workspaceId: string;
}

export interface ModelPolicyAttestationResult {
  readonly repeated: boolean;
  readonly workspaceId: string;
}

export interface ModelPolicyServiceOptions {
  readonly cursorCodec?: CursorCodec;
  readonly now?: () => Date;
}

export interface CatalogRefreshClaim {
  readonly modelIds: readonly string[];
  readonly ownerId: string;
}

export interface CatalogRefreshResult {
  readonly available: number;
  readonly unavailable: number;
  readonly updated: number;
}

interface ExistingPolicyRow {
  readonly catalogApproved: boolean;
  readonly catalogAvailable: boolean;
  readonly catalogContextLength: number;
  readonly catalogMaximumOutputTokens: number;
  readonly catalogSource: "openrouter" | "simulated";
  readonly completionPricePerToken: string;
  readonly enabled: boolean;
  readonly maximumOutputTokens: number;
  readonly modelId: string;
  readonly promptPricePerToken: string;
  readonly requestPriceUsd: string;
  readonly tier: string;
}

type NullableGenerationPolicyRow = {
  readonly [Key in keyof GenerationPolicyRow]: GenerationPolicyRow[Key] | null;
};

type ResolvedGenerationAdmissionRow = BudgetAdmissionStateRow & NullableGenerationPolicyRow;

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ModelPolicyConflictError(`${label} must be a positive safe integer`);
  }
}

function assertMargin(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 1_000_000) {
    throw new ModelPolicyConflictError("Reservation margin must be an integer from 0 to 1000000");
  }
}

function latestDate(...values: readonly Date[]): Date {
  return new Date(Math.max(...values.map((value) => value.getTime())));
}

function expectedSource(mode: ModelPolicyMode): "openrouter" | "simulated" {
  return mode;
}

function resolvedPrivacyIsVerified(
  row: GenerationPolicyRow,
  mode: ModelPolicyMode,
  checkedAt: Date,
): boolean {
  if (mode === "simulated") {
    return true;
  }
  if (row.attestationVersion !== "openrouter-privacy-v1" || row.attestationVerifiedAt === null) {
    return false;
  }
  const verifiedAt =
    row.attestationVerifiedAt instanceof Date
      ? row.attestationVerifiedAt
      : new Date(row.attestationVerifiedAt);
  const ageMilliseconds = checkedAt.getTime() - verifiedAt.getTime();
  return ageMilliseconds >= 0 && ageMilliseconds <= costControlTuning.privacyAttestationLifetimeMs;
}

function toResolvedTierPolicy(
  row: GenerationPolicyRow | undefined,
  tier: ModelTier,
  mode: ModelPolicyMode,
  checkedAt: Date,
  requireEmployeeEnabled: boolean,
): ResolvedTierPolicy {
  if (
    row === undefined ||
    row.tier !== tier ||
    (requireEmployeeEnabled && !row.enabled) ||
    row.approvedCatalogId === null ||
    !row.available ||
    row.metadataSource !== expectedSource(mode) ||
    row.maximumOutputTokens > row.catalogMaximumOutputTokens ||
    !resolvedPrivacyIsVerified(row, mode, checkedAt)
  ) {
    throw new ModelPolicyUnavailableError("Requested tier is unavailable");
  }
  return Object.freeze({
    completionPriceCeilingPerToken: applyReservationMarginToUnitPrice(
      row.completionPricePerToken,
      row.reservationMarginBasisPoints,
    ),
    contextLength: row.contextLength,
    employeeActiveGenerationLimit: row.employeeActiveGenerationLimit,
    maximumOutputTokens: row.maximumOutputTokens,
    monthlyBudgetUsd: canonicalUsd(row.monthlyBudgetUsd),
    promptPriceCeilingPerToken: applyReservationMarginToUnitPrice(
      row.promptPricePerToken,
      row.reservationMarginBasisPoints,
    ),
    requestPriceCeilingUsd: applyReservationMarginToUsd(
      row.requestPriceUsd,
      row.reservationMarginBasisPoints,
    ),
    reservationMarginBasisPoints: row.reservationMarginBasisPoints,
    resolvedModel: row.resolvedModel,
    tier,
  });
}

function resolvedGenerationPoliciesFromRows(
  rows: readonly GenerationPolicyRow[],
  tier: ModelTier,
  mode: ModelPolicyMode,
  checkedAt: Date,
): ResolvedGenerationAdmission["policies"] {
  const chat = toResolvedTierPolicy(
    rows.find((row) => row.tier === tier),
    tier,
    mode,
    checkedAt,
    true,
  );
  if (tier === "fast") {
    return Object.freeze({ chat, fast: chat });
  }
  let fast: ResolvedTierPolicy | null = null;
  try {
    fast = toResolvedTierPolicy(
      rows.find((row) => row.tier === "fast"),
      "fast",
      mode,
      checkedAt,
      false,
    );
  } catch (error: unknown) {
    if (!(error instanceof ModelPolicyUnavailableError)) {
      throw error;
    }
  }
  return Object.freeze({ chat, fast });
}

function catalogMatches(row: ExistingPolicyRow, snapshot: CatalogModelSnapshot): boolean {
  return (
    row.catalogApproved &&
    row.catalogAvailable === snapshot.available &&
    row.catalogContextLength === snapshot.contextLength &&
    row.catalogMaximumOutputTokens === snapshot.maximumOutputTokens &&
    row.catalogSource === snapshot.metadataSource &&
    canonicalUnitPrice(row.completionPricePerToken) === snapshot.completionPricePerToken &&
    row.modelId === snapshot.modelId &&
    canonicalUnitPrice(row.promptPricePerToken) === snapshot.promptPricePerToken &&
    canonicalUsd(row.requestPriceUsd) === snapshot.requestPriceUsd
  );
}

async function policyRows(
  database: AppDatabaseExecutor,
  workspaceId: string,
): Promise<ExistingPolicyRow[]> {
  const rows = await database
    .select({
      catalogApproved: sql<boolean>`${workspaceCatalogApprovals.modelCatalogId} IS NOT NULL`,
      catalogAvailable: modelCatalog.available,
      catalogContextLength: modelCatalog.contextLength,
      catalogMaximumOutputTokens: modelCatalog.maximumOutputTokens,
      catalogSource: modelCatalog.metadataSource,
      completionPricePerToken: modelCatalog.completionPricePerToken,
      enabled: workspaceModelPolicies.enabled,
      maximumOutputTokens: workspaceModelPolicies.maximumOutputTokens,
      modelId: modelCatalog.openRouterModelId,
      promptPricePerToken: modelCatalog.promptPricePerToken,
      requestPriceUsd: modelCatalog.requestPriceUsd,
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
    .where(eq(workspaceModelPolicies.workspaceId, workspaceId));
  return rows.map((row) => {
    if (row.catalogSource !== "openrouter" && row.catalogSource !== "simulated") {
      throw new Error("Stored catalog source is invalid");
    }
    return { ...row, catalogSource: row.catalogSource };
  });
}

async function privacyAttestation(
  database: AppDatabaseExecutor,
  workspaceId: string,
): Promise<{ readonly verifiedAt: Date; readonly version: string } | undefined> {
  const rows = await database
    .select({
      verifiedAt: openRouterPrivacyAttestations.verifiedAt,
      version: openRouterPrivacyAttestations.attestationVersion,
    })
    .from(openRouterPrivacyAttestations)
    .where(eq(openRouterPrivacyAttestations.workspaceId, workspaceId))
    .limit(1);
  return rows[0];
}

async function privacyIsVerified(
  database: AppDatabaseExecutor,
  workspaceId: string,
  at: Date,
): Promise<boolean> {
  const attestation = await privacyAttestation(database, workspaceId);
  if (attestation?.version !== "openrouter-privacy-v1") {
    return false;
  }
  const ageMilliseconds = at.getTime() - attestation.verifiedAt.getTime();
  return ageMilliseconds >= 0 && ageMilliseconds <= costControlTuning.privacyAttestationLifetimeMs;
}

function assertFreshPrivacyAttestation(attestation: VerifiedPrivacyAttestation, at: Date): void {
  const ageMilliseconds = at.getTime() - attestation.verifiedAt.getTime();
  if (ageMilliseconds < 0) {
    throw new ModelPolicyConflictError("Privacy attestation time cannot be in the future");
  }
  if (ageMilliseconds > costControlTuning.privacyAttestationLifetimeMs) {
    throw new ModelPolicyConflictError("Privacy attestation is stale");
  }
}

async function assertRepeatMatches(
  transaction: AppTransaction,
  workspaceId: string,
  existingCostPolicy: typeof workspaceCostPolicies.$inferSelect,
  input: ModelPolicyBootstrapInput,
): Promise<void> {
  const rows = await policyRows(transaction, workspaceId);
  const attestation = await privacyAttestation(transaction, workspaceId);
  const costMatches =
    canonicalUsd(existingCostPolicy.monthlyBudgetUsd) === canonicalUsd(input.monthlyBudgetUsd) &&
    existingCostPolicy.defaultTier === "balanced" &&
    existingCostPolicy.employeeActiveGenerationLimit === input.employeeActiveGenerationLimit &&
    existingCostPolicy.reservationMarginBasisPoints === input.reservationMarginBasisPoints;
  const tierMatches = modelTiers.every((tier) => {
    const row = rows.find((candidate) => candidate.tier === tier);
    if (!row?.enabled) {
      return false;
    }
    return (
      row.maximumOutputTokens === input.maximumOutputTokens[tier] &&
      catalogMatches(row, input.catalog[tier])
    );
  });
  const privacyMatches =
    input.mode === "simulated"
      ? attestation === undefined
      : input.privacyAttestation !== null &&
        attestation !== undefined &&
        attestation.version === input.privacyAttestation.attestationVersion &&
        attestation.verifiedAt.getTime() === input.privacyAttestation.verifiedAt.getTime();

  if (!costMatches || !tierMatches || !privacyMatches || rows.length !== modelTiers.length) {
    throw new ModelPolicyConflictError(
      "Workspace model policy already exists with different effective inputs",
    );
  }
}

function validateBootstrap(input: ModelPolicyBootstrapInput, bootstrapAt: Date): void {
  canonicalUsd(input.monthlyBudgetUsd, "monthly workspace budget");
  assertPositiveInteger(input.employeeActiveGenerationLimit, "Employee generation limit");
  assertMargin(input.reservationMarginBasisPoints);
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(input.workspaceIdentity)) {
    throw new ModelPolicyConflictError("Workspace identity is invalid");
  }
  if (input.mode === "openrouter" && input.privacyAttestation === null) {
    throw new ModelPolicyConflictError("OpenRouter mode requires a privacy attestation");
  }
  if (input.mode === "simulated" && input.privacyAttestation !== null) {
    throw new ModelPolicyConflictError("Simulated mode must not record a real privacy attestation");
  }
  if (input.privacyAttestation !== null) {
    assertFreshPrivacyAttestation(input.privacyAttestation, bootstrapAt);
  }

  for (const tier of modelTiers) {
    const snapshot = input.catalog[tier];
    const outputLimit = input.maximumOutputTokens[tier];
    assertPositiveInteger(outputLimit, `${tier} maximum output tokens`);
    if (snapshot.metadataSource !== expectedSource(input.mode)) {
      throw new ModelPolicyConflictError(`${tier} catalog source does not match gateway mode`);
    }
    if (!snapshot.available || outputLimit > snapshot.maximumOutputTokens) {
      throw new ModelPolicyConflictError(`${tier} has no catalog capacity for its output limit`);
    }
    if (
      !Number.isFinite(snapshot.validatedAt.getTime()) ||
      snapshot.validatedAt.getTime() > bootstrapAt.getTime()
    ) {
      throw new ModelPolicyConflictError(`${tier} catalog validation time is invalid`);
    }
  }
}

export function createModelPolicyService(
  database: AppDatabase,
  options: ModelPolicyServiceOptions = {},
) {
  const now = options.now ?? (() => new Date());
  const administration = createModelPolicyAdministration(database, {
    ...(options.cursorCodec === undefined ? {} : { cursorCodec: options.cursorCodec }),
    now,
    privacyIsVerified,
  });

  async function assertRuntimeMode(mode: ModelPolicyMode): Promise<void> {
    const checkedAt = now();
    const costRows = await database
      .select({ workspaceId: workspaceCostPolicies.workspaceId })
      .from(workspaceCostPolicies);
    if (costRows.length === 0) {
      throw new ModelPolicyUnavailableError("Workspace model policy is not bootstrapped");
    }
    const rows = await database
      .select({
        approvedCatalogId: workspaceCatalogApprovals.modelCatalogId,
        metadataSource: modelCatalog.metadataSource,
        tier: workspaceModelPolicies.tier,
        workspaceId: workspaceModelPolicies.workspaceId,
      })
      .from(workspaceModelPolicies)
      .innerJoin(modelCatalog, eq(modelCatalog.id, workspaceModelPolicies.modelCatalogId))
      .leftJoin(
        workspaceCatalogApprovals,
        and(
          eq(workspaceCatalogApprovals.workspaceId, workspaceModelPolicies.workspaceId),
          eq(workspaceCatalogApprovals.modelCatalogId, workspaceModelPolicies.modelCatalogId),
        ),
      );

    for (const { workspaceId } of costRows) {
      const mappings = rows.filter((row) => row.workspaceId === workspaceId);
      const complete = modelTiers.every((tier) =>
        mappings.some(
          (mapping) =>
            mapping.tier === tier &&
            mapping.approvedCatalogId !== null &&
            mapping.metadataSource === expectedSource(mode),
        ),
      );
      if (
        !complete ||
        mappings.length !== modelTiers.length ||
        (mode === "openrouter" && !(await privacyIsVerified(database, workspaceId, checkedAt)))
      ) {
        throw new ModelPolicyUnavailableError(
          "Workspace model policy is incompatible with the configured gateway",
        );
      }
    }
  }

  async function bootstrapInTransaction(
    transaction: AppTransaction,
    input: ModelPolicyBootstrapInput,
  ): Promise<ModelPolicyBootstrapResult> {
    const bootstrapAt = now();
    validateBootstrap(input, bootstrapAt);
    const workspaceRows = await transaction
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.identity, input.workspaceIdentity))
      .limit(1)
      .for("update");
    const workspace = workspaceRows[0];
    if (workspace === undefined) {
      throw new ModelPolicyNotFoundError();
    }

    const existingCostRows = await transaction
      .select()
      .from(workspaceCostPolicies)
      .where(eq(workspaceCostPolicies.workspaceId, workspace.id))
      .limit(1)
      .for("update");
    const existingCostPolicy = existingCostRows[0];
    if (existingCostPolicy !== undefined) {
      await assertRepeatMatches(transaction, workspace.id, existingCostPolicy, input);
      return { repeated: true, workspaceId: workspace.id };
    }

    const catalogIds = new Map<ModelTier, string>();
    for (const tier of modelTiers) {
      const snapshot = input.catalog[tier];
      const existingCatalogRows = await transaction
        .select()
        .from(modelCatalog)
        .where(eq(modelCatalog.openRouterModelId, snapshot.modelId))
        .limit(1)
        .for("update");
      const existingCatalog = existingCatalogRows[0];
      if (existingCatalog !== undefined) {
        const comparable: ExistingPolicyRow = {
          catalogApproved: true,
          catalogAvailable: existingCatalog.available,
          catalogContextLength: existingCatalog.contextLength,
          catalogMaximumOutputTokens: existingCatalog.maximumOutputTokens,
          catalogSource: existingCatalog.metadataSource as "openrouter" | "simulated",
          completionPricePerToken: existingCatalog.completionPricePerToken,
          enabled: true,
          maximumOutputTokens: input.maximumOutputTokens[tier],
          modelId: existingCatalog.openRouterModelId,
          promptPricePerToken: existingCatalog.promptPricePerToken,
          requestPriceUsd: existingCatalog.requestPriceUsd,
          tier,
        };
        if (!catalogMatches(comparable, snapshot)) {
          throw new ModelPolicyConflictError(
            `Catalog model ${snapshot.modelId} already has different validated metadata`,
          );
        }
        catalogIds.set(tier, existingCatalog.id);
        continue;
      }

      const inserted = await transaction
        .insert(modelCatalog)
        .values({
          available: snapshot.available,
          canonicalSlug: snapshot.canonicalSlug,
          completionPricePerToken: snapshot.completionPricePerToken,
          contextLength: snapshot.contextLength,
          displayName: snapshot.displayName,
          inputModalities: snapshot.inputModalities,
          maximumOutputTokens: snapshot.maximumOutputTokens,
          metadataSource: snapshot.metadataSource,
          openRouterModelId: snapshot.modelId,
          outputModalities: snapshot.outputModalities,
          promptPricePerToken: snapshot.promptPricePerToken,
          requestPriceUsd: snapshot.requestPriceUsd,
          supportedParameters: snapshot.supportedParameters,
          createdAt: bootstrapAt,
          updatedAt: bootstrapAt,
          validatedAt: snapshot.validatedAt,
        })
        .returning({ id: modelCatalog.id });
      const catalog = inserted[0];
      if (catalog === undefined) {
        throw new Error("Catalog insert did not return a row");
      }
      catalogIds.set(tier, catalog.id);
    }

    const approvedCatalogIds = new Set<string>();
    for (const tier of modelTiers) {
      const modelCatalogId = catalogIds.get(tier);
      if (modelCatalogId === undefined) {
        throw new Error("Catalog mapping disappeared during bootstrap");
      }
      approvedCatalogIds.add(modelCatalogId);
    }
    await transaction.insert(workspaceCatalogApprovals).values(
      [...approvedCatalogIds].map((modelCatalogId) => ({
        createdAt: bootstrapAt,
        modelCatalogId,
        workspaceId: workspace.id,
      })),
    );

    await transaction.insert(workspaceCostPolicies).values({
      defaultTier: "balanced",
      employeeActiveGenerationLimit: input.employeeActiveGenerationLimit,
      monthlyBudgetUsd: canonicalUsd(input.monthlyBudgetUsd),
      reservationMarginBasisPoints: input.reservationMarginBasisPoints,
      createdAt: bootstrapAt,
      updatedAt: bootstrapAt,
      workspaceId: workspace.id,
    });

    for (const tier of modelTiers) {
      const modelCatalogId = catalogIds.get(tier);
      if (modelCatalogId === undefined) {
        throw new Error("Catalog mapping disappeared during bootstrap");
      }
      await transaction.insert(workspaceModelPolicies).values({
        enabled: true,
        maximumOutputTokens: input.maximumOutputTokens[tier],
        modelCatalogId,
        tier,
        createdAt: bootstrapAt,
        updatedAt: bootstrapAt,
        workspaceId: workspace.id,
      });
    }

    if (input.privacyAttestation !== null) {
      await transaction.insert(openRouterPrivacyAttestations).values({
        attestationVersion: input.privacyAttestation.attestationVersion,
        createdAt: bootstrapAt,
        updatedAt: bootstrapAt,
        verifiedAt: input.privacyAttestation.verifiedAt,
        workspaceId: workspace.id,
      });
    }

    return { repeated: false, workspaceId: workspace.id };
  }

  async function bootstrap(input: ModelPolicyBootstrapInput): Promise<ModelPolicyBootstrapResult> {
    return database.transaction((transaction) => bootstrapInTransaction(transaction, input));
  }

  async function attestPrivacy(
    workspaceIdentity: string,
    attestation: VerifiedPrivacyAttestation,
  ): Promise<ModelPolicyAttestationResult> {
    const attestedAt = now();
    assertFreshPrivacyAttestation(attestation, attestedAt);
    return database.transaction(async (transaction) => {
      const workspaceRows = await transaction
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(eq(workspaces.identity, workspaceIdentity))
        .limit(1)
        .for("update");
      const workspace = workspaceRows[0];
      if (workspace === undefined) {
        throw new ModelPolicyConflictError("Workspace model policy is not bootstrapped");
      }
      const costRows = await transaction
        .select({ workspaceId: workspaceCostPolicies.workspaceId })
        .from(workspaceCostPolicies)
        .where(eq(workspaceCostPolicies.workspaceId, workspace.id))
        .limit(1)
        .for("update");
      const rows = await policyRows(transaction, workspace.id);
      const completeRealPolicy =
        costRows.length === 1 &&
        rows.length === modelTiers.length &&
        modelTiers.every((tier) =>
          rows.some((row) => row.tier === tier && row.catalogSource === "openrouter"),
        );
      if (!completeRealPolicy) {
        throw new ModelPolicyConflictError(
          "Privacy attestation requires an existing OpenRouter model policy",
        );
      }
      const existingRows = await transaction
        .select()
        .from(openRouterPrivacyAttestations)
        .where(eq(openRouterPrivacyAttestations.workspaceId, workspace.id))
        .limit(1)
        .for("update");
      const existing = existingRows[0];
      if (
        existing === undefined ||
        existing.attestationVersion !== attestation.attestationVersion
      ) {
        throw new ModelPolicyConflictError("Stored privacy attestation is incompatible");
      }
      const existingTime = existing.verifiedAt.getTime();
      const nextTime = attestation.verifiedAt.getTime();
      if (nextTime === existingTime) {
        return { repeated: true, workspaceId: workspace.id };
      }
      if (nextTime < existingTime) {
        throw new ModelPolicyConflictError("Privacy attestation must move forward");
      }
      await transaction
        .update(openRouterPrivacyAttestations)
        .set({ updatedAt: attestedAt, verifiedAt: attestation.verifiedAt })
        .where(eq(openRouterPrivacyAttestations.workspaceId, workspace.id));
      return { repeated: false, workspaceId: workspace.id };
    });
  }

  async function readEmployeeTierPolicy(
    workspaceId: string,
    mode: ModelPolicyMode,
  ): Promise<EmployeeTierPolicy> {
    const checkedAt = now();
    const [costRows, rows, attested] = await Promise.all([
      database
        .select({ defaultTier: workspaceCostPolicies.defaultTier })
        .from(workspaceCostPolicies)
        .where(eq(workspaceCostPolicies.workspaceId, workspaceId))
        .limit(1),
      policyRows(database, workspaceId),
      privacyIsVerified(database, workspaceId, checkedAt),
    ]);
    const defaultTier = costRows[0]?.defaultTier;
    const bootstrapped = modelTiers.some((tier) => tier === defaultTier);
    return {
      defaultTier: bootstrapped ? (defaultTier as ModelTier) : "balanced",
      tiers: modelTiers.map((tier) => {
        const row = rows.find((candidate) => candidate.tier === tier);
        const enabled = bootstrapped && row?.enabled === true;
        return {
          available:
            enabled &&
            row.catalogApproved &&
            row.catalogAvailable &&
            row.catalogSource === expectedSource(mode) &&
            row.maximumOutputTokens <= row.catalogMaximumOutputTokens &&
            (mode === "simulated" || attested),
          enabled,
          tier,
        };
      }),
    };
  }

  async function claimCatalogRefresh(
    ownerId: string,
    at = new Date(),
    force = false,
  ): Promise<CatalogRefreshClaim> {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(ownerId)
    ) {
      throw new ModelPolicyConflictError("Catalog refresh owner must be a UUID");
    }
    const refreshDueAt = new Date(at.getTime() - costControlTuning.catalogRefreshIntervalMs);
    return database.transaction(async (transaction) => {
      const rows = await transaction
        .select({ id: modelCatalog.id, modelId: modelCatalog.openRouterModelId })
        .from(modelCatalog)
        .where(
          and(
            eq(modelCatalog.metadataSource, "openrouter"),
            sql<boolean>`EXISTS (
              SELECT 1
              FROM ${workspaceCatalogApprovals}
              WHERE ${workspaceCatalogApprovals.modelCatalogId} = ${modelCatalog.id}
            )`,
            or(
              isNull(modelCatalog.refreshLeaseExpiresAt),
              lte(modelCatalog.refreshLeaseExpiresAt, at),
            ),
            force
              ? undefined
              : lte(
                  sql<Date>`coalesce(${modelCatalog.refreshAttemptedAt}, ${modelCatalog.validatedAt})`,
                  refreshDueAt,
                ),
          ),
        )
        .limit(costControlTuning.catalogAdministrationBatchSize)
        .for("update", { skipLocked: true });
      const leaseExpiresAt = new Date(at.getTime() + costControlTuning.catalogRefreshLeaseMs);
      for (const row of rows) {
        await transaction
          .update(modelCatalog)
          .set({ refreshLeaseExpiresAt: leaseExpiresAt, refreshLeaseOwner: ownerId })
          .where(eq(modelCatalog.id, row.id));
      }
      return Object.freeze({ modelIds: rows.map(({ modelId }) => modelId), ownerId });
    });
  }

  async function completeCatalogRefresh(
    claim: CatalogRefreshClaim,
    snapshots: readonly CatalogModelSnapshot[],
    attemptedAt = new Date(),
  ): Promise<CatalogRefreshResult> {
    const snapshotByModel = new Map(snapshots.map((snapshot) => [snapshot.modelId, snapshot]));
    return database.transaction(async (transaction) => {
      const claimed = await transaction
        .select()
        .from(modelCatalog)
        .where(eq(modelCatalog.refreshLeaseOwner, claim.ownerId))
        .for("update");
      let available = 0;
      let unavailable = 0;
      for (const row of claimed) {
        if (!claim.modelIds.includes(row.openRouterModelId)) {
          continue;
        }
        const snapshot = snapshotByModel.get(row.openRouterModelId);
        if (snapshot === undefined) {
          const safeAttemptedAt = latestDate(attemptedAt, row.createdAt, row.validatedAt);
          await transaction
            .update(modelCatalog)
            .set({
              available: false,
              refreshAttemptedAt: safeAttemptedAt,
              refreshLeaseExpiresAt: null,
              refreshLeaseOwner: null,
              updatedAt: safeAttemptedAt,
            })
            .where(eq(modelCatalog.id, row.id));
          unavailable += 1;
          continue;
        }
        if (snapshot.metadataSource !== "openrouter") {
          throw new ModelPolicyConflictError(
            "Real catalog refresh cannot apply simulated metadata",
          );
        }
        const safeAttemptedAt = latestDate(attemptedAt, row.createdAt, snapshot.validatedAt);
        await transaction
          .update(modelCatalog)
          .set({
            available: snapshot.available,
            canonicalSlug: snapshot.canonicalSlug,
            completionPricePerToken: snapshot.completionPricePerToken,
            contextLength: snapshot.contextLength,
            displayName: snapshot.displayName,
            inputModalities: snapshot.inputModalities,
            maximumOutputTokens: snapshot.maximumOutputTokens,
            outputModalities: snapshot.outputModalities,
            promptPricePerToken: snapshot.promptPricePerToken,
            refreshAttemptedAt: safeAttemptedAt,
            refreshLeaseExpiresAt: null,
            refreshLeaseOwner: null,
            requestPriceUsd: snapshot.requestPriceUsd,
            supportedParameters: snapshot.supportedParameters,
            updatedAt: safeAttemptedAt,
            validatedAt: snapshot.validatedAt,
          })
          .where(eq(modelCatalog.id, row.id));
        available += snapshot.available ? 1 : 0;
        unavailable += snapshot.available ? 0 : 1;
      }
      return Object.freeze({ available, unavailable, updated: available + unavailable });
    });
  }

  async function releaseCatalogRefresh(
    claim: CatalogRefreshClaim,
    attemptedAt = new Date(),
  ): Promise<number> {
    const updated = await database
      .update(modelCatalog)
      .set({
        refreshAttemptedAt: sql`greatest(${attemptedAt}, ${modelCatalog.createdAt}, ${modelCatalog.validatedAt})`,
        refreshLeaseExpiresAt: null,
        refreshLeaseOwner: null,
        updatedAt: sql`greatest(${attemptedAt}, ${modelCatalog.createdAt}, ${modelCatalog.validatedAt})`,
      })
      .where(eq(modelCatalog.refreshLeaseOwner, claim.ownerId))
      .returning({ id: modelCatalog.id });
    return updated.length;
  }

  async function resolvedTierRows(
    executor: AppDatabaseExecutor,
    workspaceId: string,
    tiers: readonly ModelTier[],
  ): Promise<readonly GenerationPolicyRow[]> {
    const result = await executor.execute<GenerationPolicyRow>(
      generationPolicyRowsQuery(workspaceId, tiers, { lockRows: true }),
    );
    return result.rows;
  }

  async function resolveTierPolicy(
    executor: AppDatabaseExecutor,
    workspaceId: string,
    tier: ModelTier,
    mode: ModelPolicyMode,
    requireEmployeeEnabled: boolean,
  ): Promise<ResolvedTierPolicy> {
    const checkedAt = now();
    const rows = await resolvedTierRows(executor, workspaceId, [tier]);
    return toResolvedTierPolicy(rows[0], tier, mode, checkedAt, requireEmployeeEnabled);
  }

  async function resolveGenerationPolicies(
    executor: AppDatabaseExecutor,
    workspaceId: string,
    tier: ModelTier,
    mode: ModelPolicyMode,
  ): Promise<{ readonly chat: ResolvedTierPolicy; readonly fast: ResolvedTierPolicy | null }> {
    const checkedAt = now();
    const requestedTiers = tier === "fast" ? (["fast"] as const) : ([tier, "fast"] as const);
    const rows = await resolvedTierRows(executor, workspaceId, requestedTiers);
    return resolvedGenerationPoliciesFromRows(rows, tier, mode, checkedAt);
  }

  function resolveGenerationPolicyRows(
    rows: readonly GenerationPolicyRow[],
    tier: ModelTier,
    mode: ModelPolicyMode,
  ): ResolvedGenerationAdmission["policies"] {
    return resolvedGenerationPoliciesFromRows(rows, tier, mode, now());
  }

  async function resolveGenerationAdmission(
    transaction: AppTransaction,
    workspaceId: string,
    userId: string,
    at: Date,
    tier: ModelTier,
    mode: ModelPolicyMode,
  ): Promise<ResolvedGenerationAdmission> {
    const requestedTiers = tier === "fast" ? (["fast"] as const) : ([tier, "fast"] as const);
    const rows = await transaction.execute<ResolvedGenerationAdmissionRow>(sql`
      WITH admission_state AS MATERIALIZED (
        ${budgetAdmissionStateQuery(workspaceId, userId, at)}
      ),
      resolved_tiers AS MATERIALIZED (
        ${generationPolicyRowsQuery(workspaceId, requestedTiers, { lockRows: true })}
      )
      SELECT
        admission_state."activeGenerationCount",
        admission_state."consumedUsd",
        admission_state."periodEnd",
        admission_state."periodStart",
        resolved_tiers."approvedCatalogId",
        resolved_tiers."attestationVerifiedAt",
        resolved_tiers."attestationVersion",
        resolved_tiers.available,
        resolved_tiers."catalogMaximumOutputTokens",
        resolved_tiers."completionPricePerToken",
        resolved_tiers."contextLength",
        resolved_tiers."employeeActiveGenerationLimit",
        resolved_tiers.enabled,
        resolved_tiers."maximumOutputTokens",
        resolved_tiers."metadataSource",
        resolved_tiers."monthlyBudgetUsd",
        resolved_tiers."promptPricePerToken",
        resolved_tiers."requestPriceUsd",
        resolved_tiers."reservationMarginBasisPoints",
        resolved_tiers."resolvedModel",
        resolved_tiers.tier
      FROM admission_state
      LEFT JOIN resolved_tiers ON true
    `);
    const first = rows.rows[0];
    if (first === undefined) {
      throw new Error("Generation admission returned no row");
    }
    const policyRows = rows.rows.flatMap((row): readonly GenerationPolicyRow[] =>
      row.tier === null ? [] : [row as unknown as GenerationPolicyRow],
    );
    const admission = budgetAdmissionFromState(first, workspaceId, userId);
    const policies = resolveGenerationPolicyRows(policyRows, tier, mode);
    return Object.freeze({ admission, policies });
  }

  async function resolveTier(
    executor: AppDatabaseExecutor,
    workspaceId: string,
    tier: ModelTier,
    mode: ModelPolicyMode,
  ): Promise<ResolvedTierPolicy> {
    return resolveTierPolicy(executor, workspaceId, tier, mode, true);
  }

  async function resolveCompactionTier(
    executor: AppDatabaseExecutor,
    workspaceId: string,
    mode: ModelPolicyMode,
  ): Promise<ResolvedTierPolicy> {
    return resolveTierPolicy(executor, workspaceId, "fast", mode, false);
  }

  async function getPreferredTier(owner: ConversationOwner): Promise<ModelTier | null> {
    const rows = await database
      .select({ tier: conversations.preferredTier })
      .from(conversations)
      .where(
        and(
          eq(conversations.id, owner.conversationId),
          eq(conversations.userId, owner.userId),
          eq(conversations.workspaceId, owner.workspaceId),
        ),
      )
      .limit(1);
    const tier = rows[0]?.tier;
    return tier !== undefined && modelTiers.some((candidate) => candidate === tier)
      ? (tier as ModelTier)
      : null;
  }

  async function setPreferredTier(
    owner: ConversationOwner,
    tier: ModelTier,
    mode: ModelPolicyMode,
  ): Promise<ModelTier> {
    return database.transaction(async (transaction) => {
      const ownedRows = await transaction
        .select({ id: conversations.id })
        .from(conversations)
        .where(
          and(
            eq(conversations.id, owner.conversationId),
            eq(conversations.userId, owner.userId),
            eq(conversations.workspaceId, owner.workspaceId),
          ),
        )
        .limit(1)
        .for("update");
      if (ownedRows[0] === undefined) {
        throw new ModelPolicyNotFoundError();
      }

      await resolveTier(transaction, owner.workspaceId, tier, mode);
      await transaction
        .update(conversations)
        .set({ preferredTier: tier })
        .where(eq(conversations.id, owner.conversationId));
      return tier;
    });
  }

  return Object.freeze({
    ...administration,
    assertRuntimeMode,
    attestPrivacy,
    bootstrap,
    bootstrapInTransaction,
    claimCatalogRefresh,
    completeCatalogRefresh,
    getPreferredTier,
    readEmployeeTierPolicy,
    releaseCatalogRefresh,
    resolveCompactionTier,
    resolveGenerationAdmission,
    resolveGenerationPolicyRows,
    resolveGenerationPolicies,
    resolveTier,
    setPreferredTier,
  });
}

export type ModelPolicyService = ReturnType<typeof createModelPolicyService>;

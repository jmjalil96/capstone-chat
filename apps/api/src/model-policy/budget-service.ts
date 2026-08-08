import { and, asc, count, eq, gt, lte, or, sql } from "drizzle-orm";
import { conversations } from "../database/conversation-schema.js";
import type { AppDatabase, AppTransaction } from "../database/database.js";
import { generations } from "../database/generation-schema.js";
import { workspaceMemberships, workspaces } from "../database/identity-schema.js";
import {
  type WorkspaceBudgetPeriod,
  workspaceBudgetConsumptionUsd,
  workspaceBudgetPeriod,
} from "./budget-period.js";
import {
  addUsd,
  calculateReservationUsd,
  canonicalTokenCount,
  canonicalUsd,
  compareDecimal,
} from "./money.js";
import type { ResolvedTierPolicy } from "./service.js";
import { costControlTuning } from "./settings.js";

export class WorkspaceBudgetExceededError extends Error {
  constructor() {
    super("Workspace budget is exhausted");
    this.name = "WorkspaceBudgetExceededError";
  }
}

export class EmployeeGenerationLimitError extends Error {
  constructor() {
    super("Employee generation concurrency limit is reached");
    this.name = "EmployeeGenerationLimitError";
  }
}

export class BudgetAdmissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BudgetAdmissionError";
  }
}

export class ContextBudgetExceededError extends Error {
  constructor() {
    super("Authoritative context exceeds the selected tier limit");
    this.name = "ContextBudgetExceededError";
  }
}

export interface BudgetAdmission {
  readonly activeGenerationCount: number;
  readonly consumedUsd: string;
  readonly period: WorkspaceBudgetPeriod;
  readonly userId: string;
  readonly workspaceId: string;
}

export interface GenerationReservationSnapshot {
  readonly accountingStatus: "reserved";
  readonly budgetPeriodEnd: Date;
  readonly budgetPeriodStart: Date;
  readonly completionPriceCeilingPerToken: string;
  readonly estimatedInputTokens: bigint;
  readonly maximumOutputTokens: number;
  readonly promptPriceCeilingPerToken: string;
  readonly requestPriceCeilingUsd: string;
  readonly reservationExpiresAt: Date;
  readonly reservationMarginBasisPoints: number;
  readonly reservedCostUsd: string;
}

export interface AuthoritativeGenerationUsage {
  readonly cachedTokens?: bigint | number | string | null | undefined;
  readonly completionTokens: bigint | number | string;
  readonly costUsd: string;
  readonly openRouterGenerationId?: string | null | undefined;
  readonly promptTokens: bigint | number | string;
  readonly provider?: string | null | undefined;
  readonly reasoningTokens?: bigint | number | string | null | undefined;
}

export interface ReconciliationResult {
  readonly inspected: number;
  readonly settled: number;
  readonly terminalized: number;
}

function safeDate(...values: readonly (Date | string | null)[]): Date {
  const timestamp = Math.max(
    ...values
      .filter((value): value is Date | string => value !== null)
      .map((value) => (value instanceof Date ? value : new Date(value)).getTime()),
  );
  return new Date(timestamp);
}

function optionalTokenCount(value: bigint | number | string | null | undefined): bigint | null {
  return value === null || value === undefined ? null : canonicalTokenCount(value);
}

function optionalNonempty(value: string | null | undefined, label: string): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 512) {
    throw new BudgetAdmissionError(`${label} is invalid`);
  }
  return trimmed;
}

export function createBudgetService(database: AppDatabase) {
  async function lockAdmission(
    transaction: AppTransaction,
    workspaceId: string,
    userId: string,
    at: Date,
  ): Promise<BudgetAdmission> {
    const workspaceRows = await transaction
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .limit(1)
      .for("update");
    if (workspaceRows[0] === undefined) {
      throw new BudgetAdmissionError("Workspace is unavailable");
    }

    const membershipRows = await transaction
      .select({ id: workspaceMemberships.id })
      .from(workspaceMemberships)
      .where(
        and(
          eq(workspaceMemberships.workspaceId, workspaceId),
          eq(workspaceMemberships.userId, userId),
          eq(workspaceMemberships.status, "active"),
        ),
      )
      .limit(1)
      .for("update");
    if (membershipRows[0] === undefined) {
      throw new BudgetAdmissionError("Active workspace membership is unavailable");
    }

    const period = await workspaceBudgetPeriod(transaction, workspaceId, at);
    if (period === null) {
      throw new BudgetAdmissionError("Workspace budget period is unavailable");
    }
    const activeRows = await transaction
      .select({ value: count() })
      .from(generations)
      .where(
        and(
          eq(generations.workspaceId, workspaceId),
          eq(generations.userId, userId),
          eq(generations.status, "active"),
        ),
      );
    const consumedUsd = await workspaceBudgetConsumptionUsd(transaction, workspaceId, period);

    return Object.freeze({
      activeGenerationCount: activeRows[0]?.value ?? 0,
      consumedUsd,
      period,
      userId,
      workspaceId,
    });
  }

  function reserveResolvedTier(
    admission: BudgetAdmission,
    policy: ResolvedTierPolicy,
    estimatedInputTokensValue: bigint,
    startedAt: Date,
  ): GenerationReservationSnapshot {
    const estimatedInputTokens = canonicalTokenCount(
      estimatedInputTokensValue,
      "estimated input tokens",
    );
    if (estimatedInputTokens + BigInt(policy.maximumOutputTokens) > BigInt(policy.contextLength)) {
      throw new ContextBudgetExceededError();
    }
    if (admission.activeGenerationCount >= policy.employeeActiveGenerationLimit) {
      throw new EmployeeGenerationLimitError();
    }

    const reservedCostUsd = calculateReservationUsd({
      completionPriceCeilingPerToken: policy.completionPriceCeilingPerToken,
      estimatedInputTokens,
      maximumOutputTokens: policy.maximumOutputTokens,
      promptPriceCeilingPerToken: policy.promptPriceCeilingPerToken,
      requestPriceCeilingUsd: policy.requestPriceCeilingUsd,
    });
    const afterReservation = addUsd([admission.consumedUsd, reservedCostUsd]);
    if (compareDecimal(afterReservation, policy.monthlyBudgetUsd) > 0) {
      throw new WorkspaceBudgetExceededError();
    }

    return Object.freeze({
      accountingStatus: "reserved",
      budgetPeriodEnd: admission.period.end,
      budgetPeriodStart: admission.period.start,
      completionPriceCeilingPerToken: policy.completionPriceCeilingPerToken,
      estimatedInputTokens,
      maximumOutputTokens: policy.maximumOutputTokens,
      promptPriceCeilingPerToken: policy.promptPriceCeilingPerToken,
      requestPriceCeilingUsd: policy.requestPriceCeilingUsd,
      reservationExpiresAt: new Date(startedAt.getTime() + costControlTuning.reservationExpiryMs),
      reservationMarginBasisPoints: policy.reservationMarginBasisPoints,
      reservedCostUsd,
    });
  }

  async function settleAuthoritativeUsage(
    generationId: string,
    usage: AuthoritativeGenerationUsage,
    settledAt = new Date(),
  ): Promise<boolean> {
    const locationRows = await database
      .select({ conversationId: generations.conversationId })
      .from(generations)
      .where(eq(generations.id, generationId))
      .limit(1);
    const location = locationRows[0];
    if (location === undefined) {
      return false;
    }

    return database.transaction(async (transaction) => {
      if (location.conversationId !== null) {
        await transaction
          .select({ id: conversations.id })
          .from(conversations)
          .where(eq(conversations.id, location.conversationId))
          .limit(1)
          .for("update");
      }
      return settleAuthoritativeUsageInTransaction(transaction, generationId, usage, settledAt);
    });
  }

  async function settleAuthoritativeUsageInTransaction(
    transaction: AppTransaction,
    generationId: string,
    usage: AuthoritativeGenerationUsage,
    settledAt = new Date(),
  ): Promise<boolean> {
    const costUsd = canonicalUsd(usage.costUsd, "authoritative billed cost");
    const promptTokens = canonicalTokenCount(usage.promptTokens, "prompt tokens");
    const completionTokens = canonicalTokenCount(usage.completionTokens, "completion tokens");
    const reasoningTokens = optionalTokenCount(usage.reasoningTokens);
    const cachedTokens = optionalTokenCount(usage.cachedTokens);
    const providedProvider = optionalNonempty(usage.provider, "provider");
    const providedOpenRouterGenerationId = optionalNonempty(
      usage.openRouterGenerationId,
      "OpenRouter generation ID",
    );
    const generationRows = await transaction
      .select()
      .from(generations)
      .where(eq(generations.id, generationId))
      .limit(1)
      .for("update");
    const generation = generationRows[0];
    if (generation === undefined || generation.accountingStatus !== "reserved") {
      return false;
    }
    const safeSettledAt = safeDate(
      settledAt,
      generation.startedAt,
      generation.createdAt,
      generation.updatedAt,
    );
    const updated = await transaction
      .update(generations)
      .set({
        accountingSettledAt: safeSettledAt,
        accountingStatus: "actual",
        cachedTokens,
        completionTokens,
        costBasis: "actual",
        costUsd,
        openRouterGenerationId: providedOpenRouterGenerationId ?? generation.openRouterGenerationId,
        promptTokens,
        provider: providedProvider ?? generation.provider,
        reasoningTokens,
        updatedAt: safeSettledAt,
      })
      .where(and(eq(generations.id, generationId), eq(generations.accountingStatus, "reserved")))
      .returning({ id: generations.id });
    return updated.length === 1;
  }

  async function settleDeterministicZero(
    generationId: string,
    settledAt = new Date(),
  ): Promise<boolean> {
    return settleAuthoritativeUsage(
      generationId,
      { completionTokens: 0n, costUsd: "0", promptTokens: 0n },
      settledAt,
    );
  }

  async function reconcileExpiredOnce(
    at = new Date(),
    batchSize: number = costControlTuning.reconciliationBatchSize,
  ): Promise<ReconciliationResult> {
    if (!Number.isSafeInteger(batchSize) || batchSize <= 0 || batchSize > 100) {
      throw new BudgetAdmissionError("Reconciliation batch size must be from 1 to 100");
    }
    let cursor: { readonly id: string; readonly reservationExpiresAt: Date } | null = null;
    let inspected = 0;
    let settled = 0;
    let terminalized = 0;

    while (settled < batchSize) {
      const candidates = await database
        .select({
          conversationId: generations.conversationId,
          id: generations.id,
          reservationExpiresAt: generations.reservationExpiresAt,
        })
        .from(generations)
        .where(
          and(
            eq(generations.accountingStatus, "reserved"),
            lte(generations.reservationExpiresAt, at),
            cursor === null
              ? undefined
              : or(
                  gt(generations.reservationExpiresAt, cursor.reservationExpiresAt),
                  and(
                    eq(generations.reservationExpiresAt, cursor.reservationExpiresAt),
                    gt(generations.id, cursor.id),
                  ),
                ),
          ),
        )
        .orderBy(asc(generations.reservationExpiresAt), asc(generations.id))
        .limit(batchSize - settled);
      if (candidates.length === 0) {
        break;
      }

      for (const candidate of candidates) {
        if (candidate.reservationExpiresAt === null) {
          throw new BudgetAdmissionError("Reserved generation expiry is unavailable");
        }
        cursor = { id: candidate.id, reservationExpiresAt: candidate.reservationExpiresAt };
        inspected += 1;

        const result = await database.transaction(async (transaction) => {
          if (candidate.conversationId !== null) {
            const conversationRows = await transaction
              .select({ id: conversations.id })
              .from(conversations)
              .where(eq(conversations.id, candidate.conversationId))
              .limit(1)
              .for("update", { skipLocked: true });
            if (conversationRows[0] === undefined) {
              return { settled: false, terminalized: false };
            }
          }
          const generationRows = await transaction
            .select()
            .from(generations)
            .where(
              and(
                eq(generations.id, candidate.id),
                eq(generations.accountingStatus, "reserved"),
                lte(generations.reservationExpiresAt, at),
              ),
            )
            .limit(1)
            .for("update", { skipLocked: true });
          const generation = generationRows[0];
          if (generation === undefined || generation.reservedCostUsd === null) {
            return { settled: false, terminalized: false };
          }

          const safeSettledAt = safeDate(
            at,
            generation.startedAt,
            generation.createdAt,
            generation.updatedAt,
          );
          const isActive = generation.status === "active";
          await transaction
            .update(generations)
            .set({
              accountingSettledAt: safeSettledAt,
              accountingStatus: "estimated",
              completedAt: isActive ? safeSettledAt : generation.completedAt,
              costBasis: "estimated",
              costUsd: generation.reservedCostUsd,
              errorCode: isActive ? "STREAM_INTERRUPTED" : generation.errorCode,
              status: isActive ? "incomplete" : generation.status,
              terminalReason: isActive ? "error" : generation.terminalReason,
              updatedAt: safeSettledAt,
            })
            .where(
              and(eq(generations.id, generation.id), eq(generations.accountingStatus, "reserved")),
            );

          if (isActive && generation.conversationId !== null) {
            await transaction
              .update(conversations)
              .set({
                revision: sql`${conversations.revision} + 1`,
                updatedAt: safeSettledAt,
              })
              .where(eq(conversations.id, generation.conversationId));
          }
          return { settled: true, terminalized: isActive };
        });
        settled += result.settled ? 1 : 0;
        terminalized += result.terminalized ? 1 : 0;
      }
    }

    return Object.freeze({ inspected, settled, terminalized });
  }

  return Object.freeze({
    lockAdmission,
    reconcileExpiredOnce,
    reserveResolvedTier,
    settleAuthoritativeUsage,
    settleAuthoritativeUsageInTransaction,
    settleDeterministicZero,
  });
}

export type BudgetService = ReturnType<typeof createBudgetService>;

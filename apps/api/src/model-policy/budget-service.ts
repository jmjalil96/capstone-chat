import { and, asc, eq, gt, lte, or, type SQL, sql } from "drizzle-orm";
import { conversationCompactions } from "../database/compaction-schema.js";
import { conversations } from "../database/conversation-schema.js";
import { type AppDatabase, type AppTransaction, executePrepared } from "../database/database.js";
import { generations } from "../database/generation-schema.js";
import type { ApplicationTelemetry } from "../observability/telemetry-contract.js";
import type { WorkspaceBudgetPeriod } from "./budget-period.js";
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

interface AdmissionAuthorityRow extends Record<string, unknown> {
  readonly membershipFound: boolean;
  readonly workspaceFound: boolean;
}

export interface BudgetAdmissionStateRow extends Record<string, unknown> {
  readonly activeGenerationCount: number | string;
  readonly consumedUsd: string;
  readonly periodEnd: Date | string | null;
  readonly periodStart: Date | string | null;
}

export function budgetAdmissionStateQuery(
  workspaceId: string,
  userId: string,
  at: Date,
): SQL<BudgetAdmissionStateRow> {
  return sql<BudgetAdmissionStateRow>`
    WITH budget_period AS MATERIALIZED (
      SELECT
        date_trunc('month', ${at}::timestamptz AT TIME ZONE workspace.timezone)
          AT TIME ZONE workspace.timezone AS period_start,
        (date_trunc('month', ${at}::timestamptz AT TIME ZONE workspace.timezone)
          + interval '1 month') AT TIME ZONE workspace.timezone AS period_end
      FROM workspaces AS workspace
      WHERE workspace.id = ${workspaceId}::uuid
    )
    SELECT
      period.period_start AS "periodStart",
      period.period_end AS "periodEnd",
      (
        SELECT COUNT(*)::integer
        FROM generations AS active_generation
        WHERE active_generation.workspace_id = ${workspaceId}::uuid
          AND active_generation.user_id = ${userId}
          AND active_generation.status IN ('preparing', 'active')
          AND active_generation.conversation_id IS NOT NULL
          AND active_generation.assistant_message_id IS NOT NULL
          AND (active_generation.purpose IS NULL OR active_generation.purpose = 'chat')
      ) AS "activeGenerationCount",
      (
        SELECT COALESCE(SUM(
          CASE
            WHEN period_generation.accounting_status = 'reserved'
              THEN period_generation.reserved_cost_usd
            ELSE period_generation.cost_usd
          END
        ), 0::numeric)::text
        FROM generations AS period_generation
        WHERE period_generation.workspace_id = ${workspaceId}::uuid
          AND period_generation.budget_period_start = period.period_start
          AND period_generation.budget_period_end = period.period_end
          AND period_generation.accounting_status IN ('reserved', 'actual', 'estimated')
      ) AS "consumedUsd"
    FROM budget_period AS period
  `;
}

export function budgetAdmissionFromState(
  row: BudgetAdmissionStateRow | undefined,
  workspaceId: string,
  userId: string,
): BudgetAdmission {
  if (row === undefined || row.periodStart === null || row.periodEnd === null) {
    throw new BudgetAdmissionError("Workspace budget period is unavailable");
  }
  const activeGenerationCount = Number(row.activeGenerationCount);
  if (!Number.isSafeInteger(activeGenerationCount) || activeGenerationCount < 0) {
    throw new BudgetAdmissionError("Active generation count is unavailable");
  }
  const period = Object.freeze({
    end: row.periodEnd instanceof Date ? row.periodEnd : new Date(row.periodEnd),
    start: row.periodStart instanceof Date ? row.periodStart : new Date(row.periodStart),
  });

  return Object.freeze({
    activeGenerationCount,
    consumedUsd: canonicalUsd(row.consumedUsd, "workspace consumption"),
    period,
    userId,
    workspaceId,
  });
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

export interface BudgetServiceOptions {
  readonly telemetry?:
    | Pick<
        ApplicationTelemetry,
        "recordBudgetRejection" | "recordReconciliation" | "recordReservationSettlement"
      >
    | undefined;
}

export function createBudgetService(database: AppDatabase, options: BudgetServiceOptions = {}) {
  function observe(action: () => void): void {
    try {
      action();
    } catch {
      // Telemetry cannot affect budget authority or settlement.
    }
  }

  async function lockAdmissionAuthority(
    transaction: AppTransaction,
    workspaceId: string,
    userId: string,
  ): Promise<void> {
    // Keep the established workspace -> membership lock order. State must be read by a later
    // statement because a READ COMMITTED statement retains the snapshot from before a lock wait.
    const authorityResult = await executePrepared<AdmissionAuthorityRow>(
      transaction,
      "generation-admission-authority-v1",
      sql`
      WITH locked_workspace AS MATERIALIZED (
        SELECT workspace.id, workspace.timezone
        FROM workspaces AS workspace
        WHERE workspace.id = ${workspaceId}::uuid
        FOR UPDATE OF workspace
      ),
      locked_membership AS MATERIALIZED (
        SELECT membership.id
        FROM workspace_memberships AS membership
        INNER JOIN locked_workspace AS workspace
          ON workspace.id = membership.workspace_id
        WHERE membership.user_id = ${userId}
          AND membership.status = 'active'
        FOR UPDATE OF membership
      )
      SELECT
        EXISTS (SELECT 1 FROM locked_workspace) AS "workspaceFound",
        EXISTS (SELECT 1 FROM locked_membership) AS "membershipFound"
      `,
    );
    const authority = authorityResult.rows[0];
    if (authority === undefined || !authority.workspaceFound) {
      throw new BudgetAdmissionError("Workspace is unavailable");
    }
    if (!authority.membershipFound) {
      throw new BudgetAdmissionError("Active workspace membership is unavailable");
    }
  }

  async function lockAdmission(
    transaction: AppTransaction,
    workspaceId: string,
    userId: string,
    at: Date,
  ): Promise<BudgetAdmission> {
    await lockAdmissionAuthority(transaction, workspaceId, userId);
    const stateResult = await transaction.execute<BudgetAdmissionStateRow>(
      budgetAdmissionStateQuery(workspaceId, userId, at),
    );
    return budgetAdmissionFromState(stateResult.rows[0], workspaceId, userId);
  }

  function reserveResolvedTier(
    admission: BudgetAdmission,
    policy: ResolvedTierPolicy,
    estimatedInputTokensValue: bigint,
    startedAt: Date,
    enforceEmployeeLimit = true,
  ): GenerationReservationSnapshot {
    const estimatedInputTokens = canonicalTokenCount(
      estimatedInputTokensValue,
      "estimated input tokens",
    );
    if (estimatedInputTokens + BigInt(policy.maximumOutputTokens) > BigInt(policy.contextLength)) {
      throw new ContextBudgetExceededError();
    }
    if (
      enforceEmployeeLimit &&
      admission.activeGenerationCount >= policy.employeeActiveGenerationLimit
    ) {
      observe(() => options.telemetry?.recordBudgetRejection(policy.tier, "chat"));
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
      observe(() =>
        options.telemetry?.recordBudgetRejection(
          policy.tier,
          enforceEmployeeLimit ? "chat" : "compaction",
        ),
      );
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

    const settled = await database.transaction(async (transaction) => {
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
    if (settled) {
      observe(() => options.telemetry?.recordReservationSettlement("actual"));
    }
    return settled;
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
    let oldestDueLagMs = 0;
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
        oldestDueLagMs = Math.max(
          oldestDueLagMs,
          at.getTime() - candidate.reservationExpiresAt.getTime(),
        );

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
          const isActive = generation.status === "active" || generation.status === "preparing";
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

          if (isActive && generation.purpose === "compaction") {
            await transaction
              .update(conversationCompactions)
              .set({
                completedAt: safeSettledAt,
                status: "incomplete",
                updatedAt: safeSettledAt,
              })
              .where(
                and(
                  eq(conversationCompactions.generationId, generation.id),
                  eq(conversationCompactions.status, "active"),
                ),
              );
          } else if (isActive && generation.conversationId !== null) {
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
        if (result.settled) {
          observe(() => options.telemetry?.recordReservationSettlement("expired"));
        }
      }
    }

    observe(() =>
      options.telemetry?.recordReconciliation({
        claimed: inspected,
        errors: 0,
        oldestDueLagMs,
        settled,
      }),
    );
    return Object.freeze({ inspected, settled, terminalized });
  }

  return Object.freeze({
    lockAdmission,
    lockAdmissionAuthority,
    reconcileExpiredOnce,
    reserveResolvedTier,
    settleAuthoritativeUsage,
    settleAuthoritativeUsageInTransaction,
    settleDeterministicZero,
  });
}

export type BudgetService = ReturnType<typeof createBudgetService>;

import { and, eq, inArray } from "drizzle-orm";
import { conversationCompactions } from "../database/compaction-schema.js";
import type { AppTransaction } from "../database/database.js";
import { generations, nonterminalGenerationStatuses } from "../database/generation-schema.js";
import type { BudgetService } from "../model-policy/budget-service.js";

export interface NonterminalGenerationRow {
  readonly accountingStatus: string | null;
  readonly createdAt: Date;
  readonly firstTokenAt: Date | null;
  readonly id: string;
  readonly purpose: string | null;
  readonly startedAt: Date;
  readonly status: string;
  readonly updatedAt: Date;
}

export interface SettledWorkflowRow {
  readonly changed: boolean;
  /** `completed` for a finalizing chat whose answer already finished; otherwise `cancelled`. */
  readonly outcome: "cancelled" | "completed";
  readonly releasedReservation: boolean;
}

function atOrAfter(...timestamps: readonly (Date | null | undefined)[]): Date {
  return new Date(
    Math.max(
      ...timestamps.flatMap((timestamp) =>
        timestamp === null || timestamp === undefined ? [] : [timestamp.getTime()],
      ),
    ),
  );
}

/**
 * Phase-aware settlement of one locked nonterminal generation row for Stop, deletion,
 * deactivation, and sign-out. Preparing and active rows (chat, compaction, or title) become
 * cancelled; a finalizing chat keeps its already-completed answer and becomes completed. Reserved
 * accounting is released only when no provider spend can exist (a preparing chat); every other
 * reservation is left for late accounting or expiry reconciliation.
 */
export async function settleNonterminalGeneration(
  transaction: AppTransaction,
  budget: Pick<BudgetService, "settleAuthoritativeUsageInTransaction">,
  generation: NonterminalGenerationRow,
  at: Date,
): Promise<SettledWorkflowRow> {
  const now = atOrAfter(
    at,
    generation.startedAt,
    generation.firstTokenAt,
    generation.createdAt,
    generation.updatedAt,
  );
  if (generation.status === "finalizing") {
    const updated = await transaction
      .update(generations)
      .set({ status: "completed", updatedAt: now })
      .where(and(eq(generations.id, generation.id), eq(generations.status, "finalizing")))
      .returning({ id: generations.id });
    return { changed: updated.length === 1, outcome: "completed", releasedReservation: false };
  }

  let releasedReservation = false;
  if (generation.status === "preparing" && generation.accountingStatus === "reserved") {
    const settled = await budget.settleAuthoritativeUsageInTransaction(
      transaction,
      generation.id,
      { completionTokens: 0, costUsd: "0", promptTokens: 0 },
      now,
    );
    if (!settled) {
      throw new Error("Preparing chat accounting could not be released during cancellation");
    }
    releasedReservation = true;
  }
  const updated = await transaction
    .update(generations)
    .set({
      completedAt: now,
      errorCode: null,
      status: "cancelled",
      terminalReason: "cancelled",
      updatedAt: now,
    })
    .where(
      and(
        eq(generations.id, generation.id),
        inArray(generations.status, [...nonterminalGenerationStatuses]),
      ),
    )
    .returning({ id: generations.id });
  if (updated.length === 1 && generation.purpose === "compaction") {
    await transaction
      .update(conversationCompactions)
      .set({ completedAt: now, status: "cancelled", updatedAt: now })
      .where(
        and(
          eq(conversationCompactions.generationId, generation.id),
          eq(conversationCompactions.status, "active"),
        ),
      );
  }
  return { changed: updated.length === 1, outcome: "cancelled", releasedReservation };
}

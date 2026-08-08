import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { conversationCompactions } from "../database/compaction-schema.js";
import { conversations } from "../database/conversation-schema.js";
import type { AppDatabase } from "../database/database.js";
import { generations } from "../database/generation-schema.js";
import { workspaces } from "../database/identity-schema.js";
import type { BudgetService } from "../model-policy/budget-service.js";

const cancellationBatchSize = 100;

export function createGenerationAdministrationService(
  database: AppDatabase,
  budget: BudgetService,
) {
  async function cancelEmployeeWork(
    workspaceId: string,
    userId: string,
  ): Promise<readonly string[]> {
    const cancelledIds: string[] = [];
    while (true) {
      const batch = await database.transaction(async (transaction) => {
        const workspaceRows = await transaction
          .select({ id: workspaces.id })
          .from(workspaces)
          .where(eq(workspaces.id, workspaceId))
          .limit(1)
          .for("update");
        if (workspaceRows[0] === undefined) {
          return { hadCandidates: false, ids: [] };
        }

        const candidates = await transaction
          .select({ conversationId: generations.conversationId, id: generations.id })
          .from(generations)
          .where(
            and(
              eq(generations.workspaceId, workspaceId),
              eq(generations.userId, userId),
              inArray(generations.status, ["preparing", "active"]),
            ),
          )
          .orderBy(asc(generations.conversationId), asc(generations.id))
          .limit(cancellationBatchSize);
        if (candidates.length === 0) {
          return { hadCandidates: false, ids: [] };
        }

        const conversationIds = [
          ...new Set(
            candidates
              .map(({ conversationId }) => conversationId)
              .filter((id): id is string => id !== null),
          ),
        ].sort();
        if (conversationIds.length > 0) {
          await transaction
            .select({ id: conversations.id })
            .from(conversations)
            .where(inArray(conversations.id, conversationIds))
            .orderBy(asc(conversations.id))
            .for("update");
        }

        const activeRows = await transaction
          .select({
            accountingStatus: generations.accountingStatus,
            conversationId: generations.conversationId,
            id: generations.id,
            purpose: generations.purpose,
            startedAt: generations.startedAt,
            status: generations.status,
            updatedAt: generations.updatedAt,
          })
          .from(generations)
          .where(
            and(
              inArray(
                generations.id,
                candidates.map(({ id }) => id),
              ),
              inArray(generations.status, ["preparing", "active"]),
            ),
          )
          .orderBy(asc(generations.conversationId), asc(generations.id))
          .for("update");

        const batchIds: string[] = [];
        const revisedConversations = new Set<string>();
        for (const generation of activeRows) {
          const completedAt = new Date(
            Math.max(Date.now(), generation.startedAt.getTime(), generation.updatedAt.getTime()),
          );
          if (generation.status === "preparing" && generation.accountingStatus === "reserved") {
            const settled = await budget.settleAuthoritativeUsageInTransaction(
              transaction,
              generation.id,
              { completionTokens: 0, costUsd: "0", promptTokens: 0 },
              completedAt,
            );
            if (!settled) {
              throw new Error(
                "Preparing chat accounting could not be released during deactivation",
              );
            }
          }
          const updated = await transaction
            .update(generations)
            .set({
              completedAt,
              errorCode: null,
              status: "cancelled",
              terminalReason: "cancelled",
              updatedAt: completedAt,
            })
            .where(
              and(
                eq(generations.id, generation.id),
                inArray(generations.status, ["preparing", "active"]),
              ),
            )
            .returning({ id: generations.id });
          if (updated.length !== 1) {
            continue;
          }
          batchIds.push(generation.id);
          if (generation.purpose === "compaction") {
            await transaction
              .update(conversationCompactions)
              .set({ completedAt, status: "cancelled", updatedAt: completedAt })
              .where(
                and(
                  eq(conversationCompactions.generationId, generation.id),
                  eq(conversationCompactions.status, "active"),
                ),
              );
          } else if (
            generation.conversationId !== null &&
            !revisedConversations.has(generation.conversationId)
          ) {
            await transaction
              .update(conversations)
              .set({
                revision: sql`${conversations.revision} + 1`,
                updatedAt: completedAt,
              })
              .where(eq(conversations.id, generation.conversationId));
            revisedConversations.add(generation.conversationId);
          }
        }
        return { hadCandidates: true, ids: batchIds };
      });
      if (!batch.hadCandidates) {
        return Object.freeze(cancelledIds);
      }
      cancelledIds.push(...batch.ids);
    }
  }

  return Object.freeze({ cancelEmployeeWork });
}

export type GenerationAdministrationService = ReturnType<
  typeof createGenerationAdministrationService
>;

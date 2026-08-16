import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { conversations } from "../database/conversation-schema.js";
import type { AppDatabase, AppTransaction } from "../database/database.js";
import { generations, nonterminalGenerationStatuses } from "../database/generation-schema.js";
import { workspaceMemberships, workspaces } from "../database/identity-schema.js";
import type { BudgetService } from "../model-policy/budget-service.js";
import type { ApplicationTelemetry } from "../observability/telemetry-contract.js";
import { settleNonterminalGeneration } from "./lifecycle.js";
import { isInitialTitleCandidate } from "./title-candidate.js";

const cancellationBatchSize = 100;

interface ConversationKeyRow extends Record<string, unknown> {
  readonly conversationId: string;
}

interface WorkspaceKeyRow extends Record<string, unknown> {
  readonly workspaceId: string;
}

export interface EmployeeWorkSettlement {
  readonly parentGenerationIds: readonly string[];
  readonly settledReservations: number;
}

export function createGenerationAdministrationService(
  database: AppDatabase,
  budget: BudgetService,
  telemetry?: Pick<ApplicationTelemetry, "recordReservationSettlement">,
) {
  function observe(action: () => void): void {
    try {
      action();
    } catch {
      // Telemetry cannot affect employee deactivation or accounting authority.
    }
  }

  async function lockEmployeeAuthorities(
    transaction: AppTransaction,
    workspaceId: string | null,
    userId: string,
  ): Promise<readonly string[]> {
    const workspaceRows =
      workspaceId === null
        ? await transaction.execute<WorkspaceKeyRow>(sql`
            SELECT workspace.id AS "workspaceId"
            FROM workspaces AS workspace
            WHERE EXISTS (
              SELECT 1
              FROM workspace_memberships AS membership
              WHERE membership.workspace_id = workspace.id
                AND membership.user_id = ${userId}
            ) OR EXISTS (
              SELECT 1
              FROM generations AS generation
              WHERE generation.workspace_id = workspace.id
                AND generation.user_id = ${userId}
                AND generation.status IN ('preparing', 'active', 'finalizing')
            )
            ORDER BY workspace.id
            FOR UPDATE OF workspace
          `)
        : null;
    const workspaceIds =
      workspaceId === null
        ? (workspaceRows?.rows.map((row) => row.workspaceId) ?? [])
        : (
            await transaction
              .select({ id: workspaces.id })
              .from(workspaces)
              .where(eq(workspaces.id, workspaceId))
              .limit(1)
              .for("update")
          ).map(({ id }) => id);
    if (workspaceIds.length === 0) {
      return [];
    }
    await transaction
      .select({ id: workspaceMemberships.id })
      .from(workspaceMemberships)
      .where(
        and(
          eq(workspaceMemberships.userId, userId),
          inArray(workspaceMemberships.workspaceId, [...workspaceIds]),
        ),
      )
      .orderBy(asc(workspaceMemberships.workspaceId), asc(workspaceMemberships.id))
      .for("update");
    return workspaceIds;
  }

  /**
   * Settles complete conversation workflows under an existing transaction. Session sign-out
   * calls this after locking its session row; administrative cancellation uses the same helper.
   */
  async function settleEmployeeWorkInTransaction(
    transaction: AppTransaction,
    workspaceId: string | null,
    userId: string,
  ): Promise<EmployeeWorkSettlement> {
    const workspaceIds = await lockEmployeeAuthorities(transaction, workspaceId, userId);
    if (workspaceIds.length === 0) {
      return Object.freeze({ parentGenerationIds: Object.freeze([]), settledReservations: 0 });
    }

    const parentGenerationIds: string[] = [];
    let settledReservations = 0;

    while (true) {
      const candidates = await transaction.execute<ConversationKeyRow>(sql`
        SELECT DISTINCT generation.conversation_id AS "conversationId"
        FROM generations AS generation
        WHERE generation.workspace_id IN (${sql.join(
          workspaceIds.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})
          AND generation.user_id = ${userId}
          AND generation.conversation_id IS NOT NULL
          AND generation.status IN ('preparing', 'active', 'finalizing')
        ORDER BY generation.conversation_id
        LIMIT ${cancellationBatchSize}
      `);
      const conversationIds = candidates.rows.map((row) => row.conversationId);
      if (conversationIds.length === 0) {
        break;
      }

      const lockedConversations = await transaction
        .select({ id: conversations.id, revision: conversations.revision })
        .from(conversations)
        .where(inArray(conversations.id, conversationIds))
        .orderBy(asc(conversations.id))
        .for("update");
      const revisions = new Map(lockedConversations.map((row) => [row.id, row.revision]));
      const rows = await transaction
        .select({
          accountingStatus: generations.accountingStatus,
          assistantMessageId: generations.assistantMessageId,
          conversationId: generations.conversationId,
          createdAt: generations.createdAt,
          firstTokenAt: generations.firstTokenAt,
          id: generations.id,
          purpose: generations.purpose,
          startedAt: generations.startedAt,
          status: generations.status,
          updatedAt: generations.updatedAt,
        })
        .from(generations)
        .where(
          and(
            eq(generations.userId, userId),
            inArray(generations.workspaceId, [...workspaceIds]),
            inArray(generations.conversationId, conversationIds),
            inArray(generations.status, [...nonterminalGenerationStatuses]),
          ),
        )
        .orderBy(
          asc(generations.conversationId),
          sql`CASE
            WHEN ${generations.assistantMessageId} IS NOT NULL
              AND (${generations.purpose} IS NULL OR ${generations.purpose} = 'chat') THEN 0
            ELSE 1
          END`,
          asc(generations.id),
        )
        .for("update");

      const settledAt = new Date();
      for (const conversationId of conversationIds) {
        const revision = revisions.get(conversationId);
        const workflow = rows.filter((row) => row.conversationId === conversationId);
        const parent = workflow.find(
          (row) =>
            row.assistantMessageId !== null && (row.purpose === null || row.purpose === "chat"),
        );
        const clearPending =
          parent !== undefined &&
          (parent.status === "finalizing" ||
            (await isInitialTitleCandidate(transaction, parent.id)));
        const automaticTitleSettled = parent?.status === "finalizing";

        for (const row of workflow.filter((candidate) => candidate !== parent)) {
          const settled = await settleNonterminalGeneration(transaction, budget, row, settledAt);
          settledReservations += settled.releasedReservation ? 1 : 0;
        }
        if (parent === undefined) {
          continue;
        }
        const settled = await settleNonterminalGeneration(transaction, budget, parent, settledAt);
        settledReservations += settled.releasedReservation ? 1 : 0;
        if (!settled.changed) {
          continue;
        }
        parentGenerationIds.push(parent.id);
        if (revision !== undefined) {
          const nextRevision = revision + 1;
          const conversationUpdatedAt = new Date(
            Math.max(settledAt.getTime(), ...workflow.map((row) => row.updatedAt.getTime())),
          );
          await transaction
            .update(conversations)
            .set({
              ...(clearPending ? { automaticTitlePending: false } : {}),
              ...(automaticTitleSettled ? { automaticTitleSettledRevision: nextRevision } : {}),
              revision: nextRevision,
              updatedAt: conversationUpdatedAt,
            })
            .where(eq(conversations.id, conversationId));
        }
      }
    }

    return Object.freeze({
      parentGenerationIds: Object.freeze([...new Set(parentGenerationIds)]),
      settledReservations,
    });
  }

  function recordSettlementTelemetry(settledReservations: number): void {
    for (let index = 0; index < settledReservations; index += 1) {
      observe(() => telemetry?.recordReservationSettlement("actual"));
    }
  }

  /** Durably settles every nonterminal generation the employee owns. */
  async function cancelEmployeeWork(
    workspaceId: string | null,
    userId: string,
  ): Promise<readonly string[]> {
    const result = await database.transaction((transaction) =>
      settleEmployeeWorkInTransaction(transaction, workspaceId, userId),
    );
    recordSettlementTelemetry(result.settledReservations);
    return result.parentGenerationIds;
  }

  return Object.freeze({
    cancelEmployeeWork,
    recordSettlementTelemetry,
    settleEmployeeWorkInTransaction,
  });
}

export type GenerationAdministrationService = ReturnType<
  typeof createGenerationAdministrationService
>;

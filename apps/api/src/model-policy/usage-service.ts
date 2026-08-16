import type { AdminEmployeeUsage, AdminUsageGroup, AdminUsageResponse } from "@capstone/protocol";
import { and, asc, eq, gt, or, sql } from "drizzle-orm";
import type { CursorCodec } from "../conversations/cursor.js";
import { cursorString } from "../conversations/cursor.js";
import { user as authUser } from "../database/auth-schema.generated.js";
import type { AppDatabase } from "../database/database.js";
import { workspaceMemberships, workspaces } from "../database/identity-schema.js";
import { ApplicationError } from "../errors.js";
import { workspaceBudgetPeriod } from "./budget-period.js";
import { canonicalUsd, compareDecimal } from "./money.js";

const usagePageSize = 50;
const usageCursorKind = "admin-usage";

interface BudgetRow extends Record<string, unknown> {
  readonly actualCostUsd: string;
  readonly estimatedCostUsd: string;
  readonly monthlyBudgetUsd: string;
  readonly remainingUsd: string;
  readonly reservedCostUsd: string;
}

interface ConsumptionRow extends Record<string, unknown> {
  readonly consumedUsd: string;
  readonly userId: string;
}

interface GroupRow extends Record<string, unknown> {
  readonly actualCostUsd: string;
  readonly cachedTokens: string;
  readonly completionTokens: string;
  readonly estimatedCostUsd: string;
  readonly generationCount: string;
  readonly promptTokens: string;
  readonly purpose: string;
  readonly reasoningTokens: string;
  readonly tier: string;
  readonly userId: string;
}

function invalidCursor(): never {
  throw new ApplicationError(400, "INVALID_CURSOR", "El cursor de paginación no es válido.");
}

function safeCount(value: string): number {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error("Usage generation count exceeds the public contract");
  }
  return count;
}

function usageGroup(row: GroupRow): AdminUsageGroup {
  if (
    (row.tier !== "fast" && row.tier !== "balanced" && row.tier !== "pro") ||
    (row.purpose !== "chat" && row.purpose !== "compaction" && row.purpose !== "title")
  ) {
    throw new Error("Stored usage grouping is invalid");
  }
  return Object.freeze({
    actualCostUsd: canonicalUsd(row.actualCostUsd),
    cachedTokens: row.cachedTokens,
    completionTokens: row.completionTokens,
    estimatedCostUsd: canonicalUsd(row.estimatedCostUsd),
    generationCount: safeCount(row.generationCount),
    promptTokens: row.promptTokens,
    purpose: row.purpose,
    reasoningTokens: row.reasoningTokens,
    tier: row.tier,
  });
}

export function createUsageService(
  database: AppDatabase,
  cursorCodec: CursorCodec,
  options: { readonly now?: () => Date } = {},
) {
  const now = options.now ?? (() => new Date());

  async function currentMonth(workspaceId: string, cursor?: string): Promise<AdminUsageResponse> {
    const period = await workspaceBudgetPeriod(database, workspaceId, now());
    if (period === null) {
      throw new Error("Workspace usage period is unavailable");
    }
    const periodEnd = period.end.toISOString();
    const periodStart = period.start.toISOString();
    const timezoneRows = await database
      .select({ timezone: workspaces.timezone })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .limit(1);
    const timezone = timezoneRows[0]?.timezone;
    if (timezone === undefined) {
      throw new Error("Workspace usage timezone is unavailable");
    }

    let after: { readonly email: string; readonly userId: string } | null = null;
    if (cursor !== undefined) {
      const payload = cursorCodec.decode(cursor, usageCursorKind);
      if (
        cursorString(payload, "workspaceId") !== workspaceId ||
        cursorString(payload, "periodStart") !== periodStart ||
        cursorString(payload, "periodEnd") !== periodEnd
      ) {
        invalidCursor();
      }
      after = {
        email: cursorString(payload, "email"),
        userId: cursorString(payload, "userId"),
      };
    }
    const employeeRows = await database
      .select({
        email: authUser.email,
        monthlySoftBudgetUsd: workspaceMemberships.monthlySoftBudgetUsd,
        name: authUser.name,
        userId: authUser.id,
      })
      .from(workspaceMemberships)
      .innerJoin(authUser, eq(authUser.id, workspaceMemberships.userId))
      .where(
        and(
          eq(workspaceMemberships.workspaceId, workspaceId),
          after === null
            ? undefined
            : or(
                gt(authUser.email, after.email),
                and(eq(authUser.email, after.email), gt(authUser.id, after.userId)),
              ),
        ),
      )
      .orderBy(asc(authUser.email), asc(authUser.id))
      .limit(usagePageSize + 1);
    const visibleEmployees = employeeRows.slice(0, usagePageSize);
    const userIds = visibleEmployees.map(({ userId }) => userId);

    const budgetResult = await database.execute<BudgetRow>(sql`
      SELECT
        cp.monthly_budget_usd::text AS "monthlyBudgetUsd",
        COALESCE(SUM(CASE WHEN g.accounting_status = 'actual' THEN g.cost_usd ELSE 0::numeric END), 0::numeric)::text AS "actualCostUsd",
        COALESCE(SUM(CASE WHEN g.accounting_status = 'estimated' THEN g.cost_usd ELSE 0::numeric END), 0::numeric)::text AS "estimatedCostUsd",
        COALESCE(SUM(CASE WHEN g.accounting_status = 'reserved' THEN g.reserved_cost_usd ELSE 0::numeric END), 0::numeric)::text AS "reservedCostUsd",
        GREATEST(
          cp.monthly_budget_usd - COALESCE(SUM(
            CASE
              WHEN g.accounting_status = 'reserved' THEN g.reserved_cost_usd
              WHEN g.accounting_status IN ('actual', 'estimated') THEN g.cost_usd
              ELSE 0::numeric
            END
          ), 0::numeric),
          0::numeric
        )::text AS "remainingUsd"
      FROM workspace_cost_policies AS cp
      LEFT JOIN generations AS g
        ON g.workspace_id = cp.workspace_id
       AND g.budget_period_start = ${period.start}
       AND g.budget_period_end = ${period.end}
      WHERE cp.workspace_id = ${workspaceId}::uuid
      GROUP BY cp.workspace_id, cp.monthly_budget_usd
    `);
    const budget = budgetResult.rows[0];
    if (budget === undefined) {
      throw new Error("Workspace cost policy is unavailable");
    }

    const consumptionByUser = new Map<string, string>();
    const groupsByUser = new Map<string, AdminUsageGroup[]>();
    if (userIds.length > 0) {
      const userFilter = sql.join(
        userIds.map((userId) => sql`${userId}`),
        sql`, `,
      );
      const consumptionResult = await database.execute<ConsumptionRow>(sql`
        SELECT
          g.user_id AS "userId",
          COALESCE(SUM(
            CASE
              WHEN g.accounting_status = 'reserved' THEN g.reserved_cost_usd
              WHEN g.accounting_status IN ('actual', 'estimated') THEN g.cost_usd
              ELSE 0::numeric
            END
          ), 0::numeric)::text AS "consumedUsd"
        FROM generations AS g
        WHERE g.workspace_id = ${workspaceId}::uuid
          AND g.user_id IN (${userFilter})
          AND g.budget_period_start = ${period.start}
          AND g.budget_period_end = ${period.end}
          AND g.accounting_status IN ('reserved', 'actual', 'estimated')
        GROUP BY g.user_id
      `);
      for (const row of consumptionResult.rows) {
        consumptionByUser.set(row.userId, canonicalUsd(row.consumedUsd));
      }

      const groupResult = await database.execute<GroupRow>(sql`
        SELECT
          g.user_id AS "userId",
          g.requested_tier AS tier,
          g.purpose,
          COUNT(*)::text AS "generationCount",
          COALESCE(SUM(g.prompt_tokens), 0)::text AS "promptTokens",
          COALESCE(SUM(g.completion_tokens), 0)::text AS "completionTokens",
          COALESCE(SUM(g.reasoning_tokens), 0)::text AS "reasoningTokens",
          COALESCE(SUM(g.cached_tokens), 0)::text AS "cachedTokens",
          COALESCE(SUM(CASE WHEN g.accounting_status = 'actual' THEN g.cost_usd ELSE 0::numeric END), 0::numeric)::text AS "actualCostUsd",
          COALESCE(SUM(CASE WHEN g.accounting_status = 'estimated' THEN g.cost_usd ELSE 0::numeric END), 0::numeric)::text AS "estimatedCostUsd"
        FROM generations AS g
        WHERE g.workspace_id = ${workspaceId}::uuid
          AND g.user_id IN (${userFilter})
          AND g.budget_period_start = ${period.start}
          AND g.budget_period_end = ${period.end}
          AND g.accounting_status IN ('actual', 'estimated')
          AND g.purpose IN ('chat', 'compaction', 'title')
          AND g.requested_tier IN ('fast', 'balanced', 'pro')
        GROUP BY g.user_id, g.requested_tier, g.purpose
        ORDER BY
          g.user_id,
          CASE g.requested_tier WHEN 'fast' THEN 1 WHEN 'balanced' THEN 2 ELSE 3 END,
          CASE g.purpose WHEN 'chat' THEN 1 WHEN 'compaction' THEN 2 ELSE 3 END
      `);
      for (const row of groupResult.rows) {
        const groups = groupsByUser.get(row.userId) ?? [];
        groups.push(usageGroup(row));
        groupsByUser.set(row.userId, groups);
      }
    }

    const items: AdminEmployeeUsage[] = visibleEmployees.map((employee) => {
      const consumedUsd = consumptionByUser.get(employee.userId) ?? "0";
      const monthlyBudgetUsd =
        employee.monthlySoftBudgetUsd === null ? null : canonicalUsd(employee.monthlySoftBudgetUsd);
      return Object.freeze({
        employee: Object.freeze({
          email: employee.email,
          id: employee.userId,
          name: employee.name,
        }),
        groups: groupsByUser.get(employee.userId) ?? [],
        softBudget: Object.freeze({
          consumedUsd,
          monthlyBudgetUsd,
          warning: monthlyBudgetUsd !== null && compareDecimal(consumedUsd, monthlyBudgetUsd) >= 0,
        }),
      });
    });
    const last = visibleEmployees.at(-1);
    return Object.freeze({
      budget: Object.freeze({
        actualCostUsd: canonicalUsd(budget.actualCostUsd),
        estimatedCostUsd: canonicalUsd(budget.estimatedCostUsd),
        monthlyBudgetUsd: canonicalUsd(budget.monthlyBudgetUsd),
        remainingUsd: canonicalUsd(budget.remainingUsd),
        reservedCostUsd: canonicalUsd(budget.reservedCostUsd),
      }),
      items,
      nextCursor:
        employeeRows.length <= usagePageSize || last === undefined
          ? null
          : cursorCodec.encode({
              email: last.email,
              kind: usageCursorKind,
              periodEnd,
              periodStart,
              userId: last.userId,
              version: 1,
              workspaceId,
            }),
      period: Object.freeze({
        end: periodEnd,
        start: periodStart,
        timezone,
      }),
    });
  }

  return Object.freeze({ currentMonth });
}

export type UsageService = ReturnType<typeof createUsageService>;

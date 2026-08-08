import { sql } from "drizzle-orm";
import type { AppDatabaseExecutor } from "../database/database.js";
import { canonicalUsd } from "./money.js";

export interface WorkspaceBudgetPeriod {
  readonly end: Date;
  readonly start: Date;
}

interface PeriodRow extends Record<string, unknown> {
  readonly periodEnd: Date | string;
  readonly periodStart: Date | string;
}

interface ConsumptionRow extends Record<string, unknown> {
  readonly consumedUsd: string;
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

export async function workspaceBudgetPeriod(
  database: AppDatabaseExecutor,
  workspaceId: string,
  at: Date,
): Promise<WorkspaceBudgetPeriod | null> {
  const result = await database.execute<PeriodRow>(sql`
    SELECT
      date_trunc('month', ${at}::timestamptz AT TIME ZONE w.timezone)
        AT TIME ZONE w.timezone AS "periodStart",
      (date_trunc('month', ${at}::timestamptz AT TIME ZONE w.timezone) + interval '1 month')
        AT TIME ZONE w.timezone AS "periodEnd"
    FROM workspaces AS w
    WHERE w.id = ${workspaceId}::uuid
  `);
  const row = result.rows[0];
  return row === undefined
    ? null
    : Object.freeze({ end: toDate(row.periodEnd), start: toDate(row.periodStart) });
}

export async function workspaceBudgetConsumptionUsd(
  database: AppDatabaseExecutor,
  workspaceId: string,
  period: WorkspaceBudgetPeriod,
): Promise<string> {
  const result = await database.execute<ConsumptionRow>(sql`
    SELECT COALESCE(SUM(
      CASE
        WHEN accounting_status = 'reserved' THEN reserved_cost_usd
        WHEN accounting_status IN ('actual', 'estimated') THEN cost_usd
        ELSE 0::numeric
      END
    ), 0::numeric)::text AS "consumedUsd"
    FROM generations
    WHERE workspace_id = ${workspaceId}::uuid
      AND budget_period_start = ${period.start}
      AND budget_period_end = ${period.end}
      AND accounting_status IN ('reserved', 'actual', 'estimated')
  `);
  return canonicalUsd(result.rows[0]?.consumedUsd ?? "0", "workspace consumption");
}

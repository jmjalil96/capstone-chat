import type { AdminEmployee, AdminEmployeeRole } from "@capstone/protocol";
import { and, asc, eq, gt, or } from "drizzle-orm";
import type { CursorCodec } from "../conversations/cursor.js";
import { cursorString } from "../conversations/cursor.js";
import { user as authUser } from "../database/auth-schema.generated.js";
import type { AppDatabase, AppDatabaseExecutor } from "../database/database.js";
import {
  employeeApprovals,
  workspaceMemberships,
  workspaces,
} from "../database/identity-schema.js";
import { ApplicationError } from "../errors.js";
import { canonicalUsd } from "../model-policy/money.js";
import { normalizeApprovalEmail } from "./email-normalization.js";

const employeePageSize = 50;
const employeeCursorKind = "admin-employees";

export class EmployeeAdministrationConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmployeeAdministrationConflictError";
  }
}

export class EmployeeAdministrationNotFoundError extends Error {
  constructor() {
    super("Employee approval was not found in the workspace");
    this.name = "EmployeeAdministrationNotFoundError";
  }
}

interface EmployeeCursor {
  readonly approvalId: string;
  readonly email: string;
}

interface EmployeeRow {
  readonly approvalId: string;
  readonly approvalStatus: "pending" | "activated" | "revoked";
  readonly email: string;
  readonly membershipStatus: "active" | "deactivated" | null;
  readonly monthlySoftBudgetUsd: string | null;
  readonly name: string | null;
  readonly role: "admin" | "member";
  readonly userId: string | null;
}

type DeactivationSelector =
  | {
      readonly actorUserId: string;
      readonly approvalId: string;
      readonly kind: "approval";
      readonly workspaceId: string;
    }
  | {
      readonly kind: "identity";
      readonly normalizedEmail: string;
      readonly workspaceIdentity: string;
    };

function toEmployee(row: EmployeeRow): AdminEmployee {
  let status: AdminEmployee["status"];
  if (row.approvalStatus === "pending") {
    status = "pending";
  } else if (row.approvalStatus === "activated" && row.membershipStatus === "active") {
    status = "active";
  } else {
    status = "deactivated";
  }

  return Object.freeze({
    approvalId: row.approvalId,
    email: row.email,
    monthlySoftBudgetUsd:
      row.monthlySoftBudgetUsd === null ? null : canonicalUsd(row.monthlySoftBudgetUsd),
    name: row.name,
    role: row.role,
    status,
    userId: row.userId,
  });
}

function employeeSelection() {
  return {
    approvalId: employeeApprovals.id,
    approvalStatus: employeeApprovals.status,
    email: employeeApprovals.normalizedEmail,
    membershipStatus: workspaceMemberships.status,
    monthlySoftBudgetUsd: workspaceMemberships.monthlySoftBudgetUsd,
    name: authUser.name,
    role: employeeApprovals.role,
    userId: employeeApprovals.userId,
  } as const;
}

async function selectEmployee(
  database: AppDatabaseExecutor,
  workspaceId: string,
  approvalId: string,
): Promise<AdminEmployee | null> {
  const rows = await database
    .select(employeeSelection())
    .from(employeeApprovals)
    .leftJoin(authUser, eq(authUser.id, employeeApprovals.userId))
    .leftJoin(
      workspaceMemberships,
      and(
        eq(workspaceMemberships.workspaceId, employeeApprovals.workspaceId),
        eq(workspaceMemberships.userId, employeeApprovals.userId),
      ),
    )
    .where(
      and(eq(employeeApprovals.workspaceId, workspaceId), eq(employeeApprovals.id, approvalId)),
    )
    .limit(1);
  const row = rows[0];
  return row === undefined ? null : toEmployee(row);
}

export function createEmployeeAdministrationService(
  database: AppDatabase,
  cursorCodec: CursorCodec,
) {
  function decodeCursor(cursor: string, workspaceId: string): EmployeeCursor {
    const payload = cursorCodec.decode(cursor, employeeCursorKind);
    if (cursorString(payload, "workspaceId") !== workspaceId) {
      throw new ApplicationError(400, "INVALID_CURSOR", "El cursor de paginación no es válido.");
    }
    return {
      approvalId: cursorString(payload, "approvalId"),
      email: cursorString(payload, "email"),
    };
  }

  async function list(
    workspaceId: string,
    cursor?: string,
  ): Promise<{ readonly items: AdminEmployee[]; readonly nextCursor: string | null }> {
    const after = cursor === undefined ? null : decodeCursor(cursor, workspaceId);
    const rows = await database
      .select(employeeSelection())
      .from(employeeApprovals)
      .leftJoin(authUser, eq(authUser.id, employeeApprovals.userId))
      .leftJoin(
        workspaceMemberships,
        and(
          eq(workspaceMemberships.workspaceId, employeeApprovals.workspaceId),
          eq(workspaceMemberships.userId, employeeApprovals.userId),
        ),
      )
      .where(
        and(
          eq(employeeApprovals.workspaceId, workspaceId),
          after === null
            ? undefined
            : or(
                gt(employeeApprovals.normalizedEmail, after.email),
                and(
                  eq(employeeApprovals.normalizedEmail, after.email),
                  gt(employeeApprovals.id, after.approvalId),
                ),
              ),
        ),
      )
      .orderBy(asc(employeeApprovals.normalizedEmail), asc(employeeApprovals.id))
      .limit(employeePageSize + 1);
    const visible = rows.slice(0, employeePageSize);
    const last = visible.at(-1);
    return Object.freeze({
      items: visible.map(toEmployee),
      nextCursor:
        rows.length <= employeePageSize || last === undefined
          ? null
          : cursorCodec.encode({
              approvalId: last.approvalId,
              email: last.email,
              kind: employeeCursorKind,
              version: 1,
              workspaceId,
            }),
    });
  }

  async function get(workspaceId: string, approvalId: string): Promise<AdminEmployee> {
    const employee = await selectEmployee(database, workspaceId, approvalId);
    if (employee === null) {
      throw new EmployeeAdministrationNotFoundError();
    }
    return employee;
  }

  async function pendingInvitationTarget(
    workspaceId: string,
    approvalId: string,
  ): Promise<{ readonly email: string; readonly role: AdminEmployeeRole }> {
    const employee = await get(workspaceId, approvalId);
    if (employee.status !== "pending") {
      throw new EmployeeAdministrationConflictError(
        "Only a pending employee approval can receive an invitation",
      );
    }
    return Object.freeze({ email: employee.email, role: employee.role });
  }

  async function setSoftBudget(
    workspaceId: string,
    approvalId: string,
    monthlySoftBudgetUsd: string | null,
  ): Promise<AdminEmployee> {
    const canonicalBudget =
      monthlySoftBudgetUsd === null
        ? null
        : canonicalUsd(monthlySoftBudgetUsd, "monthly employee soft budget");
    await database.transaction(async (transaction) => {
      const workspaceRows = await transaction
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId))
        .limit(1)
        .for("update");
      if (workspaceRows[0] === undefined) {
        throw new EmployeeAdministrationNotFoundError();
      }
      const approvalRows = await transaction
        .select({ status: employeeApprovals.status, userId: employeeApprovals.userId })
        .from(employeeApprovals)
        .where(
          and(eq(employeeApprovals.workspaceId, workspaceId), eq(employeeApprovals.id, approvalId)),
        )
        .limit(1)
        .for("update");
      const approval = approvalRows[0];
      if (approval === undefined) {
        throw new EmployeeAdministrationNotFoundError();
      }
      if (approval.status === "pending" || approval.userId === null) {
        throw new EmployeeAdministrationConflictError(
          "Pending approvals cannot have an employee soft budget",
        );
      }
      const updated = await transaction
        .update(workspaceMemberships)
        .set({ monthlySoftBudgetUsd: canonicalBudget, updatedAt: new Date() })
        .where(
          and(
            eq(workspaceMemberships.workspaceId, workspaceId),
            eq(workspaceMemberships.userId, approval.userId),
          ),
        )
        .returning({ id: workspaceMemberships.id });
      if (updated.length !== 1) {
        throw new EmployeeAdministrationConflictError(
          "Employee membership is unavailable for a soft budget",
        );
      }
    });
    return get(workspaceId, approvalId);
  }

  async function deactivateSelected(input: DeactivationSelector): Promise<{
    readonly employee: AdminEmployee;
    readonly repeated: boolean;
    readonly userId: string | null;
    readonly workspaceId: string;
  }> {
    const outcome = await database.transaction(async (transaction) => {
      const workspaceRows = await transaction
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(
          input.kind === "approval"
            ? eq(workspaces.id, input.workspaceId)
            : eq(workspaces.identity, input.workspaceIdentity),
        )
        .limit(2)
        .for("update");
      const workspace = workspaceRows[0];
      if (workspace === undefined || workspaceRows.length !== 1) {
        throw new EmployeeAdministrationNotFoundError();
      }
      const approvalRows = await transaction
        .select()
        .from(employeeApprovals)
        .where(
          and(
            eq(employeeApprovals.workspaceId, workspace.id),
            input.kind === "approval"
              ? eq(employeeApprovals.id, input.approvalId)
              : eq(employeeApprovals.normalizedEmail, input.normalizedEmail),
          ),
        )
        .limit(2)
        .for("update");
      const approval = approvalRows[0];
      if (approval === undefined || approvalRows.length !== 1) {
        throw new EmployeeAdministrationNotFoundError();
      }
      if (approval.status === "revoked") {
        return {
          approvalId: approval.id,
          repeated: true,
          userId: approval.userId,
          workspaceId: workspace.id,
        };
      }
      if (input.kind === "approval" && approval.userId === input.actorUserId) {
        throw new EmployeeAdministrationConflictError(
          "An administrator cannot deactivate their own approval",
        );
      }
      if (approval.role === "admin" && approval.status === "activated") {
        const activeAdministrators = await transaction
          .select({ id: employeeApprovals.id })
          .from(employeeApprovals)
          .innerJoin(
            workspaceMemberships,
            and(
              eq(workspaceMemberships.workspaceId, employeeApprovals.workspaceId),
              eq(workspaceMemberships.userId, employeeApprovals.userId),
              eq(workspaceMemberships.status, "active"),
            ),
          )
          .where(
            and(
              eq(employeeApprovals.workspaceId, workspace.id),
              eq(employeeApprovals.role, "admin"),
              eq(employeeApprovals.status, "activated"),
            ),
          )
          .for("update");
        if (activeAdministrators.length <= 1) {
          throw new EmployeeAdministrationConflictError(
            "The final active administrator cannot be deactivated",
          );
        }
      }

      const changedAt = new Date();
      await transaction
        .update(employeeApprovals)
        .set({ revokedAt: changedAt, status: "revoked", updatedAt: changedAt })
        .where(eq(employeeApprovals.id, approval.id));
      if (approval.userId !== null) {
        await transaction
          .update(workspaceMemberships)
          .set({ deactivatedAt: changedAt, status: "deactivated", updatedAt: changedAt })
          .where(
            and(
              eq(workspaceMemberships.workspaceId, workspace.id),
              eq(workspaceMemberships.userId, approval.userId),
              eq(workspaceMemberships.status, "active"),
            ),
          );
      }
      return {
        approvalId: approval.id,
        repeated: false,
        userId: approval.userId,
        workspaceId: workspace.id,
      };
    });
    const employee = await get(outcome.workspaceId, outcome.approvalId);
    return Object.freeze({
      employee,
      repeated: outcome.repeated,
      userId: outcome.userId,
      workspaceId: outcome.workspaceId,
    });
  }

  async function deactivate(input: {
    readonly actorUserId: string;
    readonly approvalId: string;
    readonly workspaceId: string;
  }) {
    return deactivateSelected({ ...input, kind: "approval" });
  }

  async function deactivateByIdentity(input: {
    readonly email: string;
    readonly workspaceIdentity: string;
  }) {
    return deactivateSelected({
      kind: "identity",
      normalizedEmail: normalizeApprovalEmail(input.email),
      workspaceIdentity: input.workspaceIdentity,
    });
  }

  return Object.freeze({
    deactivate,
    deactivateByIdentity,
    get,
    list,
    pendingInvitationTarget,
    setSoftBudget,
  });
}

export type EmployeeAdministrationService = ReturnType<typeof createEmployeeAdministrationService>;

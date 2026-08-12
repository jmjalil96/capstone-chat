import { and, eq, isNull, or, sql } from "drizzle-orm";
import { user as authUser } from "../database/auth-schema.generated.js";
import type { AppDatabase } from "../database/database.js";
import {
  employeeApprovals,
  workspaceMemberships,
  workspaces,
} from "../database/identity-schema.js";
import { normalizeApprovalEmail, normalizeEmail } from "./email-normalization.js";

export type WorkspaceRole = "admin" | "member";

export interface IdentityUser {
  readonly email: string;
  readonly emailVerified: boolean;
  readonly id: string;
}

export interface ActiveMembership {
  readonly role: WorkspaceRole;
  readonly workspaceDisplayName: string;
  readonly workspaceId: string;
  readonly workspaceIdentity: string;
}

export interface ApprovalResult {
  readonly approvalId: string;
  readonly normalizedEmail: string;
  readonly repeated: boolean;
  readonly role: WorkspaceRole;
  readonly workspaceId: string;
}

export interface BootstrapResult extends ApprovalResult {
  readonly workspaceIdentity: string;
}

export interface InitialInvitationTarget {
  readonly normalizedEmail: string;
  readonly workspaceId: string;
}

export type ActivationResult = "activated" | "already-active" | "blocked" | "missing";

export class IdentityConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IdentityConflictError";
  }
}

export function createIdentityService(database: AppDatabase) {
  async function initialInvitationTarget(input: {
    readonly adminEmail: string;
    readonly workspaceIdentity: string;
  }): Promise<InitialInvitationTarget> {
    const normalizedEmail = normalizeApprovalEmail(input.adminEmail);
    const rows = await database
      .select({
        normalizedEmail: employeeApprovals.normalizedEmail,
        role: employeeApprovals.role,
        status: employeeApprovals.status,
        workspaceId: employeeApprovals.workspaceId,
      })
      .from(employeeApprovals)
      .innerJoin(workspaces, eq(workspaces.id, employeeApprovals.workspaceId))
      .where(
        and(
          eq(workspaces.identity, input.workspaceIdentity),
          eq(employeeApprovals.normalizedEmail, normalizedEmail),
        ),
      )
      .limit(2);
    const target = rows[0];
    if (
      target === undefined ||
      rows.length !== 1 ||
      target.role !== "admin" ||
      target.status !== "pending"
    ) {
      throw new IdentityConflictError(
        "The canonical pending administrator approval is unavailable",
      );
    }
    return Object.freeze({
      normalizedEmail: target.normalizedEmail,
      workspaceId: target.workspaceId,
    });
  }

  async function findPendingApproval(email: string): Promise<boolean> {
    const normalizedEmail = normalizeEmail(email);
    const rows = await database
      .select({ id: employeeApprovals.id })
      .from(employeeApprovals)
      .where(
        and(
          eq(employeeApprovals.normalizedEmail, normalizedEmail),
          eq(employeeApprovals.status, "pending"),
        ),
      )
      .limit(2);

    return rows.length === 1;
  }

  async function canSignIn(email: string): Promise<boolean> {
    const normalizedEmail = normalizeEmail(email);
    const rows = await database
      .select({ approvalId: employeeApprovals.id })
      .from(employeeApprovals)
      .innerJoin(
        workspaceMemberships,
        and(
          eq(employeeApprovals.workspaceId, workspaceMemberships.workspaceId),
          eq(employeeApprovals.userId, workspaceMemberships.userId),
          eq(employeeApprovals.role, workspaceMemberships.role),
        ),
      )
      .where(
        and(
          eq(employeeApprovals.normalizedEmail, normalizedEmail),
          eq(employeeApprovals.status, "activated"),
          eq(workspaceMemberships.status, "active"),
        ),
      )
      .limit(2);

    return rows.length === 1;
  }

  async function prepareSignIn(email: string): Promise<boolean> {
    if (await canSignIn(email)) {
      return true;
    }

    const normalizedEmail = normalizeEmail(email);
    const [approvalRows, userRows] = await Promise.all([
      database
        .select({ id: employeeApprovals.id })
        .from(employeeApprovals)
        .where(
          and(
            eq(employeeApprovals.normalizedEmail, normalizedEmail),
            eq(employeeApprovals.status, "pending"),
          ),
        )
        .limit(2),
      database
        .select({ email: authUser.email, emailVerified: authUser.emailVerified, id: authUser.id })
        .from(authUser)
        .where(eq(authUser.email, normalizedEmail))
        .limit(2),
    ]);
    const user = userRows[0];

    if (approvalRows.length !== 1 || userRows.length !== 1 || user?.emailVerified !== true) {
      return false;
    }

    const activation = await activateMembership(user);
    return activation === "activated" || activation === "already-active";
  }

  async function linkRegisteredUser(user: IdentityUser): Promise<void> {
    const normalizedEmail = normalizeEmail(user.email);
    await database
      .update(employeeApprovals)
      .set({ updatedAt: new Date(), userId: user.id })
      .where(
        and(
          eq(employeeApprovals.normalizedEmail, normalizedEmail),
          eq(employeeApprovals.status, "pending"),
          or(isNull(employeeApprovals.userId), eq(employeeApprovals.userId, user.id)),
        ),
      );
  }

  async function activateMembership(user: IdentityUser): Promise<ActivationResult> {
    if (!user.emailVerified) {
      return "blocked";
    }

    return database.transaction(async (transaction) => {
      const normalizedEmail = normalizeEmail(user.email);
      const approvalRows = await transaction
        .select()
        .from(employeeApprovals)
        .where(eq(employeeApprovals.normalizedEmail, normalizedEmail))
        .for("update");

      if (approvalRows.length !== 1) {
        return approvalRows.length === 0 ? "missing" : "blocked";
      }

      const approval = approvalRows[0];
      if (approval === undefined || approval.status === "revoked") {
        return "blocked";
      }
      if (approval.userId !== null && approval.userId !== user.id) {
        return "blocked";
      }

      const existingMemberships = await transaction
        .select()
        .from(workspaceMemberships)
        .where(
          and(
            eq(workspaceMemberships.workspaceId, approval.workspaceId),
            eq(workspaceMemberships.userId, user.id),
          ),
        )
        .for("update");

      if (existingMemberships.length > 1) {
        return "blocked";
      }

      const existingMembership = existingMemberships[0];
      if (
        existingMembership !== undefined &&
        (existingMembership.status === "deactivated" || existingMembership.role !== approval.role)
      ) {
        return "blocked";
      }

      if (approval.status === "activated") {
        return existingMembership?.status === "active" ? "already-active" : "blocked";
      }

      const now = new Date();
      if (existingMembership === undefined) {
        await transaction.insert(workspaceMemberships).values({
          activatedAt: now,
          role: approval.role,
          status: "active",
          userId: user.id,
          workspaceId: approval.workspaceId,
        });
      }

      const updated = await transaction
        .update(employeeApprovals)
        .set({
          activatedAt: now,
          status: "activated",
          updatedAt: now,
          userId: user.id,
        })
        .where(
          and(
            eq(employeeApprovals.id, approval.id),
            eq(employeeApprovals.status, "pending"),
            or(isNull(employeeApprovals.userId), eq(employeeApprovals.userId, user.id)),
          ),
        )
        .returning({ id: employeeApprovals.id });

      if (updated.length !== 1) {
        throw new Error("Membership activation could not finalize its approval state");
      }

      return "activated";
    });
  }

  async function findActiveMemberships(user: IdentityUser): Promise<readonly ActiveMembership[]> {
    if (!user.emailVerified) {
      return [];
    }

    const current = await selectActiveMemberships(user.id);
    if (current.length > 0) {
      return current;
    }

    await activateMembership(user);
    return selectActiveMemberships(user.id);
  }

  async function selectActiveMemberships(userId: string): Promise<readonly ActiveMembership[]> {
    return database
      .select({
        role: workspaceMemberships.role,
        workspaceDisplayName: workspaces.displayName,
        workspaceId: workspaces.id,
        workspaceIdentity: workspaces.identity,
      })
      .from(workspaceMemberships)
      .innerJoin(workspaces, eq(workspaceMemberships.workspaceId, workspaces.id))
      .innerJoin(
        employeeApprovals,
        and(
          eq(employeeApprovals.workspaceId, workspaceMemberships.workspaceId),
          eq(employeeApprovals.userId, workspaceMemberships.userId),
          eq(employeeApprovals.role, workspaceMemberships.role),
        ),
      )
      .where(
        and(
          eq(workspaceMemberships.userId, userId),
          eq(workspaceMemberships.status, "active"),
          eq(employeeApprovals.status, "activated"),
        ),
      )
      .limit(2);
  }

  async function bootstrap(input: {
    adminEmail: string;
    displayName: string;
    workspaceIdentity: string;
  }): Promise<BootstrapResult> {
    const normalizedEmail = normalizeApprovalEmail(input.adminEmail);

    return database.transaction(async (transaction) => {
      await transaction.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext('capstone.identity.bootstrap'))`,
      );
      const existingWorkspaces = await transaction.select().from(workspaces).limit(2);
      let workspace = existingWorkspaces[0];
      const workspaceWasCreated = workspace === undefined;

      if (workspaceWasCreated) {
        const inserted = await transaction
          .insert(workspaces)
          .values({ displayName: input.displayName, identity: input.workspaceIdentity })
          .returning();
        workspace = inserted[0];
      }

      if (
        workspace === undefined ||
        existingWorkspaces.length > 1 ||
        workspace.identity !== input.workspaceIdentity ||
        workspace.displayName !== input.displayName ||
        workspace.timezone !== "America/Guayaquil"
      ) {
        throw new IdentityConflictError("The existing workspace conflicts with bootstrap input");
      }

      const existing = await transaction
        .select()
        .from(employeeApprovals)
        .where(
          and(
            eq(employeeApprovals.workspaceId, workspace.id),
            eq(employeeApprovals.normalizedEmail, normalizedEmail),
          ),
        )
        .for("update");
      const approval = existing[0];

      if (approval !== undefined) {
        if (existing.length !== 1 || approval.role !== "admin" || approval.status === "revoked") {
          throw new IdentityConflictError(
            "The existing administrator approval conflicts with bootstrap input",
          );
        }

        return {
          approvalId: approval.id,
          normalizedEmail,
          repeated: true,
          role: "admin",
          workspaceId: workspace.id,
          workspaceIdentity: workspace.identity,
        };
      }

      if (!workspaceWasCreated) {
        throw new IdentityConflictError(
          "The existing workspace was bootstrapped with different administrator input",
        );
      }

      const inserted = await transaction
        .insert(employeeApprovals)
        .values({ normalizedEmail, role: "admin", workspaceId: workspace.id })
        .returning({ id: employeeApprovals.id });
      const approvalId = inserted[0]?.id;
      if (approvalId === undefined) {
        throw new Error("Administrator approval was not created");
      }

      return {
        approvalId,
        normalizedEmail,
        repeated: false,
        role: "admin",
        workspaceId: workspace.id,
        workspaceIdentity: workspace.identity,
      };
    });
  }

  async function approve(input: {
    email: string;
    role: WorkspaceRole;
    workspaceIdentity: string;
  }): Promise<ApprovalResult> {
    const normalizedEmail = normalizeApprovalEmail(input.email);

    return database.transaction(async (transaction) => {
      const workspaceRows = await transaction
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(eq(workspaces.identity, input.workspaceIdentity))
        .limit(2)
        .for("update");
      const workspace = workspaceRows[0];
      if (workspace === undefined || workspaceRows.length !== 1) {
        throw new IdentityConflictError("The workspace does not exist or is ambiguous");
      }

      const existing = await transaction
        .select()
        .from(employeeApprovals)
        .where(
          and(
            eq(employeeApprovals.workspaceId, workspace.id),
            eq(employeeApprovals.normalizedEmail, normalizedEmail),
          ),
        )
        .for("update");
      const approval = existing[0];

      if (approval !== undefined) {
        if (existing.length !== 1 || approval.status !== "pending") {
          throw new IdentityConflictError(
            "The existing employee approval conflicts with this request",
          );
        }

        if (approval.role !== input.role) {
          await transaction
            .update(employeeApprovals)
            .set({ role: input.role, updatedAt: new Date() })
            .where(
              and(eq(employeeApprovals.id, approval.id), eq(employeeApprovals.status, "pending")),
            );
        }

        return {
          approvalId: approval.id,
          normalizedEmail,
          repeated: true,
          role: input.role,
          workspaceId: workspace.id,
        };
      }

      const inserted = await transaction
        .insert(employeeApprovals)
        .values({ normalizedEmail, role: input.role, workspaceId: workspace.id })
        .returning({ id: employeeApprovals.id });
      const approvalId = inserted[0]?.id;
      if (approvalId === undefined) {
        throw new Error("Employee approval was not created");
      }

      return {
        approvalId,
        normalizedEmail,
        repeated: false,
        role: input.role,
        workspaceId: workspace.id,
      };
    });
  }

  return Object.freeze({
    activateMembership,
    approve,
    bootstrap,
    canSignIn,
    findActiveMemberships,
    findPendingApproval,
    initialInvitationTarget,
    linkRegisteredUser,
    prepareSignIn,
  });
}

export type IdentityService = ReturnType<typeof createIdentityService>;

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { account, session, user } from "../src/database/auth-schema.generated.js";
import { createDatabase } from "../src/database/database.js";
import {
  employeeApprovals,
  workspaceMemberships,
  workspaces,
} from "../src/database/identity-schema.js";
import { migrateDatabase } from "../src/database/migrate.js";
import { createIdentityService } from "../src/identity/service.js";

const apiRoot = fileURLToPath(new URL("..", import.meta.url));
const operatorExecutable = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));
const operatorScript = fileURLToPath(
  new URL("../src/operator/identity-command.ts", import.meta.url),
);
const publicOrigin = "http://localhost:5173";
const testAuthSecret = "capstone-chat-test-secret-with-more-than-thirty-two-characters";
const cleanupRole = "capstone_cleanup_operator";
const cleanupRolePassword = "capstone-cleanup-password";

interface OperatorResult {
  readonly code: number;
  readonly stderr: string;
  readonly stdout: string;
}

function parseOperatorOutput(output: string): Record<string, unknown> {
  const lines = output
    .trim()
    .split("\n")
    .filter((line) => line.length > 0);
  if (lines.length !== 1 || lines[0] === undefined) {
    throw new Error(`Expected one operator output line, received ${lines.length}`);
  }

  return JSON.parse(lines[0]) as Record<string, unknown>;
}

describe.sequential("identity operator commands", () => {
  let container: StartedPostgreSqlContainer;
  let cleanupFailureDatabaseUrl: string;
  let databaseUrl: string;
  let pool: Pool;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:18.4-alpine")
      .withDatabase("capstone_identity_operator")
      .withUsername("capstone")
      .withPassword("capstone-test-password")
      .start();
    databaseUrl = container.getConnectionUri();
    await migrateDatabase(databaseUrl);
    pool = new Pool({ connectionString: databaseUrl });
    await pool.query(`CREATE ROLE "${cleanupRole}" LOGIN PASSWORD '${cleanupRolePassword}'`);
    await pool.query(`GRANT CONNECT ON DATABASE "capstone_identity_operator" TO "${cleanupRole}"`);
    await pool.query(`GRANT USAGE ON SCHEMA public TO "${cleanupRole}"`);
    await pool.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "${cleanupRole}"`,
    );
    await pool.query(`REVOKE DELETE ON TABLE "session" FROM "${cleanupRole}"`);
    const cleanupUrl = new URL(databaseUrl);
    cleanupUrl.username = cleanupRole;
    cleanupUrl.password = cleanupRolePassword;
    cleanupFailureDatabaseUrl = cleanupUrl.href;
  });

  beforeEach(async () => {
    await pool.query(
      'TRUNCATE TABLE "rate_limit", "verification", "session", "account", "workspace_memberships", "employee_approvals", "user", "workspaces" RESTART IDENTITY CASCADE',
    );
  });

  afterAll(async () => {
    await pool.end();
    await container.stop();
  });

  function runOperator(
    argumentsList: readonly string[],
    environment: Readonly<Record<string, string>> = {},
  ): Promise<OperatorResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(operatorExecutable, [operatorScript, ...argumentsList], {
        cwd: apiRoot,
        env: {
          ...process.env,
          BETTER_AUTH_SECRET: testAuthSecret,
          DATABASE_URL: databaseUrl,
          EMAIL_DELIVERY: "fake",
          LOG_LEVEL: "silent",
          NODE_ENV: "test",
          PUBLIC_ORIGIN: publicOrigin,
          ...environment,
        },
      });
      let stdout = "";
      let stderr = "";

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.once("error", reject);
      child.once("close", (code, signal) => {
        if (signal !== null) {
          reject(new Error(`Operator command exited from signal ${signal}`));
          return;
        }

        resolve({ code: code ?? 1, stderr, stdout });
      });
    });
  }

  async function bootstrap(): Promise<OperatorResult> {
    return runOperator([
      "bootstrap",
      "--workspace",
      "capstone-ecuador",
      "--name",
      "Capstone Ecuador",
      "--email",
      "  ADMIN.OPERATOR@EXAMPLE.TEST  ",
    ]);
  }

  it("rejects an invalid approval email before mutating identity state", async () => {
    const invalid = await runOperator([
      "bootstrap",
      "--workspace",
      "capstone-ecuador",
      "--name",
      "Capstone Ecuador",
      "--email",
      "not-an-email",
    ]);

    expect(invalid.code).toBe(1);
    expect(parseOperatorOutput(invalid.stderr)).toEqual({
      errorName: "Error",
      outcome: "failed",
    });
    const database = createDatabase(pool);
    expect(await database.select().from(workspaces)).toEqual([]);
    expect(await database.select().from(employeeApprovals)).toEqual([]);
  });

  it("reports invitation delivery failure after preserving the committed approval", async () => {
    const result = await runOperator(
      [
        "bootstrap",
        "--workspace",
        "capstone-ecuador",
        "--name",
        "Capstone Ecuador",
        "--email",
        "admin.operator@example.test",
      ],
      { EMAIL_DELIVERY: "disabled" },
    );

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(parseOperatorOutput(result.stderr)).toEqual({
      errorName: "Error",
      outcome: "approval-committed",
      retrySafe: true,
    });

    const database = createDatabase(pool);
    expect(await database.select().from(workspaces)).toEqual([
      expect.objectContaining({
        displayName: "Capstone Ecuador",
        identity: "capstone-ecuador",
      }),
    ]);
    expect(await database.select().from(employeeApprovals)).toEqual([
      expect.objectContaining({
        normalizedEmail: "admin.operator@example.test",
        role: "admin",
        status: "pending",
        userId: null,
      }),
    ]);
  });

  it("serializes concurrent bootstrap retries without creating a credential", async () => {
    const results = await Promise.all([bootstrap(), bootstrap()]);

    expect(results.map(({ code }) => code)).toEqual([0, 0]);
    expect(results.map(({ stderr }) => stderr)).toEqual(["", ""]);
    const outcomes = results.map(({ stdout }) => parseOperatorOutput(stdout));
    expect(outcomes.map(({ repeated }) => String(repeated)).sort()).toEqual(["false", "true"]);
    expect(outcomes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          command: "bootstrap",
          role: "admin",
          signUpPath: "/sign-up",
          workspace: "capstone-ecuador",
        }),
      ]),
    );

    const database = createDatabase(pool);
    const workspaceRows = await database.select().from(workspaces);
    const approvalRows = await database.select().from(employeeApprovals);
    expect(workspaceRows).toHaveLength(1);
    expect(workspaceRows[0]).toMatchObject({
      displayName: "Capstone Ecuador",
      identity: "capstone-ecuador",
      timezone: "America/Guayaquil",
    });
    expect(approvalRows).toHaveLength(1);
    expect(approvalRows[0]).toMatchObject({
      normalizedEmail: "admin.operator@example.test",
      role: "admin",
      status: "pending",
      userId: null,
    });
    expect(await database.select().from(user)).toEqual([]);
    expect(await database.select().from(account)).toEqual([]);
    expect(await database.select().from(session)).toEqual([]);

    const displayNameConflict = await runOperator([
      "bootstrap",
      "--workspace",
      "capstone-ecuador",
      "--name",
      "Another Company",
      "--email",
      "admin.operator@example.test",
    ]);
    const administratorConflict = await runOperator([
      "bootstrap",
      "--workspace",
      "capstone-ecuador",
      "--name",
      "Capstone Ecuador",
      "--email",
      "different.admin@example.test",
    ]);

    for (const conflict of [displayNameConflict, administratorConflict]) {
      expect(conflict.code).toBe(1);
      expect(parseOperatorOutput(conflict.stderr)).toEqual({
        errorName: "IdentityConflictError",
        outcome: "conflict",
      });
    }
    expect(await database.select().from(workspaces)).toHaveLength(1);
    expect(await database.select().from(employeeApprovals)).toHaveLength(1);
  });

  it("makes exact concurrent approvals idempotent and rejects role or workspace conflicts", async () => {
    expect((await bootstrap()).code).toBe(0);
    const approvalArguments = [
      "approve",
      "--workspace",
      "capstone-ecuador",
      "--email",
      "  MEMBER.OPERATOR@EXAMPLE.TEST  ",
      "--role",
      "member",
    ] as const;

    const results = await Promise.all([
      runOperator(approvalArguments),
      runOperator(approvalArguments),
    ]);
    expect(results.map(({ code }) => code)).toEqual([0, 0]);
    const outcomes = results.map(({ stdout }) => parseOperatorOutput(stdout));
    expect(outcomes.map(({ repeated }) => String(repeated)).sort()).toEqual(["false", "true"]);
    expect(outcomes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          command: "approve",
          role: "member",
          signUpPath: "/sign-up",
          workspace: "capstone-ecuador",
        }),
      ]),
    );

    const database = createDatabase(pool);
    const approvals = await database.select().from(employeeApprovals);
    expect(approvals).toHaveLength(2);
    expect(
      approvals.filter(({ normalizedEmail }) => normalizedEmail === "member.operator@example.test"),
    ).toEqual([
      expect.objectContaining({
        role: "member",
        status: "pending",
        userId: null,
      }),
    ]);

    const roleConflict = await runOperator([
      "approve",
      "--workspace",
      "capstone-ecuador",
      "--email",
      "member.operator@example.test",
      "--role",
      "admin",
    ]);
    const workspaceConflict = await runOperator([
      "approve",
      "--workspace",
      "unknown-workspace",
      "--email",
      "another.operator@example.test",
      "--role",
      "member",
    ]);

    for (const conflict of [roleConflict, workspaceConflict]) {
      expect(conflict.code).toBe(1);
      expect(parseOperatorOutput(conflict.stderr)).toEqual({
        errorName: "IdentityConflictError",
        outcome: "conflict",
      });
    }
    expect(await database.select().from(employeeApprovals)).toHaveLength(2);
  });

  it("makes concurrent deactivation retries block access before revoking every session", async () => {
    expect((await bootstrap()).code).toBe(0);
    expect(
      (
        await runOperator([
          "approve",
          "--workspace",
          "capstone-ecuador",
          "--email",
          "member.operator@example.test",
          "--role",
          "member",
        ])
      ).code,
    ).toBe(0);

    const database = createDatabase(pool);
    const identity = createIdentityService(database);
    const registeredUser = {
      email: "member.operator@example.test",
      emailVerified: true,
      id: "operator-member-user",
    } as const;
    await database.insert(user).values({
      email: registeredUser.email,
      emailVerified: true,
      id: registeredUser.id,
      name: "Miembro Operador",
    });
    await identity.linkRegisteredUser(registeredUser);
    await expect(identity.activateMembership(registeredUser)).resolves.toBe("activated");

    const now = new Date();
    await database.insert(session).values([
      {
        expiresAt: new Date(now.getTime() + 60_000),
        id: "operator-session-one",
        token: "operator-session-token-one",
        updatedAt: now,
        userId: registeredUser.id,
      },
      {
        expiresAt: new Date(now.getTime() + 60_000),
        id: "operator-session-two",
        token: "operator-session-token-two",
        updatedAt: now,
        userId: registeredUser.id,
      },
    ]);

    const deactivationArguments = [
      "deactivate",
      "--workspace",
      "capstone-ecuador",
      "--email",
      "  MEMBER.OPERATOR@EXAMPLE.TEST  ",
    ] as const;
    const results = await Promise.all([
      runOperator(deactivationArguments),
      runOperator(deactivationArguments),
    ]);

    expect(results.map(({ code }) => code)).toEqual([0, 0]);
    const outcomes = results.map(({ stdout }) => parseOperatorOutput(stdout));
    expect(outcomes.map(({ alreadyRevoked }) => String(alreadyRevoked)).sort()).toEqual([
      "false",
      "true",
    ]);
    expect(outcomes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          command: "deactivate",
          outcome: "access-blocked",
          workspace: "capstone-ecuador",
        }),
      ]),
    );

    const approvalRows = await database.select().from(employeeApprovals);
    const memberApproval = approvalRows.find(
      ({ normalizedEmail }) => normalizedEmail === registeredUser.email,
    );
    const membershipRows = await database.select().from(workspaceMemberships);
    expect(memberApproval).toMatchObject({ status: "revoked", userId: registeredUser.id });
    expect(memberApproval?.revokedAt).toBeInstanceOf(Date);
    expect(membershipRows).toEqual([
      expect.objectContaining({
        role: "member",
        status: "deactivated",
        userId: registeredUser.id,
      }),
    ]);
    expect(membershipRows[0]?.deactivatedAt).toBeInstanceOf(Date);
    expect(await database.select().from(session)).toEqual([]);
    await expect(identity.canSignIn(registeredUser.email)).resolves.toBe(false);
    await expect(identity.activateMembership(registeredUser)).resolves.toBe("blocked");

    const exactRetry = await runOperator(deactivationArguments);
    expect(exactRetry.code).toBe(0);
    expect(parseOperatorOutput(exactRetry.stdout)).toMatchObject({ alreadyRevoked: true });

    const approveAfterRevocation = await runOperator([
      "approve",
      "--workspace",
      "capstone-ecuador",
      "--email",
      registeredUser.email,
      "--role",
      "member",
    ]);
    expect(approveAfterRevocation.code).toBe(1);
    expect(parseOperatorOutput(approveAfterRevocation.stderr)).toMatchObject({
      errorName: "IdentityConflictError",
      outcome: "conflict",
    });

    const output = results.map(({ stderr, stdout }) => `${stdout}${stderr}`).join("\n");
    expect(output).not.toContain(registeredUser.email);
    expect(output).not.toContain("operator-session-token");
  });

  it("reports incomplete cleanup after access is durably blocked", async () => {
    expect((await bootstrap()).code).toBe(0);
    expect(
      (
        await runOperator([
          "approve",
          "--workspace",
          "capstone-ecuador",
          "--email",
          "cleanup.operator@example.test",
          "--role",
          "member",
        ])
      ).code,
    ).toBe(0);

    const database = createDatabase(pool);
    const identity = createIdentityService(database);
    const registeredUser = {
      email: "cleanup.operator@example.test",
      emailVerified: true,
      id: "cleanup-operator-user",
    } as const;
    await database.insert(user).values({
      email: registeredUser.email,
      emailVerified: true,
      id: registeredUser.id,
      name: "Miembro de Limpieza",
    });
    await identity.linkRegisteredUser(registeredUser);
    await expect(identity.activateMembership(registeredUser)).resolves.toBe("activated");
    await database.insert(session).values({
      expiresAt: new Date(Date.now() + 60_000),
      id: "cleanup-session",
      token: "cleanup-session-token",
      updatedAt: new Date(),
      userId: registeredUser.id,
    });

    const result = await runOperator(
      ["deactivate", "--workspace", "capstone-ecuador", "--email", registeredUser.email],
      { DATABASE_URL: cleanupFailureDatabaseUrl },
    );

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(parseOperatorOutput(result.stderr)).toEqual({
      errorName: "Error",
      outcome: "access-blocked-cleanup-incomplete",
      retrySafe: true,
    });
    expect(await database.select().from(employeeApprovals)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          normalizedEmail: registeredUser.email,
          status: "revoked",
          userId: registeredUser.id,
        }),
      ]),
    );
    expect(await database.select().from(workspaceMemberships)).toEqual([
      expect.objectContaining({
        status: "deactivated",
        userId: registeredUser.id,
      }),
    ]);
    expect(await database.select().from(session)).toHaveLength(1);
    await expect(identity.canSignIn(registeredUser.email)).resolves.toBe(false);
    expect(`${result.stdout}${result.stderr}`).not.toContain(registeredUser.email);
    expect(`${result.stdout}${result.stderr}`).not.toContain("cleanup-session-token");
  });
});

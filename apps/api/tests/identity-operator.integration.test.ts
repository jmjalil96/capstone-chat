import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { account, session, user } from "../src/database/auth-schema.generated.js";
import { conversationCompactions } from "../src/database/compaction-schema.js";
import { conversations, messages } from "../src/database/conversation-schema.js";
import { createDatabase } from "../src/database/database.js";
import { generations } from "../src/database/generation-schema.js";
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

  async function seedActiveWork(
    database: ReturnType<typeof createDatabase>,
    workspaceId: string,
    userId: string,
  ): Promise<{
    readonly chatConversationId: string;
    readonly chatGenerationId: string;
    readonly compactionGenerationId: string;
  }> {
    async function seedConversation(title: string) {
      const conversationRows = await database
        .insert(conversations)
        .values({ title, userId, workspaceId })
        .returning({ id: conversations.id });
      const conversationId = conversationRows[0]?.id;
      if (conversationId === undefined) {
        throw new Error("The operator work fixture conversation was not created");
      }
      const userMessageRows = await database
        .insert(messages)
        .values({
          content: [{ text: "Private operator cancellation fixture", type: "text" }],
          conversationId,
          role: "user",
        })
        .returning({ id: messages.id });
      const userMessageId = userMessageRows[0]?.id;
      if (userMessageId === undefined) {
        throw new Error("The operator work fixture message was not created");
      }
      return { conversationId, userMessageId };
    }

    const chat = await seedConversation("Operator chat cancellation fixture");
    const assistantRows = await database
      .insert(messages)
      .values({
        content: [{ text: "", type: "text" }],
        conversationId: chat.conversationId,
        parentMessageId: chat.userMessageId,
        role: "assistant",
      })
      .returning({ id: messages.id });
    const assistantMessageId = assistantRows[0]?.id;
    if (assistantMessageId === undefined) {
      throw new Error("The operator work fixture assistant message was not created");
    }
    await database
      .update(conversations)
      .set({ selectedLeafMessageId: assistantMessageId })
      .where(eq(conversations.id, chat.conversationId));
    const chatGenerationRows = await database
      .insert(generations)
      .values({
        assistantMessageId,
        conversationId: chat.conversationId,
        effectiveParameters: {},
        idempotencyKey: randomUUID(),
        purpose: "chat",
        requestedTier: "balanced",
        status: "active",
        systemPromptVersion: "capstone-chat-v1",
        userId,
        workspaceId,
      })
      .returning({ id: generations.id });
    const chatGenerationId = chatGenerationRows[0]?.id;
    if (chatGenerationId === undefined) {
      throw new Error("The operator chat generation was not created");
    }

    const compaction = await seedConversation("Operator compaction cancellation fixture");
    await database
      .update(conversations)
      .set({ selectedLeafMessageId: compaction.userMessageId })
      .where(eq(conversations.id, compaction.conversationId));
    const compactionGenerationRows = await database
      .insert(generations)
      .values({
        conversationId: compaction.conversationId,
        effectiveParameters: {},
        idempotencyKey: randomUUID(),
        purpose: "compaction",
        requestedTier: "balanced",
        status: "active",
        systemPromptVersion: "capstone-compaction-v1",
        userId,
        workspaceId,
      })
      .returning({ id: generations.id });
    const compactionGenerationId = compactionGenerationRows[0]?.id;
    if (compactionGenerationId === undefined) {
      throw new Error("The operator compaction generation was not created");
    }
    await database.insert(conversationCompactions).values({
      conversationId: compaction.conversationId,
      generationId: compactionGenerationId,
      modelUsed: "fixture/compaction-model",
      promptVersion: "capstone-compaction-v1",
      status: "active",
      throughMessageId: compaction.userMessageId,
      userId,
      workspaceId,
    });
    return {
      chatConversationId: chat.conversationId,
      chatGenerationId,
      compactionGenerationId,
    };
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

  it("bootstraps only a pending synthetic initialization approval when delivery is disabled", async () => {
    const result = await runOperator(
      [
        "bootstrap",
        "--workspace",
        "capstone-ecuador",
        "--name",
        "Capstone Ecuador",
        "--email",
        "admin.operator@example.test",
        "--invitation-delivery",
        "disabled",
      ],
      { EMAIL_DELIVERY: "disabled" },
    );

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(parseOperatorOutput(result.stdout)).toEqual({
      command: "bootstrap",
      invitationDelivery: "disabled",
      repeated: false,
      role: "admin",
      signUpPath: "/sign-up",
      workspace: "capstone-ecuador",
    });

    const database = createDatabase(pool);
    expect(await database.select().from(employeeApprovals)).toEqual([
      expect.objectContaining({
        normalizedEmail: "admin.operator@example.test",
        role: "admin",
        status: "pending",
        userId: null,
      }),
    ]);
    expect(await database.select().from(user)).toEqual([]);
    expect(await database.select().from(account)).toEqual([]);
    expect(await database.select().from(session)).toEqual([]);
  });

  it("rejects a real administrator email before mutating the synthetic identity", async () => {
    const result = await runOperator(
      [
        "bootstrap",
        "--workspace",
        "capstone-ecuador",
        "--name",
        "Capstone Ecuador",
        "--email",
        "administrator@capstone.com.ec",
        "--invitation-delivery",
        "disabled",
      ],
      { EMAIL_DELIVERY: "disabled" },
    );

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(parseOperatorOutput(result.stderr)).toEqual({
      errorName: "Error",
      outcome: "failed",
    });
    const database = createDatabase(pool);
    expect(await database.select().from(workspaces)).toEqual([]);
    expect(await database.select().from(employeeApprovals)).toEqual([]);
  });

  it("rejects the no-delivery bootstrap fence outside disabled test delivery", async () => {
    const result = await runOperator([
      "bootstrap",
      "--workspace",
      "capstone-ecuador",
      "--name",
      "Capstone Ecuador",
      "--email",
      "admin.operator@example.test",
      "--invitation-delivery",
      "disabled",
    ]);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(parseOperatorOutput(result.stderr)).toEqual({
      errorName: "Error",
      outcome: "failed",
    });
    expect(await createDatabase(pool).select().from(workspaces)).toEqual([]);
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

  it("makes exact concurrent approvals idempotent, corrects pending roles, and rejects workspace conflicts", async () => {
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

    const roleCorrection = await runOperator([
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

    expect(roleCorrection.code).toBe(0);
    expect(parseOperatorOutput(roleCorrection.stdout)).toMatchObject({
      command: "approve",
      repeated: true,
      role: "admin",
    });
    expect(workspaceConflict.code).toBe(1);
    expect(parseOperatorOutput(workspaceConflict.stderr)).toEqual({
      errorName: "IdentityConflictError",
      outcome: "conflict",
    });
    expect(await database.select().from(employeeApprovals)).toHaveLength(2);
    expect(
      (await database.select().from(employeeApprovals)).find(
        ({ normalizedEmail }) => normalizedEmail === "member.operator@example.test",
      )?.role,
    ).toBe("admin");
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
    const workspace = (await database.select().from(workspaces))[0];
    if (workspace === undefined) {
      throw new Error("The operator workspace fixture is unavailable");
    }
    const activeWork = await seedActiveWork(database, workspace.id, registeredUser.id);

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
    expect(
      await database.select({ id: generations.id, status: generations.status }).from(generations),
    ).toEqual(
      expect.arrayContaining([
        { id: activeWork.chatGenerationId, status: "cancelled" },
        { id: activeWork.compactionGenerationId, status: "cancelled" },
      ]),
    );
    expect(await database.select().from(conversationCompactions)).toEqual([
      expect.objectContaining({
        generationId: activeWork.compactionGenerationId,
        status: "cancelled",
      }),
    ]);
    expect(
      await database
        .select({ revision: conversations.revision })
        .from(conversations)
        .where(eq(conversations.id, activeWork.chatConversationId)),
    ).toEqual([{ revision: 1 }]);
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

  it("serializes operator deactivation so concurrent commands retain one active administrator", async () => {
    expect((await bootstrap()).code).toBe(0);
    expect(
      (
        await runOperator([
          "approve",
          "--workspace",
          "capstone-ecuador",
          "--email",
          "second.admin@example.test",
          "--role",
          "admin",
        ])
      ).code,
    ).toBe(0);

    const database = createDatabase(pool);
    const identity = createIdentityService(database);
    const administratorFixtures = [
      {
        email: "admin.operator@example.test",
        emailVerified: true,
        id: "operator-first-admin",
      },
      {
        email: "second.admin@example.test",
        emailVerified: true,
        id: "operator-second-admin",
      },
    ] as const;
    for (const administrator of administratorFixtures) {
      await database.insert(user).values({
        ...administrator,
        name: `Administrator ${administrator.id}`,
      });
      await identity.linkRegisteredUser(administrator);
      await expect(identity.activateMembership(administrator)).resolves.toBe("activated");
    }

    const results = await Promise.all(
      administratorFixtures.map((administrator) =>
        runOperator([
          "deactivate",
          "--workspace",
          "capstone-ecuador",
          "--email",
          administrator.email,
        ]),
      ),
    );
    expect(results.map(({ code }) => code).sort()).toEqual([0, 1]);
    expect(
      results.filter(({ code }) => code === 1).map(({ stderr }) => parseOperatorOutput(stderr)),
    ).toEqual([
      expect.objectContaining({
        errorName: "EmployeeAdministrationConflictError",
        outcome: "conflict",
      }),
    ]);
    expect(
      (await database.select().from(workspaceMemberships)).map(({ status }) => status).sort(),
    ).toEqual(["active", "deactivated"]);
    expect(
      (await database.select().from(employeeApprovals)).filter(
        ({ role, status }) => role === "admin" && status === "activated",
      ),
    ).toHaveLength(1);
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

    const retry = await runOperator([
      "deactivate",
      "--workspace",
      "capstone-ecuador",
      "--email",
      registeredUser.email,
    ]);
    expect(retry.code).toBe(0);
    expect(parseOperatorOutput(retry.stdout)).toMatchObject({
      alreadyRevoked: true,
      outcome: "access-blocked",
    });
    expect(await database.select().from(session)).toEqual([]);
  });
});

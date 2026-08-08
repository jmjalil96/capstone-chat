import { randomUUID } from "node:crypto";
import { ADMIN_LIST_PAGE_SIZE } from "@capstone/protocol";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createCursorCodec } from "../src/conversations/cursor.js";
import { user } from "../src/database/auth-schema.generated.js";
import { conversationCompactions } from "../src/database/compaction-schema.js";
import { conversations, messages } from "../src/database/conversation-schema.js";
import { type AppDatabase, createDatabase } from "../src/database/database.js";
import { generations } from "../src/database/generation-schema.js";
import {
  employeeApprovals,
  workspaceMemberships,
  workspaces,
} from "../src/database/identity-schema.js";
import { migrateDatabase } from "../src/database/migrate.js";
import { createGenerationAdministrationService } from "../src/generations/administration.js";
import {
  createEmployeeAdministrationService,
  EmployeeAdministrationConflictError,
} from "../src/identity/administration.js";
import { createIdentityService } from "../src/identity/service.js";
import {
  type WorkspaceBudgetPeriod,
  workspaceBudgetPeriod,
} from "../src/model-policy/budget-period.js";
import { createBudgetService } from "../src/model-policy/budget-service.js";
import { createModelPolicyService } from "../src/model-policy/service.js";
import { createUsageService } from "../src/model-policy/usage-service.js";
import { bootstrapSimulatedModelPolicy } from "./support/model-policy.js";

const cursorSecret = "phase-seven-administration-integration-secret";

interface EmployeeFixture {
  readonly approvalId: string;
  readonly email: string;
  readonly userId: string;
}

interface ConversationFixture {
  readonly assistantMessageId: string;
  readonly conversationId: string;
  readonly userMessageId: string;
}

type GenerationInsert = typeof generations.$inferInsert;

describe.sequential("employee and usage administration integration", () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let database: AppDatabase;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:18.4-alpine")
      .withDatabase("capstone_admin_employees_usage")
      .withUsername("capstone")
      .withPassword("capstone-test-password")
      .start();
    await migrateDatabase(container.getConnectionUri());
    pool = new Pool({ connectionString: container.getConnectionUri() });
    database = createDatabase(pool);
  });

  beforeEach(async () => {
    await pool.query(
      'TRUNCATE TABLE "conversation_compactions", "generations", "drafts", "messages", "conversations", "workspace_memberships", "employee_approvals", "user", "workspaces", "model_catalog" RESTART IDENTITY CASCADE',
    );
  });

  afterAll(async () => {
    await pool.end();
    await container.stop();
  });

  async function seedWorkspace(identity: string): Promise<string> {
    const rows = await database
      .insert(workspaces)
      .values({ displayName: `Workspace ${identity}`, identity, timezone: "America/Guayaquil" })
      .returning({ id: workspaces.id });
    const workspaceId = rows[0]?.id;
    if (workspaceId === undefined) {
      throw new Error("Workspace fixture was not created");
    }
    return workspaceId;
  }

  async function seedActivatedEmployee(input: {
    readonly email: string;
    readonly monthlySoftBudgetUsd?: string | null;
    readonly name: string;
    readonly role: "admin" | "member";
    readonly workspaceId: string;
  }): Promise<EmployeeFixture> {
    const now = new Date();
    const userId = `user-${randomUUID()}`;
    await database.insert(user).values({
      email: input.email,
      emailVerified: true,
      id: userId,
      name: input.name,
    });
    const approvalRows = await database
      .insert(employeeApprovals)
      .values({
        activatedAt: now,
        normalizedEmail: input.email,
        role: input.role,
        status: "activated",
        userId,
        workspaceId: input.workspaceId,
      })
      .returning({ id: employeeApprovals.id });
    const approvalId = approvalRows[0]?.id;
    if (approvalId === undefined) {
      throw new Error("Employee approval fixture was not created");
    }
    await database.insert(workspaceMemberships).values({
      activatedAt: now,
      monthlySoftBudgetUsd: input.monthlySoftBudgetUsd ?? null,
      role: input.role,
      status: "active",
      userId,
      workspaceId: input.workspaceId,
    });
    return { approvalId, email: input.email, userId };
  }

  async function seedConversation(input: {
    readonly revision?: number;
    readonly title: string;
    readonly userId: string;
    readonly userText: string;
    readonly workspaceId: string;
  }): Promise<ConversationFixture> {
    const conversationRows = await database
      .insert(conversations)
      .values({
        revision: input.revision ?? 0,
        title: input.title,
        userId: input.userId,
        workspaceId: input.workspaceId,
      })
      .returning({ id: conversations.id });
    const conversationId = conversationRows[0]?.id;
    if (conversationId === undefined) {
      throw new Error("Conversation fixture was not created");
    }
    const userMessageRows = await database
      .insert(messages)
      .values({
        content: [{ text: input.userText, type: "text" }],
        conversationId,
        parentMessageId: null,
        role: "user",
      })
      .returning({ id: messages.id });
    const userMessageId = userMessageRows[0]?.id;
    if (userMessageId === undefined) {
      throw new Error("User-message fixture was not created");
    }
    const assistantMessageRows = await database
      .insert(messages)
      .values({
        content: [{ text: "", type: "text" }],
        conversationId,
        parentMessageId: userMessageId,
        role: "assistant",
      })
      .returning({ id: messages.id });
    const assistantMessageId = assistantMessageRows[0]?.id;
    if (assistantMessageId === undefined) {
      throw new Error("Assistant-message fixture was not created");
    }
    await database
      .update(conversations)
      .set({ selectedLeafMessageId: assistantMessageId })
      .where(eq(conversations.id, conversationId));
    return { assistantMessageId, conversationId, userMessageId };
  }

  function accountingSnapshot(
    period: WorkspaceBudgetPeriod,
    startedAt: Date,
    reservedCostUsd: string,
  ) {
    return {
      budgetPeriodEnd: period.end,
      budgetPeriodStart: period.start,
      completionPriceCeilingPerToken: "0",
      estimatedInputTokens: 10n,
      maximumOutputTokens: 100,
      promptPriceCeilingPerToken: "0",
      requestPriceCeilingUsd: "0",
      reservationExpiresAt: new Date(startedAt.getTime() + 3_600_000),
      reservationMarginBasisPoints: 0,
      reservedCostUsd,
    } as const;
  }

  async function seedGeneration(values: GenerationInsert): Promise<string> {
    const rows = await database
      .insert(generations)
      .values(values)
      .returning({ id: generations.id });
    const generationId = rows[0]?.id;
    if (generationId === undefined) {
      throw new Error("Generation fixture was not created");
    }
    return generationId;
  }

  it("keeps employee keyset pages and cursors bound to one workspace", async () => {
    const firstWorkspaceId = await seedWorkspace("employees-first");
    const secondWorkspaceId = await seedWorkspace("employees-second");
    await database.insert(employeeApprovals).values(
      Array.from({ length: ADMIN_LIST_PAGE_SIZE + 1 }, (_, index) => ({
        normalizedEmail: `employee-${String(index).padStart(3, "0")}@example.test`,
        role: "member" as const,
        workspaceId: firstWorkspaceId,
      })),
    );
    await database.insert(employeeApprovals).values({
      normalizedEmail: "aaa-foreign@example.test",
      role: "admin",
      workspaceId: secondWorkspaceId,
    });
    const employees = createEmployeeAdministrationService(
      database,
      createCursorCodec(cursorSecret),
    );

    const firstPage = await employees.list(firstWorkspaceId);
    expect(firstPage.items).toHaveLength(ADMIN_LIST_PAGE_SIZE);
    expect(firstPage.items.at(0)?.email).toBe("employee-000@example.test");
    expect(firstPage.items.at(-1)?.email).toBe("employee-049@example.test");
    expect(firstPage.items).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ email: "aaa-foreign@example.test" })]),
    );
    expect(firstPage.nextCursor).not.toBeNull();

    const secondPage = await employees.list(firstWorkspaceId, firstPage.nextCursor ?? undefined);
    expect(secondPage).toEqual({
      items: [expect.objectContaining({ email: "employee-050@example.test", status: "pending" })],
      nextCursor: null,
    });
    await expect(
      employees.list(secondWorkspaceId, firstPage.nextCursor ?? undefined),
    ).rejects.toMatchObject({ code: "INVALID_CURSOR", statusCode: 400 });
    await expect(employees.list(secondWorkspaceId)).resolves.toMatchObject({
      items: [expect.objectContaining({ email: "aaa-foreign@example.test" })],
      nextCursor: null,
    });
  });

  it("binds usage cursors to the exact current budget period", async () => {
    const workspaceIdentity = "usage-period-cursor";
    const workspaceId = await seedWorkspace(workspaceIdentity);
    await bootstrapSimulatedModelPolicy(createModelPolicyService(database), workspaceIdentity);
    const employeeFixtures = Array.from({ length: ADMIN_LIST_PAGE_SIZE + 1 }, (_, index) => ({
      email: `usage-cursor-${String(index).padStart(3, "0")}@example.test`,
      id: `usage-cursor-user-${index}`,
      name: `Usage Cursor ${index}`,
    }));
    await database.insert(user).values(
      employeeFixtures.map((employee) => ({
        email: employee.email,
        emailVerified: true,
        id: employee.id,
        name: employee.name,
      })),
    );
    await database.insert(workspaceMemberships).values(
      employeeFixtures.map((employee) => ({
        role: "member" as const,
        userId: employee.id,
        workspaceId,
      })),
    );
    const clock = { value: new Date("2026-09-01T04:59:59.000Z") };
    const usage = createUsageService(database, createCursorCodec(cursorSecret), {
      now: () => clock.value,
    });

    const firstPage = await usage.currentMonth(workspaceId);
    expect(firstPage.items).toHaveLength(ADMIN_LIST_PAGE_SIZE);
    expect(firstPage.period).toMatchObject({
      start: "2026-08-01T05:00:00.000Z",
      timezone: "America/Guayaquil",
    });
    if (firstPage.nextCursor === null) {
      throw new Error("Usage pagination cursor fixture was not created");
    }
    await expect(usage.currentMonth(workspaceId, firstPage.nextCursor)).resolves.toMatchObject({
      items: [
        {
          employee: { email: "usage-cursor-050@example.test" },
        },
      ],
      nextCursor: null,
    });

    clock.value = new Date("2026-09-01T05:00:01.000Z");
    await expect(usage.currentMonth(workspaceId, firstPage.nextCursor)).rejects.toMatchObject({
      code: "INVALID_CURSOR",
      statusCode: 400,
    });
  });

  it("corrects only pending roles and returns the corrected invitation target", async () => {
    const workspaceIdentity = "pending-role-correction";
    const workspaceId = await seedWorkspace(workspaceIdentity);
    const identity = createIdentityService(database);
    const employees = createEmployeeAdministrationService(
      database,
      createCursorCodec(cursorSecret),
    );

    const initial = await identity.approve({
      email: "  PENDING.EMPLOYEE@EXAMPLE.TEST  ",
      role: "member",
      workspaceIdentity,
    });
    const corrected = await identity.approve({
      email: "pending.employee@example.test",
      role: "admin",
      workspaceIdentity,
    });

    expect(corrected).toMatchObject({
      approvalId: initial.approvalId,
      repeated: true,
      role: "admin",
      workspaceId,
    });
    await expect(
      employees.pendingInvitationTarget(workspaceId, initial.approvalId),
    ).resolves.toEqual({ email: "pending.employee@example.test", role: "admin" });
  });

  it("rejects pending soft budgets while allowing active and deactivated memberships", async () => {
    const workspaceId = await seedWorkspace("soft-budget-rules");
    const actor = await seedActivatedEmployee({
      email: "budget-admin@example.test",
      name: "Budget Admin",
      role: "admin",
      workspaceId,
    });
    const active = await seedActivatedEmployee({
      email: "budget-member@example.test",
      name: "Budget Member",
      role: "member",
      workspaceId,
    });
    const pendingRows = await database
      .insert(employeeApprovals)
      .values({
        normalizedEmail: "budget-pending@example.test",
        role: "member",
        workspaceId,
      })
      .returning({ id: employeeApprovals.id });
    const pendingApprovalId = pendingRows[0]?.id;
    if (pendingApprovalId === undefined) {
      throw new Error("Pending approval fixture was not created");
    }
    const employees = createEmployeeAdministrationService(
      database,
      createCursorCodec(cursorSecret),
    );

    await expect(
      employees.setSoftBudget(workspaceId, pendingApprovalId, "5"),
    ).rejects.toBeInstanceOf(EmployeeAdministrationConflictError);
    await expect(
      employees.setSoftBudget(workspaceId, active.approvalId, "25.5"),
    ).resolves.toMatchObject({
      monthlySoftBudgetUsd: "25.5",
      status: "active",
    });

    await expect(
      employees.deactivate({
        actorUserId: actor.userId,
        approvalId: active.approvalId,
        workspaceId,
      }),
    ).resolves.toMatchObject({ employee: { status: "deactivated" }, repeated: false });
    await expect(
      employees.setSoftBudget(workspaceId, active.approvalId, "30"),
    ).resolves.toMatchObject({
      monthlySoftBudgetUsd: "30",
      status: "deactivated",
    });
  });

  it("rejects self-deactivation and protects the final active administrator", async () => {
    const selfWorkspaceId = await seedWorkspace("self-deactivation");
    const self = await seedActivatedEmployee({
      email: "self-admin@example.test",
      name: "Self Admin",
      role: "admin",
      workspaceId: selfWorkspaceId,
    });
    const finalWorkspaceId = await seedWorkspace("final-admin");
    const finalAdmin = await seedActivatedEmployee({
      email: "final-admin@example.test",
      name: "Final Admin",
      role: "admin",
      workspaceId: finalWorkspaceId,
    });
    const employees = createEmployeeAdministrationService(
      database,
      createCursorCodec(cursorSecret),
    );

    await expect(
      employees.deactivate({
        actorUserId: self.userId,
        approvalId: self.approvalId,
        workspaceId: selfWorkspaceId,
      }),
    ).rejects.toBeInstanceOf(EmployeeAdministrationConflictError);
    await expect(
      employees.deactivate({
        actorUserId: "authenticated-admin-race-fixture",
        approvalId: finalAdmin.approvalId,
        workspaceId: finalWorkspaceId,
      }),
    ).rejects.toBeInstanceOf(EmployeeAdministrationConflictError);
    await expect(employees.get(selfWorkspaceId, self.approvalId)).resolves.toMatchObject({
      status: "active",
    });
    await expect(employees.get(finalWorkspaceId, finalAdmin.approvalId)).resolves.toMatchObject({
      status: "active",
    });
  });

  it("releases a preparing chat reservation at zero and revises its conversation exactly once", async () => {
    const workspaceIdentity = "preparing-cancellation";
    const workspaceId = await seedWorkspace(workspaceIdentity);
    const actor = await seedActivatedEmployee({
      email: "cancel-admin@example.test",
      name: "Cancel Admin",
      role: "admin",
      workspaceId,
    });
    const target = await seedActivatedEmployee({
      email: "cancel-member@example.test",
      name: "Cancel Member",
      role: "member",
      workspaceId,
    });
    await bootstrapSimulatedModelPolicy(createModelPolicyService(database), workspaceIdentity, {
      monthlyBudgetUsd: "100",
    });
    const conversation = await seedConversation({
      revision: 1,
      title: "Preparing cancellation fixture",
      userId: target.userId,
      userText: "Preparing message fixture",
      workspaceId,
    });
    const startedAt = new Date(Date.now() - 60_000);
    const period = await workspaceBudgetPeriod(database, workspaceId, startedAt);
    if (period === null) {
      throw new Error("Budget period fixture was not created");
    }
    const generationId = await seedGeneration({
      ...accountingSnapshot(period, startedAt, "4"),
      accountingStatus: "reserved",
      assistantMessageId: conversation.assistantMessageId,
      conversationId: conversation.conversationId,
      createdAt: startedAt,
      effectiveParameters: { context: { mode: "pending" } },
      idempotencyKey: randomUUID(),
      purpose: "chat",
      requestedModel: "fixture/chat-model",
      requestedTier: "balanced",
      resolvedModel: "fixture/chat-model",
      startedAt,
      status: "preparing",
      systemPromptVersion: "capstone-chat-v1",
      updatedAt: startedAt,
      userId: target.userId,
      workspaceId,
    });
    const employees = createEmployeeAdministrationService(
      database,
      createCursorCodec(cursorSecret),
    );
    const generationAdministration = createGenerationAdministrationService(
      database,
      createBudgetService(database),
    );

    await employees.deactivate({
      actorUserId: actor.userId,
      approvalId: target.approvalId,
      workspaceId,
    });
    await expect(
      generationAdministration.cancelEmployeeWork(workspaceId, target.userId),
    ).resolves.toEqual([generationId]);
    await expect(
      generationAdministration.cancelEmployeeWork(workspaceId, target.userId),
    ).resolves.toEqual([]);

    await expect(
      database.select().from(generations).where(eq(generations.id, generationId)),
    ).resolves.toMatchObject([
      {
        accountingStatus: "actual",
        completionTokens: 0n,
        costBasis: "actual",
        costUsd: "0.000000000000000000",
        promptTokens: 0n,
        status: "cancelled",
        terminalReason: "cancelled",
      },
    ]);
    await expect(
      database
        .select({ revision: conversations.revision })
        .from(conversations)
        .where(eq(conversations.id, conversation.conversationId)),
    ).resolves.toEqual([{ revision: 2 }]);
    await expect(
      createUsageService(database, createCursorCodec(cursorSecret), {
        now: () => startedAt,
      }).currentMonth(workspaceId),
    ).resolves.toMatchObject({
      budget: { actualCostUsd: "0", remainingUsd: "100", reservedCostUsd: "0" },
    });
  });

  it("groups only current-month accounting and exposes no conversation content", async () => {
    const at = new Date("2026-08-08T12:00:00.000Z");
    const settledAt = new Date("2026-08-08T12:01:00.000Z");
    const workspaceIdentity = "usage-current-month";
    const workspaceId = await seedWorkspace(workspaceIdentity);
    const employee = await seedActivatedEmployee({
      email: "usage-member@example.test",
      monthlySoftBudgetUsd: "6",
      name: "Usage Member",
      role: "member",
      workspaceId,
    });
    await bootstrapSimulatedModelPolicy(createModelPolicyService(database), workspaceIdentity, {
      monthlyBudgetUsd: "100",
    });
    const period = await workspaceBudgetPeriod(database, workspaceId, at);
    if (period === null) {
      throw new Error("Current usage period fixture was not created");
    }
    const privateTitle = "PRIVATE_TITLE_SENTINEL";
    const privateMessage = "PRIVATE_MESSAGE_SENTINEL";
    const privateSummary = "PRIVATE_SUMMARY_SENTINEL";
    const accountedConversation = await seedConversation({
      title: privateTitle,
      userId: employee.userId,
      userText: privateMessage,
      workspaceId,
    });
    const reservedConversation = await seedConversation({
      title: "Reserved usage fixture",
      userId: employee.userId,
      userText: "Reserved message fixture",
      workspaceId,
    });
    await seedGeneration({
      ...accountingSnapshot(period, at, "1"),
      accountingSettledAt: settledAt,
      accountingStatus: "actual",
      assistantMessageId: accountedConversation.assistantMessageId,
      cachedTokens: 3n,
      completedAt: settledAt,
      completionTokens: 7n,
      conversationId: accountedConversation.conversationId,
      costBasis: "actual",
      costUsd: "1",
      createdAt: at,
      effectiveParameters: {},
      idempotencyKey: randomUUID(),
      promptTokens: 11n,
      provider: "fixture-provider",
      purpose: "chat",
      reasoningTokens: 2n,
      requestedModel: "fixture/chat-model",
      requestedTier: "fast",
      resolvedModel: "fixture/chat-model",
      startedAt: at,
      status: "completed",
      systemPromptVersion: "capstone-chat-v1",
      terminalReason: "stop",
      updatedAt: settledAt,
      userId: employee.userId,
      workspaceId,
    });
    const compactionGenerationId = await seedGeneration({
      ...accountingSnapshot(period, at, "2"),
      accountingSettledAt: settledAt,
      accountingStatus: "estimated",
      cachedTokens: 0n,
      completedAt: settledAt,
      completionTokens: 6n,
      conversationId: accountedConversation.conversationId,
      costBasis: "estimated",
      costUsd: "2",
      createdAt: at,
      effectiveParameters: {},
      errorCode: "STREAM_INTERRUPTED",
      idempotencyKey: randomUUID(),
      promptTokens: 5n,
      purpose: "compaction",
      reasoningTokens: 0n,
      requestedModel: "fixture/compaction-model",
      requestedTier: "pro",
      resolvedModel: "fixture/compaction-model",
      startedAt: at,
      status: "incomplete",
      systemPromptVersion: "capstone-compaction-v1",
      terminalReason: "error",
      updatedAt: settledAt,
      userId: employee.userId,
      workspaceId,
    });
    await database.insert(conversationCompactions).values({
      completedAt: settledAt,
      conversationId: accountedConversation.conversationId,
      createdAt: at,
      generationId: compactionGenerationId,
      modelUsed: "fixture/compaction-model",
      promptVersion: "capstone-compaction-v1",
      sourceTokenCount: 20n,
      status: "completed",
      summary: privateSummary,
      summaryTokenCount: 4n,
      throughMessageId: accountedConversation.userMessageId,
      updatedAt: settledAt,
      userId: employee.userId,
      workspaceId,
    });
    await seedGeneration({
      ...accountingSnapshot(period, at, "3"),
      accountingStatus: "reserved",
      assistantMessageId: reservedConversation.assistantMessageId,
      conversationId: reservedConversation.conversationId,
      createdAt: at,
      effectiveParameters: {},
      idempotencyKey: randomUUID(),
      purpose: "chat",
      requestedModel: "fixture/reserved-model",
      requestedTier: "balanced",
      resolvedModel: "fixture/reserved-model",
      startedAt: at,
      status: "active",
      systemPromptVersion: "capstone-chat-v1",
      updatedAt: at,
      userId: employee.userId,
      workspaceId,
    });
    const previousPeriod = {
      end: period.start,
      start: new Date("2026-07-01T05:00:00.000Z"),
    } satisfies WorkspaceBudgetPeriod;
    await seedGeneration({
      ...accountingSnapshot(previousPeriod, at, "80"),
      accountingSettledAt: settledAt,
      accountingStatus: "actual",
      cachedTokens: 0n,
      completedAt: settledAt,
      completionTokens: 1n,
      costBasis: "actual",
      costUsd: "80",
      createdAt: at,
      effectiveParameters: {},
      idempotencyKey: randomUUID(),
      promptTokens: 1n,
      provider: "fixture-provider",
      purpose: "chat",
      reasoningTokens: 0n,
      requestedModel: "fixture/old-model",
      requestedTier: "fast",
      resolvedModel: "fixture/old-model",
      startedAt: at,
      status: "completed",
      systemPromptVersion: "capstone-chat-v1",
      terminalReason: "stop",
      updatedAt: settledAt,
      userId: employee.userId,
      workspaceId,
    });
    const foreignWorkspaceId = await seedWorkspace("usage-foreign");
    const foreignEmployee = await seedActivatedEmployee({
      email: "usage-foreign@example.test",
      name: "Foreign Usage",
      role: "member",
      workspaceId: foreignWorkspaceId,
    });
    await seedGeneration({
      ...accountingSnapshot(period, at, "90"),
      accountingSettledAt: settledAt,
      accountingStatus: "actual",
      cachedTokens: 0n,
      completedAt: settledAt,
      completionTokens: 1n,
      costBasis: "actual",
      costUsd: "90",
      createdAt: at,
      effectiveParameters: {},
      idempotencyKey: randomUUID(),
      promptTokens: 1n,
      provider: "fixture-provider",
      purpose: "chat",
      reasoningTokens: 0n,
      requestedModel: "fixture/foreign-model",
      requestedTier: "fast",
      resolvedModel: "fixture/foreign-model",
      startedAt: at,
      status: "completed",
      systemPromptVersion: "capstone-chat-v1",
      terminalReason: "stop",
      updatedAt: settledAt,
      userId: foreignEmployee.userId,
      workspaceId: foreignWorkspaceId,
    });

    const usage = await createUsageService(database, createCursorCodec(cursorSecret), {
      now: () => at,
    }).currentMonth(workspaceId);

    expect(usage).toMatchObject({
      budget: {
        actualCostUsd: "1",
        estimatedCostUsd: "2",
        monthlyBudgetUsd: "100",
        remainingUsd: "94",
        reservedCostUsd: "3",
      },
      items: [
        {
          employee: {
            email: employee.email,
            id: employee.userId,
            name: "Usage Member",
          },
          groups: [
            {
              actualCostUsd: "1",
              cachedTokens: "3",
              completionTokens: "7",
              estimatedCostUsd: "0",
              generationCount: 1,
              promptTokens: "11",
              purpose: "chat",
              reasoningTokens: "2",
              tier: "fast",
            },
            {
              actualCostUsd: "0",
              cachedTokens: "0",
              completionTokens: "6",
              estimatedCostUsd: "2",
              generationCount: 1,
              promptTokens: "5",
              purpose: "compaction",
              reasoningTokens: "0",
              tier: "pro",
            },
          ],
          softBudget: { consumedUsd: "6", monthlyBudgetUsd: "6", warning: true },
        },
      ],
      nextCursor: null,
    });
    const serialized = JSON.stringify(usage);
    expect(serialized).not.toContain(privateTitle);
    expect(serialized).not.toContain(privateMessage);
    expect(serialized).not.toContain(privateSummary);
    expect(serialized).not.toContain(accountedConversation.conversationId);
    expect(serialized).not.toContain(reservedConversation.conversationId);
    expect(serialized).not.toContain(foreignEmployee.email);
  });
});

import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type ApiApplication, createApplication } from "../src/app.js";
import type { Authentication } from "../src/auth/authentication.js";
import { loadConfig } from "../src/config.js";
import { createCursorCodec } from "../src/conversations/cursor.js";
import {
  type ConversationService,
  createConversationService,
} from "../src/conversations/service.js";
import { session as authenticationSessions, user } from "../src/database/auth-schema.generated.js";
import { conversations, drafts, messages } from "../src/database/conversation-schema.js";
import { type AppDatabase, createDatabase } from "../src/database/database.js";
import { generations } from "../src/database/generation-schema.js";
import { workspaceMemberships, workspaces } from "../src/database/identity-schema.js";
import { migrateDatabase } from "../src/database/migrate.js";
import * as databaseSchema from "../src/database/schema.js";
import { ApplicationError } from "../src/errors.js";
import { createGenerationService, type GenerationService } from "../src/generations/service.js";
import type { RequestActor } from "../src/identity/authorization.js";
import type { IdentityService } from "../src/identity/service.js";
import { createModelPolicyService } from "../src/model-policy/service.js";
import { bootstrapSimulatedModelPolicy } from "./support/model-policy.js";

const publicOrigin = "http://localhost:5173";

function actor(input: {
  email: string;
  role?: "admin" | "member";
  userId: string;
  workspaceId: string;
}): RequestActor {
  const now = Date.now();
  return {
    employee: { email: input.email, id: input.userId, name: "Persona sintética" },
    role: input.role ?? "member",
    session: {
      createdAt: new Date(now - 1_000),
      expiresAt: new Date(now + 24 * 60 * 60 * 1_000),
      id: `session-${input.userId}`,
    },
    workspace: { id: input.workspaceId, identity: "synthetic", name: "Synthetic" },
  };
}

function text(value: string) {
  return [{ type: "text" as const, text: value }];
}

async function expectApplicationError(
  operation: Promise<unknown>,
  expected: { code: string; statusCode: number },
): Promise<void> {
  try {
    await operation;
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(ApplicationError);
    expect(error).toMatchObject(expected);
    return;
  }
  throw new Error(`Expected ${expected.code}`);
}

async function waitForCondition(
  check: () => Promise<boolean>,
  failureMessage: string,
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(failureMessage);
}

describe.sequential("conversation core integration", () => {
  let container: StartedPostgreSqlContainer;
  let databaseUrl: string;
  let pool: Pool;
  let database: AppDatabase;
  let generationService: GenerationService;
  let service: ConversationService;
  let primary: RequestActor;
  let otherEmployee: RequestActor;
  let otherWorkspace: RequestActor;
  let application: ApiApplication | undefined;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:18.4-alpine")
      .withDatabase("capstone_conversations")
      .withUsername("capstone")
      .withPassword("capstone-test-password")
      .start();
    databaseUrl = container.getConnectionUri();
    await migrateDatabase(databaseUrl);
  });

  beforeEach(async () => {
    pool = new Pool({ connectionString: databaseUrl });
    database = createDatabase(pool);
    await pool.query(
      'TRUNCATE TABLE "drafts", "messages", "conversations", "workspace_memberships", "employee_approvals", "user", "workspaces" RESTART IDENTITY CASCADE',
    );
    const primaryWorkspaceId = randomUUID();
    const secondaryWorkspaceId = randomUUID();
    const primaryWorkspaceIdentity = `workspace-${randomUUID()}`;
    const secondaryWorkspaceIdentity = `workspace-${randomUUID()}`;
    const primaryUserId = `user-${randomUUID()}`;
    const otherUserId = `user-${randomUUID()}`;
    const workspaceUserId = `user-${randomUUID()}`;
    await database.insert(workspaces).values([
      { displayName: "Synthetic", id: primaryWorkspaceId, identity: primaryWorkspaceIdentity },
      { displayName: "Other", id: secondaryWorkspaceId, identity: secondaryWorkspaceIdentity },
    ]);
    await database.insert(user).values([
      { email: "primary@example.test", emailVerified: true, id: primaryUserId, name: "Primary" },
      { email: "other@example.test", emailVerified: true, id: otherUserId, name: "Other" },
      {
        email: "workspace@example.test",
        emailVerified: true,
        id: workspaceUserId,
        name: "Workspace",
      },
    ]);
    const sessionAt = new Date();
    await database.insert(authenticationSessions).values(
      [primaryUserId, otherUserId, workspaceUserId].map((userId) => ({
        createdAt: sessionAt,
        expiresAt: new Date(sessionAt.getTime() + 24 * 60 * 60 * 1_000),
        id: `session-${userId}`,
        token: `token-${userId}`,
        updatedAt: sessionAt,
        userId,
      })),
    );
    await database.insert(workspaceMemberships).values([
      { role: "member", userId: primaryUserId, workspaceId: primaryWorkspaceId },
      { role: "admin", userId: otherUserId, workspaceId: primaryWorkspaceId },
      { role: "member", userId: workspaceUserId, workspaceId: secondaryWorkspaceId },
    ]);
    const modelPolicy = createModelPolicyService(database);
    await bootstrapSimulatedModelPolicy(modelPolicy, primaryWorkspaceIdentity);
    await bootstrapSimulatedModelPolicy(modelPolicy, secondaryWorkspaceIdentity);
    primary = actor({
      email: "primary@example.test",
      userId: primaryUserId,
      workspaceId: primaryWorkspaceId,
    });
    otherEmployee = actor({
      email: "other@example.test",
      role: "admin",
      userId: otherUserId,
      workspaceId: primaryWorkspaceId,
    });
    otherWorkspace = actor({
      email: "workspace@example.test",
      userId: workspaceUserId,
      workspaceId: secondaryWorkspaceId,
    });
    service = createConversationService(
      database,
      createCursorCodec("conversation-integration-secret-longer-than-thirty-two-characters"),
    );
    generationService = createGenerationService(database);
  });

  afterEach(async () => {
    if (application !== undefined) {
      await application.shutdown();
      application = undefined;
    }
    await pool.end();
  });

  afterAll(async () => {
    await container.stop();
  });

  it("scopes empty conversations and paginates equal timestamps without gaps", async () => {
    const created = await Promise.all(
      Array.from({ length: 22 }, async () => service.create(primary)),
    );
    const sharedTimestamp = new Date("2026-08-06T21:00:00.123Z");
    await database.update(conversations).set({ updatedAt: sharedTimestamp });

    const first = await service.list(primary, "active");
    expect(first.conversations).toHaveLength(20);
    expect(first.nextCursor).not.toBeNull();
    const second = await service.list(primary, "active", first.nextCursor ?? undefined);
    const ids = [...first.conversations, ...second.conversations].map(
      (conversation) => conversation.id,
    );
    expect(ids).toHaveLength(22);
    expect(new Set(ids).size).toBe(22);
    expect(new Set(ids)).toEqual(new Set(created.map((conversation) => conversation.id)));

    const empty = await service.get(primary, created[0]?.id ?? "");
    expect(empty.messages).toEqual([]);
    expect(empty.selectedLeafId).toBeNull();
    expect((await service.search(primary, "contenido")).results).toEqual([]);
    await expectApplicationError(service.get(otherEmployee, created[0]?.id ?? ""), {
      code: "NOT_FOUND",
      statusCode: 404,
    });
    await expectApplicationError(service.get(otherWorkspace, created[0]?.id ?? ""), {
      code: "NOT_FOUND",
      statusCode: 404,
    });
  });

  it("enforces immutable tree ownership, role alternation, and composite database constraints", async () => {
    const first = await service.create(primary);
    const second = await service.create(primary);
    await expectApplicationError(
      service.insertImmutableMessage(primary, {
        content: text("invalid root"),
        conversationId: first.id,
        parentMessageId: null,
        role: "assistant",
      }),
      { code: "BAD_REQUEST", statusCode: 400 },
    );
    const root = await service.insertImmutableMessage(primary, {
      content: text("root"),
      conversationId: first.id,
      parentMessageId: null,
      role: "user",
    });
    await expectApplicationError(
      service.insertImmutableMessage(primary, {
        content: text("second root"),
        conversationId: first.id,
        parentMessageId: null,
        role: "user",
      }),
      { code: "BAD_REQUEST", statusCode: 400 },
    );
    await expectApplicationError(
      service.insertImmutableMessage(primary, {
        content: text("same role"),
        conversationId: first.id,
        parentMessageId: root.id,
        role: "user",
      }),
      { code: "BAD_REQUEST", statusCode: 400 },
    );
    await expectApplicationError(
      service.insertImmutableMessage(primary, {
        content: text("cross conversation"),
        conversationId: second.id,
        parentMessageId: root.id,
        role: "assistant",
      }),
      { code: "NOT_FOUND", statusCode: 404 },
    );
    const selectedLeaf = await service.insertImmutableMessage(primary, {
      content: text("selected leaf"),
      conversationId: first.id,
      parentMessageId: root.id,
      role: "assistant",
    });
    await service.selectLeaf(primary, first.id, selectedLeaf.id, 0);
    await expectApplicationError(
      service.insertImmutableMessage(primary, {
        content: text("standalone extension"),
        conversationId: first.id,
        parentMessageId: selectedLeaf.id,
        role: "user",
      }),
      { code: "BAD_REQUEST", statusCode: 400 },
    );
    await expectApplicationError(service.selectLeaf(primary, second.id, root.id, 0), {
      code: "NOT_FOUND",
      statusCode: 404,
    });

    await expect(
      pool.query(
        "INSERT INTO messages (conversation_id, parent_message_id, role, content) VALUES ($1, $2, 'assistant', $3::jsonb)",
        [second.id, root.id, JSON.stringify(text("database cross parent"))],
      ),
    ).rejects.toMatchObject({ code: "23503" });
    await expect(
      pool.query("UPDATE conversations SET selected_leaf_message_id = $1 WHERE id = $2", [
        root.id,
        second.id,
      ]),
    ).rejects.toMatchObject({ code: "23503" });
    await expect(
      pool.query("UPDATE conversations SET title = E'\\t\\n' WHERE id = $1", [first.id]),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("reconstructs bounded deep branches and invalidates message cursors after selection", async () => {
    const conversation = await service.create(primary);
    let parentMessageId: string | null = null;
    let role: "assistant" | "user" = "user";
    const inserted: string[] = [];
    for (let index = 0; index < 45; index += 1) {
      const message = await service.insertImmutableMessage(primary, {
        content: text(`whole-message-${index}`),
        conversationId: conversation.id,
        parentMessageId,
        role,
      });
      inserted.push(message.id);
      parentMessageId = message.id;
      role = role === "user" ? "assistant" : "user";
    }
    const leafId = inserted.at(-1);
    if (leafId === undefined) throw new Error("missing leaf");
    const selected = await service.selectLeaf(primary, conversation.id, leafId, 0);
    expect(selected.conversation.revision).toBe(1);

    const recent = await service.get(primary, conversation.id);
    expect(recent.messages).toHaveLength(40);
    expect(recent.messages[0]?.content[0]?.text).toBe("whole-message-5");
    expect(recent.messages.at(-1)?.content[0]?.text).toBe("whole-message-44");
    expect(recent.nextCursor).not.toBeNull();
    const older = await service.get(primary, conversation.id, recent.nextCursor ?? undefined);
    expect(older.messages.map((message) => message.content[0]?.text)).toEqual([
      "whole-message-0",
      "whole-message-1",
      "whole-message-2",
      "whole-message-3",
      "whole-message-4",
    ]);

    const alternative = await service.insertImmutableMessage(primary, {
      content: text("alternative"),
      conversationId: conversation.id,
      parentMessageId: inserted.at(-2) ?? null,
      role: "user",
    });
    expect((await service.get(primary, conversation.id)).messages.at(-1)?.siblingCount).toBe(1);
    const switched = await service.selectLeaf(primary, conversation.id, alternative.id, 1);
    expect(switched.conversation.revision).toBe(2);
    await expectApplicationError(
      service.get(primary, conversation.id, recent.nextCursor ?? undefined),
      {
        code: "CONVERSATION_CHANGED",
        statusCode: 409,
      },
    );
    const noOp = await service.selectLeaf(primary, conversation.id, alternative.id, 0);
    expect(noOp.conversation.revision).toBe(2);
    await expectApplicationError(
      service.selectLeaf(primary, conversation.id, inserted[0] ?? "", 2),
      {
        code: "NOT_FOUND",
        statusCode: 404,
      },
    );
  });

  it("holds conversation deletion until a selected-branch read is coherent", async () => {
    const conversation = await service.create(primary);
    const root = await service.insertImmutableMessage(primary, {
      content: text("coherent branch"),
      conversationId: conversation.id,
      parentMessageId: null,
      role: "user",
    });
    const selected = await service.selectLeaf(primary, conversation.id, root.id, 0);

    let signalBranchQuery: () => void = () => undefined;
    const branchQueryReached = new Promise<void>((resolve) => {
      signalBranchQuery = resolve;
    });
    let releaseBranchQuery: () => void = () => undefined;
    const branchQueryRelease = new Promise<void>((resolve) => {
      releaseBranchQuery = resolve;
    });
    let paused = false;
    const instrumentedDatabase = new Proxy(database, {
      get(target, property, receiver) {
        if (property !== "transaction") {
          const value = Reflect.get(target, property, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        }
        return async (callback: (transaction: object) => Promise<unknown>, config?: unknown) =>
          Reflect.apply(target.transaction, target, [
            async (transaction: object) =>
              callback(
                new Proxy(transaction, {
                  get(transactionTarget, transactionProperty, transactionReceiver) {
                    const value = Reflect.get(
                      transactionTarget,
                      transactionProperty,
                      transactionReceiver,
                    );
                    if (transactionProperty !== "execute" || typeof value !== "function") {
                      return typeof value === "function" ? value.bind(transactionTarget) : value;
                    }
                    return async (...arguments_: readonly unknown[]) => {
                      if (!paused) {
                        paused = true;
                        signalBranchQuery();
                        await branchQueryRelease;
                      }
                      return Reflect.apply(value, transactionTarget, arguments_);
                    };
                  },
                }),
              ),
            config,
          ]);
      },
    }) as AppDatabase;
    const instrumentedService = createConversationService(
      instrumentedDatabase,
      createCursorCodec("coherent-detail-read-secret-longer-than-thirty-two-characters"),
    );

    const detailPromise = instrumentedService.get(primary, conversation.id);
    await branchQueryReached;
    const removePromise = generationService.removeConversation(
      primary,
      conversation.id,
      selected.conversation.revision,
    );
    try {
      await waitForCondition(async () => {
        const waiting = await pool.query<{ waiting: boolean }>(`
          SELECT EXISTS (
            SELECT 1
            FROM pg_stat_activity
            WHERE datname = current_database()
              AND pid <> pg_backend_pid()
              AND wait_event_type = 'Lock'
              AND query ILIKE '%conversations%for update%'
          ) AS waiting
        `);
        return waiting.rows[0]?.waiting === true;
      }, "Conversation deletion did not wait for the detail read");
    } finally {
      releaseBranchQuery();
    }

    const [detail] = await Promise.all([detailPromise, removePromise]);
    expect(detail.messages.map((message) => message.id)).toEqual([root.id]);
    await expectApplicationError(service.get(primary, conversation.id), {
      code: "NOT_FOUND",
      statusCode: 404,
    });
  });

  it("applies structural CAS rules, archive no-ops, and complete cascade deletion", async () => {
    const conversation = await service.create(primary);
    const root = await service.insertImmutableMessage(primary, {
      content: text("contenido para borrar"),
      conversationId: conversation.id,
      parentMessageId: null,
      role: "user",
    });
    await service.selectLeaf(primary, conversation.id, root.id, 0);
    const renamed = await service.rename(primary, conversation.id, "  Título   canónico  ", 1);
    expect(renamed).toMatchObject({ revision: 2, title: "Título canónico" });
    expect((await service.rename(primary, conversation.id, "Título canónico", 0)).revision).toBe(2);
    await expectApplicationError(service.rename(primary, conversation.id, "Otro", 1), {
      code: "CONVERSATION_CHANGED",
      statusCode: 409,
    });
    const archived = await service.setArchived(primary, conversation.id, true, 2);
    expect(archived).toMatchObject({ isArchived: true, revision: 3 });
    expect((await service.setArchived(primary, conversation.id, true, 0)).revision).toBe(3);
    await expectApplicationError(service.setArchived(primary, conversation.id, false, 2), {
      code: "CONVERSATION_CHANGED",
      statusCode: 409,
    });
    const unarchived = await service.setArchived(primary, conversation.id, false, 3);
    expect(unarchived).toMatchObject({ isArchived: false, revision: 4 });

    await service.saveDraft(primary, { kind: "new" }, "new preserved", 0);
    await service.saveDraft(
      primary,
      { conversationId: conversation.id, kind: "conversation" },
      "conversation removed",
      0,
    );
    expect((await service.search(primary, "contenido borrar")).results).toHaveLength(1);
    await expectApplicationError(
      generationService.removeConversation(primary, conversation.id, 3),
      {
        code: "CONVERSATION_CHANGED",
        statusCode: 409,
      },
    );
    await generationService.removeConversation(primary, conversation.id, 4);
    expect(
      await database.select().from(messages).where(eq(messages.conversationId, conversation.id)),
    ).toEqual([]);
    expect(
      await database.select().from(drafts).where(eq(drafts.conversationId, conversation.id)),
    ).toEqual([]);
    expect((await service.getDraft(primary, { kind: "new" })).content).toBe("new preserved");
    expect((await service.search(primary, "contenido borrar")).results).toEqual([]);
    await expectApplicationError(service.get(primary, conversation.id), {
      code: "NOT_FOUND",
      statusCode: 404,
    });
  });

  it.each(["preparing", "active", "finalizing"] as const)(
    "fences archive mutations while a %s workflow is nonterminal",
    async (status) => {
      const conversation = await service.create(primary);
      const prompt = await service.insertImmutableMessage(primary, {
        content: text("pregunta todavía en curso"),
        conversationId: conversation.id,
        parentMessageId: null,
        role: "user",
      });
      const answer = await service.insertImmutableMessage(primary, {
        content: text(status === "finalizing" ? "respuesta terminada" : ""),
        conversationId: conversation.id,
        parentMessageId: prompt.id,
        role: "assistant",
      });
      const now = new Date();
      await database.insert(generations).values({
        assistantMessageId: answer.id,
        completedAt: status === "finalizing" ? now : null,
        conversationId: conversation.id,
        createdAt: now,
        effectiveParameters: { context: { mode: "full" } },
        idempotencyKey: randomUUID(),
        purpose: "chat",
        requestedTier: "balanced",
        startedAt: now,
        status,
        systemPromptVersion: "capstone-chat-v1",
        terminalReason: status === "finalizing" ? "stop" : null,
        updatedAt: now,
        userId: primary.employee.id,
        workspaceId: primary.workspace.id,
      });

      await expectApplicationError(service.setArchived(primary, conversation.id, true, 0), {
        code: "GENERATION_ACTIVE",
        statusCode: 409,
      });
      await expect(service.get(primary, conversation.id)).resolves.toMatchObject({
        conversation: { isArchived: false, revision: 0 },
      });
    },
  );

  it("uses independent durable draft CAS revisions and rejects cross-owner rows", async () => {
    const conversation = await service.create(primary);
    const before = await service.getDraft(primary, { kind: "new" });
    expect(before).toEqual({ content: "", revision: 0, scope: { kind: "new" }, updatedAt: null });
    const saved = await service.saveDraft(primary, { kind: "new" }, "  uno\r\n\tdos  ", 0);
    expect(saved).toMatchObject({ content: "  uno\n\tdos  ", revision: 1 });
    await expectApplicationError(service.saveDraft(primary, { kind: "new" }, "stale", 0), {
      code: "DRAFT_CHANGED",
      statusCode: 409,
    });

    const currentConversation = await database
      .select({ revision: conversations.revision, updatedAt: conversations.updatedAt })
      .from(conversations)
      .where(eq(conversations.id, conversation.id));
    await service.saveDraft(
      primary,
      { conversationId: conversation.id, kind: "conversation" },
      "conversation draft",
      0,
    );
    expect(
      await database
        .select({ revision: conversations.revision, updatedAt: conversations.updatedAt })
        .from(conversations)
        .where(eq(conversations.id, conversation.id)),
    ).toEqual(currentConversation);
    await expectApplicationError(
      service.getDraft(otherEmployee, {
        conversationId: conversation.id,
        kind: "conversation",
      }),
      { code: "NOT_FOUND", statusCode: 404 },
    );

    const anotherConversation = await service.create(primary);
    await expect(
      database.insert(drafts).values({
        content: "cross owner",
        conversationId: anotherConversation.id,
        userId: otherEmployee.employee.id,
        workspaceId: otherEmployee.workspace.id,
      }),
    ).rejects.toMatchObject({ cause: expect.objectContaining({ code: "23503" }) });

    const freshConversation = await service.create(primary);
    const scope = { conversationId: freshConversation.id, kind: "conversation" as const };
    const concurrent = await Promise.allSettled([
      service.saveDraft(primary, scope, "writer one", 0),
      service.saveDraft(primary, scope, "writer two", 0),
    ]);
    expect(concurrent.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = concurrent.find((result) => result.status === "rejected");
    expect(rejected?.status === "rejected" ? rejected.reason : null).toMatchObject({
      code: "DRAFT_CHANGED",
    });
    const restarted = createConversationService(
      database,
      createCursorCodec("conversation-restart-secret-longer-than-thirty-two-characters"),
    );
    expect((await restarted.getDraft(primary, scope)).revision).toBe(1);
  });

  it("defers adjacent descendant resolution until selection without returning content", async () => {
    const conversation = await service.create(primary);
    const selectedRoot = await service.insertImmutableMessage(primary, {
      content: text("raíz elegida"),
      conversationId: conversation.id,
      parentMessageId: null,
      role: "user",
    });
    const previousAssistant = await service.insertImmutableMessage(primary, {
      content: text("respuesta anterior"),
      conversationId: conversation.id,
      parentMessageId: selectedRoot.id,
      role: "assistant",
    });
    const previousUser = await service.insertImmutableMessage(primary, {
      content: text("seguimiento anterior"),
      conversationId: conversation.id,
      parentMessageId: previousAssistant.id,
      role: "user",
    });
    const previousLeaves = [
      await service.insertImmutableMessage(primary, {
        content: text("hoja anterior uno"),
        conversationId: conversation.id,
        parentMessageId: previousUser.id,
        role: "assistant",
      }),
      await service.insertImmutableMessage(primary, {
        content: text("hoja anterior dos"),
        conversationId: conversation.id,
        parentMessageId: previousUser.id,
        role: "assistant",
      }),
    ];
    const selectedAssistant = await service.insertImmutableMessage(primary, {
      content: text("respuesta elegida"),
      conversationId: conversation.id,
      parentMessageId: selectedRoot.id,
      role: "assistant",
    });
    const selectedUser = await service.insertImmutableMessage(primary, {
      content: text("seguimiento elegido"),
      conversationId: conversation.id,
      parentMessageId: selectedAssistant.id,
      role: "user",
    });
    const selectedLeaf = await service.insertImmutableMessage(primary, {
      content: text("hoja elegida"),
      conversationId: conversation.id,
      parentMessageId: selectedUser.id,
      role: "assistant",
    });
    const nextAssistant = await service.insertImmutableMessage(primary, {
      content: text("respuesta siguiente"),
      conversationId: conversation.id,
      parentMessageId: selectedRoot.id,
      role: "assistant",
    });
    const nextUser = await service.insertImmutableMessage(primary, {
      content: text("seguimiento siguiente"),
      conversationId: conversation.id,
      parentMessageId: nextAssistant.id,
      role: "user",
    });
    const nextLeaf = await service.insertImmutableMessage(primary, {
      content: text("hoja siguiente"),
      conversationId: conversation.id,
      parentMessageId: nextUser.id,
      role: "assistant",
    });
    const rootAlternativeRows = await database
      .insert(messages)
      .values({
        content: text("raíz alternativa"),
        conversationId: conversation.id,
        parentMessageId: null,
        role: "user",
      })
      .returning();
    const rootAlternative = rootAlternativeRows[0];
    if (rootAlternative === undefined) throw new Error("missing root alternative");
    await service.insertImmutableMessage(primary, {
      content: text("respuesta de raíz alternativa"),
      conversationId: conversation.id,
      parentMessageId: rootAlternative.id,
      role: "assistant",
    });
    const sharedCreationTime = new Date("2026-08-07T20:00:00.000Z");
    await database
      .update(messages)
      .set({ createdAt: sharedCreationTime })
      .where(
        inArray(messages.id, [
          selectedRoot.id,
          rootAlternative.id,
          previousAssistant.id,
          selectedAssistant.id,
          nextAssistant.id,
          ...previousLeaves.map((message) => message.id),
        ]),
      );
    await service.selectLeaf(primary, conversation.id, selectedLeaf.id, 0);

    const siblingRows = await database
      .select()
      .from(messages)
      .where(eq(messages.parentMessageId, selectedRoot.id));
    const orderedSiblings = siblingRows.toSorted(
      (left, right) =>
        left.createdAt.getTime() - right.createdAt.getTime() || left.id.localeCompare(right.id),
    );
    expect(orderedSiblings.map((message) => message.id)).toEqual(
      [previousAssistant.id, selectedAssistant.id, nextAssistant.id].toSorted((left, right) =>
        left.localeCompare(right),
      ),
    );
    const selectedPosition = orderedSiblings.findIndex(
      (message) => message.id === selectedAssistant.id,
    );
    const expectedPreviousRoot = orderedSiblings[selectedPosition - 1];
    const expectedNextRoot = orderedSiblings[selectedPosition + 1];
    const newestLeafByRoot = new Map([
      [
        previousAssistant.id,
        previousLeaves.toSorted((left, right) => right.id.localeCompare(left.id))[0]?.id,
      ],
      [nextAssistant.id, nextLeaf.id],
    ]);

    const loggedQueries: string[] = [];
    const loggedDatabase = drizzle({
      client: pool,
      logger: { logQuery: (query) => loggedQueries.push(query) },
      schema: databaseSchema,
    });
    const loggedService = createConversationService(
      loggedDatabase,
      createCursorCodec("alternative-context-query-secret-longer-than-thirty-two-characters"),
    );
    const result = await loggedService.getAlternativeContexts(primary, conversation.id, [
      selectedAssistant.id,
      selectedRoot.id,
    ]);
    const metadataQuery = loggedQueries.find((query) => query.includes("requested_messages AS"));
    expect(metadataQuery).toBeDefined();
    expect(metadataQuery).not.toContain("descendants AS");
    expect(metadataQuery).not.toContain("child.parent_message_id = descendant.id");
    expect(result).toMatchObject({ conversationId: conversation.id, revision: 1 });
    expect(result.contexts[0]).toEqual({
      messageId: selectedAssistant.id,
      nextLeafMessageId: expectedNextRoot?.id ?? null,
      position: selectedPosition + 1,
      previousLeafMessageId: expectedPreviousRoot?.id ?? null,
      total: orderedSiblings.length,
    });
    const orderedRoots = [selectedRoot, rootAlternative].toSorted((left, right) =>
      left.id.localeCompare(right.id),
    );
    const selectedRootPosition = orderedRoots.findIndex(
      (message) => message.id === selectedRoot.id,
    );
    expect(result.contexts[1]).toEqual({
      messageId: selectedRoot.id,
      nextLeafMessageId: selectedRootPosition === 0 ? rootAlternative.id : null,
      position: selectedRootPosition + 1,
      previousLeafMessageId: selectedRootPosition === 1 ? rootAlternative.id : null,
      total: 2,
    });
    for (const context of result.contexts) {
      expect(Object.keys(context).toSorted()).toEqual(
        ["messageId", "nextLeafMessageId", "position", "previousLeafMessageId", "total"].toSorted(),
      );
    }

    const adjacentRoot = expectedPreviousRoot ?? expectedNextRoot;
    if (adjacentRoot === undefined) throw new Error("missing adjacent root");
    const expectedResolvedLeaf = newestLeafByRoot.get(adjacentRoot.id);
    if (expectedResolvedLeaf === undefined) throw new Error("missing resolved leaf");
    const selectedAlternative = await service.selectLeaf(
      primary,
      conversation.id,
      adjacentRoot.id,
      1,
    );
    expect(selectedAlternative).toMatchObject({
      conversation: { revision: 2 },
      selectedLeafId: expectedResolvedLeaf,
    });
    expect(selectedAlternative.selectedLeafId).not.toBe(adjacentRoot.id);

    const rootConversation = await service.create(primary);
    const rootSelected = await service.insertImmutableMessage(primary, {
      content: text("raíz seleccionada separada"),
      conversationId: rootConversation.id,
      parentMessageId: null,
      role: "user",
    });
    const rootSelectedLeaf = await service.insertImmutableMessage(primary, {
      content: text("respuesta seleccionada separada"),
      conversationId: rootConversation.id,
      parentMessageId: rootSelected.id,
      role: "assistant",
    });
    const rootDeferredRows = await database
      .insert(messages)
      .values({
        content: text("raíz diferida"),
        conversationId: rootConversation.id,
        parentMessageId: null,
        role: "user",
      })
      .returning();
    const rootDeferred = rootDeferredRows[0];
    if (rootDeferred === undefined) throw new Error("missing deferred root");
    const rootDeferredLeaf = await service.insertImmutableMessage(primary, {
      content: text("respuesta diferida"),
      conversationId: rootConversation.id,
      parentMessageId: rootDeferred.id,
      role: "assistant",
    });
    await service.selectLeaf(primary, rootConversation.id, rootSelectedLeaf.id, 0);

    let signalResolution: () => void = () => undefined;
    const resolutionReached = new Promise<void>((resolve) => {
      signalResolution = resolve;
    });
    let releaseResolution: () => void = () => undefined;
    const resolutionRelease = new Promise<void>((resolve) => {
      releaseResolution = resolve;
    });
    let pausedResolution = false;
    const selectionDatabase = new Proxy(database, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (property !== "execute" || typeof value !== "function") {
          return typeof value === "function" ? value.bind(target) : value;
        }
        return async (...arguments_: readonly unknown[]) => {
          if (!pausedResolution) {
            pausedResolution = true;
            signalResolution();
            await resolutionRelease;
          }
          return Reflect.apply(value, target, arguments_);
        };
      },
    }) as AppDatabase;
    const selectionService = createConversationService(
      selectionDatabase,
      createCursorCodec("deferred-selection-secret-longer-than-thirty-two-characters"),
    );
    const racedSelection = expectApplicationError(
      selectionService.selectLeaf(primary, rootConversation.id, rootDeferred.id, 1),
      { code: "CONVERSATION_CHANGED", statusCode: 409 },
    );
    await resolutionReached;
    let renamedRevision: number;
    try {
      renamedRevision = (
        await service.rename(primary, rootConversation.id, "selección concurrente", 1)
      ).revision;
    } finally {
      releaseResolution();
    }
    await racedSelection;
    expect(renamedRevision).toBe(2);

    const rootSelection = await service.selectLeaf(
      primary,
      rootConversation.id,
      rootDeferred.id,
      2,
    );
    expect(rootSelection.selectedLeafId).toBe(rootDeferredLeaf.id);

    const otherConversation = await service.create(primary);
    const otherRoot = await service.insertImmutableMessage(primary, {
      content: text("otra conversación"),
      conversationId: otherConversation.id,
      parentMessageId: null,
      role: "user",
    });
    for (const messageIds of [
      [],
      [selectedAssistant.id, selectedAssistant.id],
      [selectedUser.id],
      [otherRoot.id],
    ]) {
      await expectApplicationError(
        service.getAlternativeContexts(primary, conversation.id, messageIds),
        { code: "BAD_REQUEST", statusCode: 400 },
      );
    }
    await expectApplicationError(
      service.getAlternativeContexts(otherEmployee, conversation.id, [selectedAssistant.id]),
      { code: "NOT_FOUND", statusCode: 404 },
    );
  });

  it("undoes to an internal assistant and keeps search and selection coherent", async () => {
    const conversation = await service.create(primary);
    const root = await service.insertImmutableMessage(primary, {
      content: text("hallazgo raíz seleccionada"),
      conversationId: conversation.id,
      parentMessageId: null,
      role: "user",
    });
    const firstAssistant = await service.insertImmutableMessage(primary, {
      content: text("hallazgo asistente interno"),
      conversationId: conversation.id,
      parentMessageId: root.id,
      role: "assistant",
    });
    const secondUser = await service.insertImmutableMessage(primary, {
      content: text("hallazgo descendiente oculto"),
      conversationId: conversation.id,
      parentMessageId: firstAssistant.id,
      role: "user",
    });
    const secondAssistant = await service.insertImmutableMessage(primary, {
      content: text("respuesta descendiente"),
      conversationId: conversation.id,
      parentMessageId: secondUser.id,
      role: "assistant",
    });
    await service.selectLeaf(primary, conversation.id, secondAssistant.id, 0);
    const draft = await service.saveDraft(
      primary,
      { conversationId: conversation.id, kind: "conversation" },
      "borrador preservado por Undo",
      0,
    );

    await expectApplicationError(service.undo(primary, conversation.id, 0), {
      code: "CONVERSATION_CHANGED",
      statusCode: 409,
    });
    const undone = await service.undo(primary, conversation.id, 1);
    expect(undone).toMatchObject({
      conversation: { revision: 2 },
      selectedLeafId: firstAssistant.id,
    });
    const detail = await service.get(primary, conversation.id);
    expect(detail.messages.map((message) => message.id)).toEqual([root.id, firstAssistant.id]);
    expect(
      await database.select().from(messages).where(eq(messages.conversationId, conversation.id)),
    ).toHaveLength(4);
    expect(
      await service.getDraft(primary, { conversationId: conversation.id, kind: "conversation" }),
    ).toMatchObject(draft);

    for (const query of ["hallazgo raiz", "hallazgo asistente"]) {
      const hit = (await service.search(primary, query)).results.find(
        (result) => result.conversation.id === conversation.id,
      );
      expect(hit?.leafMessageId).toBe(firstAssistant.id);
      const noOp = await service.selectLeaf(primary, conversation.id, hit?.leafMessageId ?? "", 0);
      expect(noOp).toMatchObject({
        conversation: { revision: 2 },
        selectedLeafId: firstAssistant.id,
      });
    }
    const hiddenHit = (await service.search(primary, "hallazgo descendiente")).results.find(
      (result) => result.conversation.id === conversation.id,
    );
    expect(hiddenHit?.leafMessageId).toBe(secondAssistant.id);
    const restored = await service.selectLeaf(
      primary,
      conversation.id,
      hiddenHit?.leafMessageId ?? "",
      2,
    );
    expect(restored.conversation.revision).toBe(3);
    const archived = await service.setArchived(primary, conversation.id, true, 3);
    const concurrentUndo = await Promise.allSettled([
      service.undo(primary, conversation.id, archived.revision),
      service.undo(primary, conversation.id, archived.revision),
    ]);
    expect(concurrentUndo.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const archivedUndo = concurrentUndo.find((result) => result.status === "fulfilled");
    if (archivedUndo?.status !== "fulfilled") throw new Error("Undo did not produce a winner");
    expect(concurrentUndo.find((result) => result.status === "rejected")).toMatchObject({
      reason: { code: "CONVERSATION_CHANGED" },
      status: "rejected",
    });
    expect(archivedUndo.value).toMatchObject({
      conversation: { isArchived: true, revision: 5 },
      selectedLeafId: firstAssistant.id,
    });

    const firstTurn = await service.create(primary);
    const firstUser = await service.insertImmutableMessage(primary, {
      content: text("sin Undo"),
      conversationId: firstTurn.id,
      parentMessageId: null,
      role: "user",
    });
    const firstAnswer = await service.insertImmutableMessage(primary, {
      content: text("primera respuesta"),
      conversationId: firstTurn.id,
      parentMessageId: firstUser.id,
      role: "assistant",
    });
    await service.selectLeaf(primary, firstTurn.id, firstAnswer.id, 0);
    await expectApplicationError(service.undo(primary, firstTurn.id, 1), {
      code: "BAD_REQUEST",
      statusCode: 400,
    });
    await expectApplicationError(service.undo(otherEmployee, conversation.id, 5), {
      code: "NOT_FOUND",
      statusCode: 404,
    });

    const activeConversation = await service.create(primary);
    const activeUser = await service.insertImmutableMessage(primary, {
      content: text("pregunta activa"),
      conversationId: activeConversation.id,
      parentMessageId: null,
      role: "user",
    });
    const activeAssistant = await service.insertImmutableMessage(primary, {
      content: text("respuesta activa previa"),
      conversationId: activeConversation.id,
      parentMessageId: activeUser.id,
      role: "assistant",
    });
    const activeSecondUser = await service.insertImmutableMessage(primary, {
      content: text("seguimiento activo"),
      conversationId: activeConversation.id,
      parentMessageId: activeAssistant.id,
      role: "user",
    });
    const activeSecondAssistant = await service.insertImmutableMessage(primary, {
      content: text("respuesta reintentable"),
      conversationId: activeConversation.id,
      parentMessageId: activeSecondUser.id,
      role: "assistant",
    });
    await service.selectLeaf(primary, activeConversation.id, activeSecondAssistant.id, 0);
    await generationService.startResponse(primary, activeConversation.id, randomUUID(), {
      modelTier: "balanced",
      observedRevision: 1,
      parentMessageId: activeSecondUser.id,
      source: "retry",
      targetMessageId: activeSecondAssistant.id,
    });
    await expectApplicationError(service.undo(primary, activeConversation.id, 2), {
      code: "GENERATION_ACTIVE",
      statusCode: 409,
    });
  });

  it("searches safely across accents, archives, and alternatives with deterministic ranking", async () => {
    const titleConversation = await service.create(primary);
    await service.rename(primary, titleConversation.id, "Árbol Azul", 0);
    const titleRoot = await service.insertImmutableMessage(primary, {
      content: text("mensaje sin coincidencia"),
      conversationId: titleConversation.id,
      parentMessageId: null,
      role: "user",
    });
    await service.selectLeaf(primary, titleConversation.id, titleRoot.id, 1);

    const branchConversation = await service.create(primary);
    const root = await service.insertImmutableMessage(primary, {
      content: text("alpha común árbol azul"),
      conversationId: branchConversation.id,
      parentMessageId: null,
      role: "user",
    });
    const expansionSource = `${"relleno ".repeat(30)}respuesta elegida Æther Straße smør Łódź beta eta ıstanbul ƀetaz ŧango © ¼ foobarbaz foo-bar baz \u0301luz cafe\u0301 final`;
    const selectedLeaf = await service.insertImmutableMessage(primary, {
      content: text(expansionSource),
      conversationId: branchConversation.id,
      parentMessageId: root.id,
      role: "assistant",
    });
    const alternativeLeaf = await service.insertImmutableMessage(primary, {
      content: text("Canción sintética beta segura"),
      conversationId: branchConversation.id,
      parentMessageId: root.id,
      role: "assistant",
    });
    const internalAlternative = await service.insertImmutableMessage(primary, {
      content: text("sendero determinista"),
      conversationId: branchConversation.id,
      parentMessageId: root.id,
      role: "assistant",
    });
    const internalUser = await service.insertImmutableMessage(primary, {
      content: text("continuación"),
      conversationId: branchConversation.id,
      parentMessageId: internalAlternative.id,
      role: "user",
    });
    const deterministicLeaves = [
      await service.insertImmutableMessage(primary, {
        content: text("final uno"),
        conversationId: branchConversation.id,
        parentMessageId: internalUser.id,
        role: "assistant",
      }),
      await service.insertImmutableMessage(primary, {
        content: text("final dos"),
        conversationId: branchConversation.id,
        parentMessageId: internalUser.id,
        role: "assistant",
      }),
    ];
    await service.selectLeaf(primary, branchConversation.id, selectedLeaf.id, 0);
    await service.setArchived(primary, branchConversation.id, true, 1);

    const boundaryConversation = await service.create(primary);
    const boundaryRoot = await service.insertImmutableMessage(primary, {
      content: text("exactterm foo-bar foo_bar https://example.com/a-b?q=x"),
      conversationId: boundaryConversation.id,
      parentMessageId: null,
      role: "user",
    });
    await service.selectLeaf(primary, boundaryConversation.id, boundaryRoot.id, 0);

    const exactTermDecoyConversation = await service.create(primary);
    const exactTermDecoyRoot = await service.insertImmutableMessage(primary, {
      content: text("exactterms foo-bar"),
      conversationId: exactTermDecoyConversation.id,
      parentMessageId: null,
      role: "user",
    });
    await service.selectLeaf(primary, exactTermDecoyConversation.id, exactTermDecoyRoot.id, 0);

    const normalization = await pool.query<{
      foldedCount: number;
      perCodePoint: string;
      reconstructed: string;
      sourceCount: number;
      whole: string;
    }>(
      `WITH source_characters AS (
        SELECT source_character.value, source_character.ordinality
        FROM unnest(string_to_array($1::text, NULL))
          WITH ORDINALITY AS source_character(value, ordinality)
      ), folded AS (
        SELECT public.capstone_search_normalize(
          string_agg(value, chr(1) ORDER BY ordinality)
        ) AS value
        FROM source_characters
      )
      SELECT string_agg(source_characters.value, '' ORDER BY ordinality) AS "reconstructed",
        replace(folded.value, chr(1), '') AS "perCodePoint",
        cardinality(string_to_array(folded.value, chr(1)))::integer AS "foldedCount",
        count(*)::integer AS "sourceCount",
        public.capstone_search_normalize($1::text) AS "whole"
      FROM source_characters
      CROSS JOIN folded
      GROUP BY folded.value`,
      [expansionSource],
    );
    expect(normalization.rows[0]).toMatchObject({
      foldedCount: [...expansionSource].length,
      perCodePoint: normalization.rows[0]?.whole,
      reconstructed: expansionSource,
      sourceCount: [...expansionSource].length,
    });

    const titleResults = await service.search(primary, "ARBOL az");
    expect(titleResults.results[0]).toMatchObject({ matchKind: "title", matchedMessageId: null });
    const selectedDescendant = (await service.search(primary, "alpha com")).results.find(
      (result) => result.matchedMessageId === root.id,
    );
    expect(selectedDescendant?.leafMessageId).toBe(selectedLeaf.id);
    const messageResults = await service.search(primary, '"CANCION" & beta:');
    const alternative = messageResults.results.find(
      (result) => result.matchedMessageId === alternativeLeaf.id,
    );
    expect(alternative).toMatchObject({
      conversation: { isArchived: true },
      leafMessageId: alternativeLeaf.id,
      matchKind: "message",
    });
    expect(alternative?.snippet.some((segment) => segment.highlighted)).toBe(true);
    const deterministic = (await service.search(primary, "sendero determ")).results.find(
      (result) => result.matchedMessageId === internalAlternative.id,
    );
    const expectedDeterministicLeaf = deterministicLeaves.toSorted(
      (left, right) =>
        right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id),
    )[0];
    expect(deterministic?.leafMessageId).toBe(expectedDeterministicLeaf?.id);
    const snippetPrefixes = new Map<string, string>();
    for (const [query, expectedHighlight] of [
      ["aet", "Æt"],
      ["strasse", "Straße"],
      ["smor", "smør"],
      ["lodz", "Łódź"],
      ["eta", "eta"],
      ["ist", "ıst"],
      ["betaz", "ƀetaz"],
      ["tango", "ŧango"],
      ["c", "©"],
      ["1", "¼"],
      ["bar", "bar"],
      ["baz", "baz"],
      ["luz", "\u0301luz"],
      ["cafe", "cafe\u0301"],
    ] as const) {
      const expansionHit = (await service.search(primary, query)).results.find(
        (result) => result.matchedMessageId === selectedLeaf.id,
      );
      expect(expansionHit).toBeDefined();
      expect(expansionHit?.snippet.find((segment) => segment.highlighted)?.text).toBe(
        expectedHighlight,
      );
      const highlightedIndex = expansionHit?.snippet.findIndex((segment) => segment.highlighted);
      if (expansionHit !== undefined && highlightedIndex !== undefined && highlightedIndex >= 0) {
        snippetPrefixes.set(
          query,
          expansionHit.snippet
            .slice(0, highlightedIndex)
            .map((segment) => segment.text)
            .join(""),
        );
      }
    }
    expect(snippetPrefixes.get("bar")?.endsWith("foo-")).toBe(true);
    expect(snippetPrefixes.get("baz")?.endsWith("foo-bar ")).toBe(true);
    for (const [query, expectedHighlight] of [
      ["bar", "bar"],
      ["/a-b", "/a-b"],
      ["https://example.com/a-b", "example.com/a-b"],
    ] as const) {
      const boundaryHit = (await service.search(primary, query)).results.find(
        (result) => result.matchedMessageId === boundaryRoot.id,
      );
      expect(boundaryHit).toBeDefined();
      expect(boundaryHit?.snippet.find((segment) => segment.highlighted)?.text).toBe(
        expectedHighlight,
      );
    }
    const hwordPrefix = (await service.search(primary, "foo-ba")).results.find(
      (result) => result.matchedMessageId === boundaryRoot.id,
    );
    expect(hwordPrefix).toBeDefined();
    expect(hwordPrefix?.snippet.find((segment) => segment.highlighted)?.text).toBe("foo-ba");

    for (const query of ["exactterm foo-ba", "exactterm foo-ba !!!"]) {
      const results = (await service.search(primary, query)).results;
      expect(results.some((result) => result.matchedMessageId === boundaryRoot.id)).toBe(true);
      expect(results.some((result) => result.matchedMessageId === exactTermDecoyRoot.id)).toBe(
        false,
      );
    }
    expect((await service.search(primary, "alph beta")).results).toEqual([]);
    expect((await service.search(primary, "alpha com")).results.length).toBeGreaterThan(0);
    for (const hostile of ["'", "&", "|", "!", ":", "*", "()", '""']) {
      await expect(service.search(primary, hostile)).resolves.toMatchObject({ results: [] });
    }
    expect((await service.search(otherEmployee, "beta")).results).toEqual([]);
  });

  it("paginates signed search results and query plans use ownership and GIN indexes", async () => {
    for (let index = 0; index < 21; index += 1) {
      const conversation = await service.create(primary);
      await service.rename(primary, conversation.id, `Synthetic searchable ${index}`, 0);
      const root = await service.insertImmutableMessage(primary, {
        content: text(`needle content ${index}`),
        conversationId: conversation.id,
        parentMessageId: null,
        role: "user",
      });
      await service.selectLeaf(primary, conversation.id, root.id, 1);
    }
    await database.update(conversations).set({ updatedAt: new Date("2026-08-06T23:00:00.456Z") });
    const first = await service.search(primary, "synthetic");
    expect(first.results).toHaveLength(20);
    expect(first.nextCursor).not.toBeNull();
    const second = await service.search(primary, "synthetic", first.nextCursor ?? undefined);
    expect(second.results).toHaveLength(1);
    expect(
      new Set([...first.results, ...second.results].map((result) => result.conversation.id)).size,
    ).toBe(21);
    await expectApplicationError(
      service.search(primary, "different", first.nextCursor ?? undefined),
      {
        code: "INVALID_CURSOR",
        statusCode: 400,
      },
    );

    const planPool = await pool.connect();
    try {
      await planPool.query("SET enable_seqscan = off");
      const titlePlan = await planPool.query<Record<string, string>>(
        `EXPLAIN (COSTS OFF, FORMAT TEXT)
         SELECT id FROM conversations
         WHERE workspace_id = $1 AND user_id = $2
           AND title_search_vector @@ to_tsquery('simple', 'synthetic')`,
        [primary.workspace.id, primary.employee.id],
      );
      const messagePlan = await planPool.query<Record<string, string>>(
        `EXPLAIN (COSTS OFF, FORMAT TEXT)
         SELECT message.id FROM conversations AS conversation
         JOIN messages AS message ON message.conversation_id = conversation.id
         WHERE conversation.workspace_id = $1 AND conversation.user_id = $2
           AND message.content_search_vector @@ to_tsquery('simple', 'needle')`,
        [primary.workspace.id, primary.employee.id],
      );
      const titleGinPlan = await planPool.query<Record<string, string>>(
        "EXPLAIN (COSTS OFF, FORMAT TEXT) SELECT id FROM conversations WHERE title_search_vector @@ to_tsquery('simple', 'synthetic')",
      );
      const messageGinPlan = await planPool.query<Record<string, string>>(
        "EXPLAIN (COSTS OFF, FORMAT TEXT) SELECT id FROM messages WHERE content_search_vector @@ to_tsquery('simple', 'needle')",
      );
      const plans = [
        ...titlePlan.rows,
        ...messagePlan.rows,
        ...titleGinPlan.rows,
        ...messageGinPlan.rows,
      ]
        .map((row) => Object.values(row)[0])
        .join("\n");
      expect(plans).toContain("conversations_owner_id_unique");
      expect(plans).toContain("conversations_title_search_idx");
      expect(plans).toContain("messages_content_search_idx");
    } finally {
      planPool.release();
    }
  });

  it("serves authenticated no-store routes, round-trips cursors, and never logs content", async () => {
    const authenticationHeaders = new Headers();
    authenticationHeaders.append(
      "set-cookie",
      "capstone.session=refreshed; HttpOnly; SameSite=Lax",
    );
    let authenticated = true;
    const authentication = {
      auth: {
        api: {
          getSession: async () => ({
            headers: authenticationHeaders,
            response: authenticated
              ? {
                  session: {
                    createdAt: primary.session.createdAt,
                    expiresAt: primary.session.expiresAt,
                  },
                  user: {
                    email: primary.employee.email,
                    emailVerified: true,
                    id: primary.employee.id,
                    name: primary.employee.name,
                  },
                }
              : null,
          }),
        },
        handler: async () => new Response(null, { status: 404 }),
      },
      revokeUserSessions: async () => undefined,
    } as unknown as Authentication;
    const identity = {
      findActiveMemberships: async () => [
        {
          role: primary.role,
          workspaceDisplayName: primary.workspace.name,
          workspaceId: primary.workspace.id,
          workspaceIdentity: primary.workspace.identity,
        },
      ],
    } as unknown as IdentityService;
    const logLines: string[] = [];
    application = createApplication(
      loadConfig({
        DATABASE_URL: databaseUrl,
        LOG_LEVEL: "info",
        NODE_ENV: "test",
        PUBLIC_ORIGIN: publicOrigin,
      }),
      {
        authentication,
        identity,
        loggerStream: { write: (line) => logLines.push(line) },
        pool: new Pool({ connectionString: databaseUrl }),
        requestIdFactory: () => "conversation-request-id",
      },
    );

    for (let index = 0; index < 21; index += 1) {
      await application.conversations.create(primary);
    }
    const first = await application.server.inject({
      method: "GET",
      url: "/api/conversations?view=active",
    });
    expect(first.statusCode).toBe(200);
    expect(first.headers["cache-control"]).toBe("no-store");
    expect(
      Array.isArray(first.headers["set-cookie"])
        ? first.headers["set-cookie"].join("; ")
        : first.headers["set-cookie"],
    ).toContain("capstone.session=refreshed");
    const firstBody = first.json<{ nextCursor: string }>();
    const second = await application.server.inject({
      method: "GET",
      url: `/api/conversations?view=active&cursor=${encodeURIComponent(firstBody.nextCursor)}`,
    });
    expect(second.statusCode).toBe(200);
    expect(second.json<{ conversations: unknown[] }>().conversations).toHaveLength(1);

    const sensitiveDraft = "synthetic-private-draft-fragment";
    const validEscapedDraft = "\t".repeat(32_768);
    const draftResponse = await application.server.inject({
      headers: { "content-type": "application/json", origin: publicOrigin },
      method: "PUT",
      payload: { content: validEscapedDraft, observedRevision: 0 },
      url: "/api/drafts/new",
    });
    expect(draftResponse.statusCode).toBe(200);
    const oversizedDraft = await application.server.inject({
      headers: { "content-type": "application/json", origin: publicOrigin },
      method: "PUT",
      payload: { content: "ñ".repeat(16_385), observedRevision: 1 },
      url: "/api/drafts/new",
    });
    expect(oversizedDraft.statusCode).toBe(413);
    expect(oversizedDraft.json()).toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
    const oversizedSearch = await application.server.inject({
      headers: { "content-type": "application/json", origin: publicOrigin },
      method: "POST",
      payload: { query: "ñ".repeat(129) },
      url: "/api/conversations/search",
    });
    expect(oversizedSearch.statusCode).toBe(413);
    expect(oversizedSearch.json()).toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
    const invalidDraft = await application.server.inject({
      headers: { "content-type": "application/json", origin: publicOrigin },
      method: "PUT",
      payload: { content: `${String.fromCharCode(0)}${"ñ".repeat(16_385)}`, observedRevision: 1 },
      url: "/api/drafts/new",
    });
    expect(invalidDraft.statusCode).toBe(400);
    expect(invalidDraft.json()).toMatchObject({ code: "BAD_REQUEST" });
    const wrongContentType = await application.server.inject({
      headers: { "content-type": "text/plain", origin: publicOrigin },
      method: "POST",
      payload: '{"query":"contenido"}',
      url: "/api/conversations/search",
    });
    expect(wrongContentType.statusCode).toBe(415);
    expect(wrongContentType.json()).toMatchObject({ code: "JSON_REQUIRED" });
    const sensitiveResponse = await application.server.inject({
      headers: { "content-type": "application/json", origin: publicOrigin },
      method: "PUT",
      payload: { content: sensitiveDraft, observedRevision: 1 },
      url: "/api/drafts/new",
    });
    expect(sensitiveResponse.statusCode).toBe(200);
    const tierPolicyResponse = await application.server.inject({
      method: "GET",
      url: "/api/model-tiers",
    });
    expect(tierPolicyResponse.statusCode).toBe(200);
    expect(tierPolicyResponse.headers["cache-control"]).toBe("no-store");
    expect(tierPolicyResponse.json()).toEqual({
      defaultTier: "balanced",
      tiers: [
        { available: true, enabled: true, tier: "fast" },
        { available: true, enabled: true, tier: "balanced" },
        { available: true, enabled: true, tier: "pro" },
      ],
    });
    const loggedConversation = await application.conversations.create(primary);
    const loggedRenamed = await application.conversations.rename(
      primary,
      loggedConversation.id,
      "log-private-title-fragment",
      0,
    );
    const loggedMessage = await application.conversations.insertImmutableMessage(primary, {
      content: text("log-private-message-fragment secretneedle"),
      conversationId: loggedConversation.id,
      parentMessageId: null,
      role: "user",
    });
    const loggedSelected = await application.conversations.selectLeaf(
      primary,
      loggedConversation.id,
      loggedMessage.id,
      loggedRenamed.revision,
    );
    const routeConversation = await application.conversations.create(primary);
    const routeConversationBeforePreference = (
      await database
        .select({ revision: conversations.revision, updatedAt: conversations.updatedAt })
        .from(conversations)
        .where(eq(conversations.id, routeConversation.id))
    )[0];
    const initialPreference = await application.server.inject({
      method: "GET",
      url: `/api/conversations/${routeConversation.id}/preferred-tier`,
    });
    expect(initialPreference.statusCode).toBe(200);
    expect(initialPreference.json()).toEqual({
      conversationId: routeConversation.id,
      modelTier: "balanced",
    });
    const updatedPreference = await application.server.inject({
      headers: { "content-type": "application/json", origin: publicOrigin },
      method: "PUT",
      payload: { modelTier: "pro" },
      url: `/api/conversations/${routeConversation.id}/preferred-tier`,
    });
    expect(updatedPreference.statusCode).toBe(200);
    expect(updatedPreference.json()).toEqual({
      conversationId: routeConversation.id,
      modelTier: "pro",
    });
    const routeConversationAfterPreference = (
      await database
        .select({ revision: conversations.revision, updatedAt: conversations.updatedAt })
        .from(conversations)
        .where(eq(conversations.id, routeConversation.id))
    )[0];
    expect(routeConversationAfterPreference).toEqual(routeConversationBeforePreference);
    const routeRoot = await application.conversations.insertImmutableMessage(primary, {
      content: text("route root"),
      conversationId: routeConversation.id,
      parentMessageId: null,
      role: "user",
    });
    const routeFirstAssistant = await application.conversations.insertImmutableMessage(primary, {
      content: text("route first assistant"),
      conversationId: routeConversation.id,
      parentMessageId: routeRoot.id,
      role: "assistant",
    });
    const routeSecondUser = await application.conversations.insertImmutableMessage(primary, {
      content: text("route second user"),
      conversationId: routeConversation.id,
      parentMessageId: routeFirstAssistant.id,
      role: "user",
    });
    const routeSecondAssistant = await application.conversations.insertImmutableMessage(primary, {
      content: text("route second assistant"),
      conversationId: routeConversation.id,
      parentMessageId: routeSecondUser.id,
      role: "assistant",
    });
    await application.conversations.selectLeaf(
      primary,
      routeConversation.id,
      routeSecondAssistant.id,
      0,
    );
    const alternativeContexts = await application.server.inject({
      headers: { "content-type": "application/json", origin: publicOrigin },
      method: "POST",
      payload: { messageIds: [routeFirstAssistant.id] },
      url: `/api/conversations/${routeConversation.id}/alternative-contexts`,
    });
    expect(alternativeContexts.statusCode, alternativeContexts.body).toBe(200);
    expect(alternativeContexts.json()).toMatchObject({
      contexts: [
        {
          messageId: routeFirstAssistant.id,
          nextLeafMessageId: null,
          position: 1,
          previousLeafMessageId: null,
          total: 1,
        },
      ],
      revision: 1,
    });
    const invalidAlternativeContexts = await application.server.inject({
      headers: { "content-type": "application/json", origin: publicOrigin },
      method: "POST",
      payload: { messageIds: [routeFirstAssistant.id, routeFirstAssistant.id] },
      url: `/api/conversations/${routeConversation.id}/alternative-contexts`,
    });
    expect(invalidAlternativeContexts.statusCode).toBe(400);
    const undo = await application.server.inject({
      headers: { "content-type": "application/json", origin: publicOrigin },
      method: "POST",
      payload: { observedRevision: 1 },
      url: `/api/conversations/${routeConversation.id}/undo`,
    });
    expect(undo.statusCode, undo.body).toBe(200);
    expect(undo.json()).toMatchObject({
      conversation: { revision: 2 },
      selectedLeafId: routeFirstAssistant.id,
    });
    const staleUndo = await application.server.inject({
      headers: { "content-type": "application/json", origin: publicOrigin },
      method: "POST",
      payload: { observedRevision: 1 },
      url: `/api/conversations/${routeConversation.id}/undo`,
    });
    expect(staleUndo.statusCode).toBe(409);
    expect(staleUndo.json()).toMatchObject({ code: "CONVERSATION_CHANGED" });
    const loggedSearch = await application.server.inject({
      headers: { "content-type": "application/json", origin: publicOrigin },
      method: "POST",
      payload: { query: "secretneedle" },
      url: "/api/conversations/search",
    });
    expect(loggedSearch.statusCode, loggedSearch.body).toBe(200);
    const loggedRename = await application.server.inject({
      headers: { "content-type": "application/json", origin: publicOrigin },
      method: "PATCH",
      payload: {
        observedRevision: loggedSelected.conversation.revision,
        title: "log-private-renamed-fragment",
      },
      url: `/api/conversations/${loggedConversation.id}/title`,
    });
    expect(loggedRename.statusCode).toBe(200);
    const deleted = await application.server.inject({
      headers: { "content-type": "application/json", origin: publicOrigin },
      method: "DELETE",
      payload: { observedRevision: loggedRename.json<{ revision: number }>().revision },
      url: `/api/conversations/${loggedConversation.id}`,
    });
    expect(deleted.statusCode).toBe(204);
    expect(deleted.body).toBe("");
    expect(deleted.headers["content-type"]).toBeUndefined();
    expect(deleted.headers["cache-control"]).toBe("no-store");
    const invalid = await application.server.inject({
      headers: { "content-type": "application/json", origin: publicOrigin },
      method: "POST",
      payload: { query: "schema-private-query", unexpected: sensitiveDraft },
      url: "/api/conversations/search",
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.headers["cache-control"]).toBe("no-store");
    expect(logLines.join("\n")).not.toContain(sensitiveDraft);
    expect(logLines.join("\n")).not.toContain("schema-private-query");
    expect(logLines.join("\n")).not.toContain("log-private-title-fragment");
    expect(logLines.join("\n")).not.toContain("log-private-message-fragment");
    expect(logLines.join("\n")).not.toContain("secretneedle");
    expect(logLines.join("\n")).not.toContain("log-private-renamed-fragment");

    authenticated = false;
    const unauthorized = await application.server.inject({
      method: "GET",
      url: "/api/conversations?view=active",
    });
    expect(unauthorized.statusCode).toBe(401);
    expect(unauthorized.headers["cache-control"]).toBe("no-store");
    expect(unauthorized.json()).toMatchObject({ code: "AUTHENTICATION_REQUIRED" });
  });
});

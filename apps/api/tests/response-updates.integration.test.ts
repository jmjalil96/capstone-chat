import { randomUUID } from "node:crypto";
import { RESPONSE_UPDATES_MAX_TEXT_UTF8_BYTES } from "@capstone/protocol";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type CursorCodec, createCursorCodec } from "../src/conversations/cursor.js";
import {
  type ConversationService,
  createConversationService,
} from "../src/conversations/service.js";
import { session, user } from "../src/database/auth-schema.generated.js";
import { messages } from "../src/database/conversation-schema.js";
import { type AppDatabase, createDatabase } from "../src/database/database.js";
import { workspaceMemberships, workspaces } from "../src/database/identity-schema.js";
import { migrateDatabase } from "../src/database/migrate.js";
import { ApplicationError } from "../src/errors.js";
import {
  createResponseUpdatesService,
  ResponseUpdatesRequestAborted,
  type ResponseUpdatesService,
} from "../src/generations/response-updates.js";
import { createGenerationService, type GenerationService } from "../src/generations/service.js";
import type { RequestActor } from "../src/identity/authorization.js";
import { createModelPolicyService } from "../src/model-policy/service.js";
import { bootstrapSimulatedModelPolicy } from "./support/model-policy.js";
import { bootstrapTestAssistantRules } from "./support/workspace-behavior.js";

function createActor(userId: string, workspaceId: string, sessionId: string): RequestActor {
  return {
    employee: { email: `${userId}@example.test`, id: userId, name: "Persona" },
    role: "member",
    session: {
      id: sessionId,
      createdAt: new Date("2026-08-15T12:00:00.000Z"),
      expiresAt: new Date("2026-08-22T12:00:00.000Z"),
    },
    workspace: { id: workspaceId, identity: "synthetic", name: "Synthetic" },
  };
}

async function expectCode(operation: Promise<unknown>, code: string): Promise<void> {
  try {
    await operation;
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(ApplicationError);
    expect(error).toMatchObject({ code });
    return;
  }
  throw new Error(`Expected ${code}`);
}

const fastPoll = { deadlineMilliseconds: 120, pollIntervalMilliseconds: 10 } as const;

describe.sequential("durable response updates", () => {
  let container: StartedPostgreSqlContainer;
  let databaseUrl: string;
  let pool: Pool;
  let database: AppDatabase;
  let actor: RequestActor;
  let stranger: RequestActor;
  let conversationsService: ConversationService;
  let cursorCodec: CursorCodec;
  let generationService: GenerationService;
  let updates: ResponseUpdatesService;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:18.4-alpine")
      .withDatabase("capstone_updates")
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
      'TRUNCATE TABLE "generations", "drafts", "messages", "conversations", "workspace_memberships", "employee_approvals", "user", "workspaces", "model_catalog" RESTART IDENTITY CASCADE',
    );
    const workspaceId = randomUUID();
    const workspaceIdentity = `workspace-${randomUUID()}`;
    const userId = `user-${randomUUID()}`;
    const strangerId = `user-${randomUUID()}`;
    const sessionId = `session-${randomUUID()}`;
    const strangerSessionId = `session-${randomUUID()}`;
    await database.insert(workspaces).values({
      displayName: "Synthetic",
      id: workspaceId,
      identity: workspaceIdentity,
    });
    await database.insert(user).values([
      { email: "member@example.test", emailVerified: true, id: userId, name: "Member" },
      { email: "other@example.test", emailVerified: true, id: strangerId, name: "Other" },
    ]);
    const sessionNow = new Date();
    await database.insert(session).values([
      {
        expiresAt: new Date(sessionNow.getTime() + 86_400_000),
        id: sessionId,
        token: `token-${randomUUID()}`,
        updatedAt: sessionNow,
        userId,
      },
      {
        expiresAt: new Date(sessionNow.getTime() + 86_400_000),
        id: strangerSessionId,
        token: `token-${randomUUID()}`,
        updatedAt: sessionNow,
        userId: strangerId,
      },
    ]);
    await database.insert(workspaceMemberships).values([
      { role: "member", userId, workspaceId },
      { role: "member", userId: strangerId, workspaceId },
    ]);
    await bootstrapTestAssistantRules(database, workspaceId);
    await bootstrapSimulatedModelPolicy(createModelPolicyService(database), workspaceIdentity);
    actor = createActor(userId, workspaceId, sessionId);
    stranger = createActor(strangerId, workspaceId, strangerSessionId);
    cursorCodec = createCursorCodec("updates-test-secret-longer-than-thirty-two-characters");
    conversationsService = createConversationService(database, cursorCodec);
    generationService = createGenerationService(database);
    updates = createResponseUpdatesService(database, cursorCodec);
  });

  afterEach(async () => {
    await pool.end();
  });

  afterAll(async () => {
    await container.stop();
  });

  async function startResponse(content: string) {
    const draft = await conversationsService.saveDraft(actor, { kind: "new" }, content, 0);
    const conversation = await conversationsService.create(actor, draft.revision);
    const started = await generationService.startResponse(actor, conversation.id, randomUUID(), {
      content: [{ text: content, type: "text" }],
      draftRevision: draft.revision,
      modelTier: "balanced",
      observedRevision: 0,
      parentMessageId: null,
      source: "draft",
    });
    return { conversation, started };
  }

  it("replays checkpointed content, appends at UTF-8 boundaries, and ends on the terminal state", async () => {
    const { conversation, started } = await startResponse("Pregunta durable");
    const first = await updates.readUpdates(actor, conversation.id, started.generationId, null);
    expect(first).toMatchObject({
      content: { mode: "replace", text: "" },
      conversationId: conversation.id,
      phase: "responding",
      response: { generationId: started.generationId, status: "active" },
    });
    expect(first.nextCursor).not.toBeNull();

    await generationService.checkpoint(started.generationId, "Hola ñandú", new Date());
    const appended = await updates.readUpdates(
      actor,
      conversation.id,
      started.generationId,
      first.nextCursor,
      fastPoll,
    );
    expect(appended.content).toEqual({ mode: "append", text: "Hola ñandú" });
    expect(appended.nextCursor).not.toBeNull();

    // No change within the poll window returns an empty heartbeat with the same position.
    const heartbeat = await updates.readUpdates(
      actor,
      conversation.id,
      started.generationId,
      appended.nextCursor,
      fastPoll,
    );
    expect(heartbeat.content).toEqual({ mode: "append", text: "" });
    expect(heartbeat.response.status).toBe("active");

    // Content that grows during the poll wakes the reader with only the delta.
    const pending = updates.readUpdates(
      actor,
      conversation.id,
      started.generationId,
      heartbeat.nextCursor,
      { deadlineMilliseconds: 2_000, pollIntervalMilliseconds: 10 },
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    await generationService.checkpoint(
      started.generationId,
      "Hola ñandú, ¿cómo estás?",
      new Date(),
    );
    const grown = await pending;
    expect(grown.content).toEqual({ mode: "append", text: ", ¿cómo estás?" });

    // A cursor ahead of durable content (rewound content) returns a safe full replacement.
    const rewound = await updates.readUpdates(
      actor,
      conversation.id,
      started.generationId,
      grown.nextCursor,
      fastPoll,
    );
    expect(rewound.content).toEqual({ mode: "append", text: "" });

    // Completion moves the parent to naming (phase change) and then to terminal.
    const terminal = await generationService.terminalize(started.generationId, {
      content: "Hola ñandú, ¿cómo estás? Bien.",
      errorCode: null,
      firstTokenAt: new Date(),
      reason: "stop",
      status: "completed",
    });
    expect(terminal.naming).toBeDefined();
    const naming = await updates.readUpdates(
      actor,
      conversation.id,
      started.generationId,
      grown.nextCursor,
      fastPoll,
    );
    expect(naming).toMatchObject({
      content: { mode: "append", text: " Bien." },
      phase: "naming",
      response: { errorCode: null, reason: null, status: "active" },
    });
    expect(naming.nextCursor).not.toBeNull();
    await generationService.finalizeNaming({
      conversationId: conversation.id,
      outcome: { kind: "titled", title: "Saludo", usage: { inputTokens: 1, outputTokens: 1 } },
      parentGenerationId: started.generationId,
      titleGenerationId: terminal.naming?.titleGenerationId ?? "",
    });
    const finished = await updates.readUpdates(
      actor,
      conversation.id,
      started.generationId,
      naming.nextCursor,
      fastPoll,
    );
    expect(finished).toMatchObject({
      content: { mode: "append", text: "" },
      nextCursor: null,
      phase: "responding",
      response: { reason: "stop", status: "completed" },
      revision: 2,
    });
    // A naming-phase cursor against a completed parent is not an impossible transition; a
    // fresh null cursor still replays the final answer.
    const replay = await updates.readUpdates(actor, conversation.id, started.generationId, null);
    expect(replay.content).toEqual({ mode: "replace", text: "Hola ñandú, ¿cómo estás? Bien." });
    expect(replay.nextCursor).toBeNull();
  });

  it("hides foreign generations and rejects foreign or malformed cursors", async () => {
    const { conversation, started } = await startResponse("Pregunta privada");
    const other = await startResponse("Otra pregunta");
    await expectCode(
      updates.readUpdates(stranger, conversation.id, started.generationId, null),
      "NOT_FOUND",
    );
    await expectCode(
      updates.readUpdates(actor, other.conversation.id, started.generationId, null),
      "NOT_FOUND",
    );
    const mine = await updates.readUpdates(actor, conversation.id, started.generationId, null);
    await expectCode(
      updates.readUpdates(
        actor,
        other.conversation.id,
        other.started.generationId,
        mine.nextCursor,
      ),
      "INVALID_CURSOR",
    );
    await expectCode(
      updates.readUpdates(actor, conversation.id, started.generationId, "bm90.dmFsaWQ"),
      "INVALID_CURSOR",
    );
    const branchCursor = createCursorCodec(
      "updates-test-secret-longer-than-thirty-two-characters",
    ).encode({ conversationId: conversation.id, kind: "conversation-branch", version: 1 });
    await expectCode(
      updates.readUpdates(actor, conversation.id, started.generationId, branchCursor),
      "INVALID_CURSOR",
    );
    const wrongMessageCursor = cursorCodec.encode({
      conversationId: conversation.id,
      generationId: started.generationId,
      kind: "response-updates",
      messageId: randomUUID(),
      offset: 0,
      phase: "responding",
      version: 1,
    });
    await expectCode(
      updates.readUpdates(actor, conversation.id, started.generationId, wrongMessageCursor),
      "INVALID_CURSOR",
    );
    const missingMessageCursor = cursorCodec.encode({
      conversationId: conversation.id,
      generationId: started.generationId,
      kind: "response-updates",
      offset: 0,
      phase: "responding",
      version: 1,
    });
    await expectCode(
      updates.readUpdates(actor, conversation.id, started.generationId, missingMessageCursor),
      "INVALID_CURSOR",
    );
  });

  it("stops polling promptly when the request closes", async () => {
    const { conversation, started } = await startResponse("Pregunta cerrada");
    const first = await updates.readUpdates(actor, conversation.id, started.generationId, null);
    const closed = new AbortController();
    const startedAt = Date.now();
    const pending = updates.readUpdates(
      actor,
      conversation.id,
      started.generationId,
      first.nextCursor,
      { deadlineMilliseconds: 5_000, pollIntervalMilliseconds: 500, signal: closed.signal },
    );
    setTimeout(() => closed.abort(), 40);
    await expect(pending).rejects.toBeInstanceOf(ResponseUpdatesRequestAborted);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it("fails closed when durable content exceeds the shared response limit", async () => {
    const { conversation, started } = await startResponse("Pregunta acotada");
    await database
      .update(messages)
      .set({
        content: [{ text: "a".repeat(RESPONSE_UPDATES_MAX_TEXT_UTF8_BYTES + 1), type: "text" }],
      })
      .where(eq(messages.id, started.messageId));

    await expect(
      updates.readUpdates(actor, conversation.id, started.generationId, null),
    ).rejects.toThrow("protocol limit");
  });
});

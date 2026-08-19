import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type ApiApplication, createApplication } from "../src/app.js";
import type { Authentication } from "../src/auth/authentication.js";
import { loadConfig } from "../src/config.js";
import {
  type AnswerReportService,
  createAnswerReportService,
  normalizeReportNote,
} from "../src/conversations/answer-reports.js";
import { createCursorCodec } from "../src/conversations/cursor.js";
import {
  type ConversationService,
  createConversationService,
} from "../src/conversations/service.js";
import { answerReports } from "../src/database/answer-report-schema.js";
import { session as authSession, user } from "../src/database/auth-schema.generated.js";
import { conversations, messages } from "../src/database/conversation-schema.js";
import { type AppDatabase, createDatabase } from "../src/database/database.js";
import { workspaceMemberships, workspaces } from "../src/database/identity-schema.js";
import { migrateDatabase } from "../src/database/migrate.js";
import { ApplicationError } from "../src/errors.js";
import { createGenerationService, type GenerationService } from "../src/generations/service.js";
import type { RequestActor } from "../src/identity/authorization.js";
import type { IdentityService } from "../src/identity/service.js";
import { createModelPolicyService } from "../src/model-policy/service.js";
import { bootstrapSimulatedModelPolicy } from "./support/model-policy.js";

function createActor(userId: string, workspaceId: string, name: string): RequestActor {
  return {
    employee: { email: `${userId}@example.test`, id: userId, name },
    role: "member",
    session: {
      createdAt: new Date("2026-08-15T12:00:00.000Z"),
      expiresAt: new Date("2026-08-22T12:00:00.000Z"),
      id: `session-${userId}`,
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

describe("report note normalization", () => {
  it("normalizes, trims, and bounds notes", () => {
    expect(normalizeReportNote(undefined)).toBeNull();
    expect(normalizeReportNote("  Falta el IVA.\r\n  ")).toBe("Falta el IVA.");
    expect(() => normalizeReportNote("   ")).toThrow(ApplicationError);
    expect(() => normalizeReportNote("\ud800")).toThrow(ApplicationError);
    expect(() => normalizeReportNote("ab")).toThrow(ApplicationError);
    expect(() => normalizeReportNote("x".repeat(1_001))).toThrow(ApplicationError);
    expect(normalizeReportNote("é".repeat(1_000))).toHaveLength(1_000);
  });
});

describe.sequential("answer reports", () => {
  let container: StartedPostgreSqlContainer;
  let databaseUrl: string;
  let pool: Pool;
  let database: AppDatabase;
  let actor: RequestActor;
  let stranger: RequestActor;
  let workspaceId: string;
  let conversationsService: ConversationService;
  let generationService: GenerationService;
  let reports: AnswerReportService;
  let application: ApiApplication | undefined;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:18.4-alpine")
      .withDatabase("capstone_reports")
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
      'TRUNCATE TABLE "answer_reports", "generations", "drafts", "messages", "conversations", "workspace_memberships", "employee_approvals", "user", "workspaces", "model_catalog" RESTART IDENTITY CASCADE',
    );
    workspaceId = randomUUID();
    const workspaceIdentity = `workspace-${randomUUID()}`;
    const userId = `user-${randomUUID()}`;
    const strangerId = `user-${randomUUID()}`;
    const actorSessionTime = new Date("2026-08-15T12:00:00.000Z");
    await database.insert(workspaces).values({
      displayName: "Synthetic",
      id: workspaceId,
      identity: workspaceIdentity,
    });
    await database.insert(user).values([
      { email: `${userId}@example.test`, emailVerified: true, id: userId, name: "Ana Pérez" },
      { email: `${strangerId}@example.test`, emailVerified: true, id: strangerId, name: "Otro" },
    ]);
    await database.insert(authSession).values([
      {
        createdAt: actorSessionTime,
        expiresAt: new Date("2026-08-22T12:00:00.000Z"),
        id: `session-${userId}`,
        token: `token-${userId}`,
        updatedAt: actorSessionTime,
        userId,
      },
      {
        createdAt: actorSessionTime,
        expiresAt: new Date("2026-08-22T12:00:00.000Z"),
        id: `session-${strangerId}`,
        token: `token-${strangerId}`,
        updatedAt: actorSessionTime,
        userId: strangerId,
      },
    ]);
    await database.insert(workspaceMemberships).values([
      { role: "member", userId, workspaceId },
      { role: "member", userId: strangerId, workspaceId },
    ]);
    await bootstrapSimulatedModelPolicy(createModelPolicyService(database), workspaceIdentity);
    actor = createActor(userId, workspaceId, "Ana Pérez");
    stranger = createActor(strangerId, workspaceId, "Otro");
    const cursorCodec = createCursorCodec("reports-test-secret-longer-than-thirty-two-characters");
    conversationsService = createConversationService(database, cursorCodec);
    generationService = createGenerationService(database);
    reports = createAnswerReportService(database, cursorCodec);
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

  async function answeredConversation(prompt: string) {
    const draft = await conversationsService.saveDraft(actor, { kind: "new" }, prompt, 0);
    const conversation = await conversationsService.create(actor, draft.revision);
    const started = await generationService.startResponse(actor, conversation.id, randomUUID(), {
      content: [{ text: prompt, type: "text" }],
      draftRevision: draft.revision,
      modelTier: "balanced",
      observedRevision: 0,
      parentMessageId: null,
      source: "draft",
    });
    return { conversation, started };
  }

  async function settle(
    started: { generationId: string },
    content: string,
    status: "completed" | "failed" = "completed",
  ) {
    const terminal = await generationService.terminalize(started.generationId, {
      content,
      errorCode: status === "failed" ? "GENERATION_FAILED" : null,
      firstTokenAt: status === "failed" ? null : new Date(),
      reason: status === "failed" ? "error" : "stop",
      status,
    });
    if (terminal.won && terminal.naming !== undefined && terminal.conversationId !== null) {
      await generationService.finalizeNaming({
        conversationId: terminal.conversationId,
        outcome: { errorCode: "GENERATION_FAILED", kind: "failed" },
        parentGenerationId: started.generationId,
        titleGenerationId: terminal.naming.titleGenerationId,
      });
    }
  }

  it("creates one immutable report per answer and exposes only the consented pair", async () => {
    const { conversation, started } = await answeredConversation("¿Cuál es la prima?");
    await expectCode(
      reports.create(actor, conversation.id, started.messageId, {
        reason: "incorrect",
        sharePromptAndAnswer: true,
      }),
      "GENERATION_ACTIVE",
    );
    await settle(started, "La prima es 120 USD.");
    const created = await reports.create(actor, conversation.id, started.messageId, {
      note: "  El monto está desactualizado.  ",
      reason: "outdated",
      sharePromptAndAnswer: true,
    });
    expect(created).toMatchObject({ messageId: started.messageId, repeated: false });
    const repeated = await reports.create(actor, conversation.id, started.messageId, {
      note: "Otra nota que no debe guardarse",
      reason: "unsafe",
      sharePromptAndAnswer: true,
    });
    expect(repeated).toEqual({ ...created, repeated: true });

    await expect(
      reports.reportedStates(actor, conversation.id, [started.messageId, started.userMessageId]),
    ).resolves.toEqual({
      conversationId: conversation.id,
      reportedMessageIds: [started.messageId],
    });
    await expectCode(
      reports.reportedStates(stranger, conversation.id, [started.messageId]),
      "NOT_FOUND",
    );

    const inbox = await reports.listForWorkspace(workspaceId);
    expect(inbox.nextCursor).toBeNull();
    expect(inbox.items).toEqual([
      {
        createdAt: created.createdAt,
        id: created.id,
        note: "El monto está desactualizado.",
        reason: "outdated",
        reporter: { email: actor.employee.email, name: "Ana Pérez" },
      },
    ]);
    const detail = await reports.detailForWorkspace(workspaceId, created.id);
    expect(detail).toEqual({
      ...inbox.items[0],
      exchange: { answer: "La prima es 120 USD.", prompt: "¿Cuál es la prima?" },
    });
    // Privacy canary: no conversation, message, or generation identity escapes.
    const serialized = JSON.stringify([inbox, detail]);
    expect(serialized).not.toContain(conversation.id);
    expect(serialized).not.toContain(started.messageId);
    expect(serialized).not.toContain(started.generationId);
    expect(serialized).not.toContain(started.userMessageId);
    await expectCode(reports.detailForWorkspace(randomUUID(), created.id), "NOT_FOUND");
  });

  it("coalesces concurrent first submissions without changing the winning reason or note", async () => {
    const { conversation, started } = await answeredConversation("¿Cuál es el deducible?");
    await settle(started, "El deducible es 500 USD.");
    const inputs = [
      { note: "Primera candidata", reason: "incorrect", sharePromptAndAnswer: true },
      { note: "Segunda candidata", reason: "outdated", sharePromptAndAnswer: true },
      { note: "Tercera candidata", reason: "other", sharePromptAndAnswer: true },
    ] as const;

    const results = await Promise.all(
      inputs.map((input) => reports.create(actor, conversation.id, started.messageId, input)),
    );
    expect(new Set(results.map(({ id }) => id)).size).toBe(1);
    expect(results.filter(({ repeated }) => !repeated)).toHaveLength(1);
    expect(results.filter(({ repeated }) => repeated)).toHaveLength(2);

    const winnerIndex = results.findIndex(({ repeated }) => !repeated);
    const stored = await database
      .select({ note: answerReports.note, reason: answerReports.reason })
      .from(answerReports)
      .where(eq(answerReports.assistantMessageId, started.messageId));
    expect(stored).toEqual([
      { note: inputs[winnerIndex]?.note, reason: inputs[winnerIndex]?.reason },
    ]);
  });

  it("returns not found instead of an FK failure when deletion wins the creation race", async () => {
    const { conversation, started } = await answeredConversation("Pregunta que se eliminará");
    await settle(started, "Respuesta que se eliminará");
    const deletion = await pool.connect();
    try {
      await deletion.query("BEGIN");
      await deletion.query("SELECT id FROM conversations WHERE id = $1 FOR UPDATE", [
        conversation.id,
      ]);
      const creating = reports.create(actor, conversation.id, started.messageId, {
        reason: "other",
        sharePromptAndAnswer: true,
      });
      await deletion.query(
        "UPDATE generations SET conversation_id = NULL WHERE conversation_id = $1 AND purpose IN ('compaction', 'title')",
        [conversation.id],
      );
      await deletion.query("DELETE FROM conversations WHERE id = $1", [conversation.id]);
      await deletion.query("COMMIT");
      await expectCode(creating, "NOT_FOUND");
    } catch (error) {
      await deletion.query("ROLLBACK");
      throw error;
    } finally {
      deletion.release();
    }
    await expect(database.select().from(answerReports)).resolves.toEqual([]);
  });

  it("cascades a report when its source answer is removed", async () => {
    const { conversation, started } = await answeredConversation("Pregunta con respuesta removida");
    await settle(started, "Respuesta removida");
    const report = await reports.create(actor, conversation.id, started.messageId, {
      reason: "other",
      sharePromptAndAnswer: true,
    });

    await database.transaction(async (transaction) => {
      await transaction
        .update(conversations)
        .set({ selectedLeafMessageId: started.userMessageId })
        .where(eq(conversations.id, conversation.id));
      await transaction.delete(messages).where(eq(messages.id, started.messageId));
    });

    await expectCode(reports.detailForWorkspace(workspaceId, report.id), "NOT_FOUND");
    await expect(database.select().from(answerReports)).resolves.toEqual([]);
  });

  it("enforces route authorization and mutation boundaries without logging report content", async () => {
    const privatePrompt = "PRIVATE_REPORT_PROMPT_CANARY";
    const privateAnswer = "PRIVATE_REPORT_ANSWER_CANARY";
    const privateNote = "PRIVATE_REPORT_NOTE_CANARY";
    const { conversation, started } = await answeredConversation(privatePrompt);
    await settle(started, privateAnswer);

    let authenticated = false;
    let role: "admin" | "member" = "member";
    let resolvedWorkspaceId = workspaceId;
    const authentication = {
      auth: {
        api: {
          getSession: async () => ({
            headers: new Headers(),
            response: authenticated
              ? {
                  session: {
                    createdAt: actor.session.createdAt,
                    expiresAt: actor.session.expiresAt,
                    id: actor.session.id,
                  },
                  user: {
                    email: actor.employee.email,
                    emailVerified: true,
                    id: actor.employee.id,
                    name: actor.employee.name,
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
          role,
          workspaceDisplayName: actor.workspace.name,
          workspaceId: resolvedWorkspaceId,
          workspaceIdentity: actor.workspace.identity,
        },
      ],
    } as unknown as IdentityService;
    const logLines: string[] = [];
    application = createApplication(
      loadConfig({
        DATABASE_URL: databaseUrl,
        LOG_LEVEL: "info",
        NODE_ENV: "test",
        PUBLIC_ORIGIN: "http://localhost:5173",
      }),
      {
        authentication,
        identity,
        loggerStream: { write: (line) => logLines.push(line) },
        pool: new Pool({ connectionString: databaseUrl }),
        requestIdFactory: () => "answer-report-request-id",
      },
    );

    const anonymous = await application.server.inject({
      method: "GET",
      url: "/api/admin/answer-reports",
    });
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.json()).toMatchObject({ code: "AUTHENTICATION_REQUIRED" });

    authenticated = true;
    const forbidden = await application.server.inject({
      method: "GET",
      url: "/api/admin/answer-reports",
    });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json()).toMatchObject({ code: "ADMIN_ACCESS_REQUIRED" });

    const reportUrl = `/api/conversations/${conversation.id}/messages/${started.messageId}/report`;
    const wrongOrigin = await application.server.inject({
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      method: "POST",
      payload: { reason: "other", sharePromptAndAnswer: true },
      url: reportUrl,
    });
    expect(wrongOrigin.statusCode).toBe(403);
    const wrongType = await application.server.inject({
      headers: { "content-type": "text/plain", origin: "http://localhost:5173" },
      method: "POST",
      payload: JSON.stringify({ reason: "other", sharePromptAndAnswer: true }),
      url: reportUrl,
    });
    expect(wrongType.statusCode).toBe(415);
    expect(wrongType.json()).toMatchObject({ code: "JSON_REQUIRED" });
    const missingConsent = await application.server.inject({
      headers: { "content-type": "application/json", origin: "http://localhost:5173" },
      method: "POST",
      payload: { reason: "other", sharePromptAndAnswer: false },
      url: reportUrl,
    });
    expect(missingConsent.statusCode).toBe(400);
    const oversized = await application.server.inject({
      headers: { "content-type": "application/json", origin: "http://localhost:5173" },
      method: "POST",
      payload: {
        note: "x".repeat(8_193),
        reason: "other",
        sharePromptAndAnswer: true,
      },
      url: reportUrl,
    });
    expect(oversized.statusCode).toBe(413);

    const created = await application.server.inject({
      headers: { "content-type": "application/json", origin: "http://localhost:5173" },
      method: "POST",
      payload: { note: privateNote, reason: "incorrect", sharePromptAndAnswer: true },
      url: reportUrl,
    });
    expect(created.statusCode).toBe(200);
    expect(created.headers["cache-control"]).toBe("no-store");
    const createdBody = created.json<{ id: string; repeated: boolean }>();
    expect(createdBody.repeated).toBe(false);

    const repeated = await application.server.inject({
      headers: { "content-type": "application/json", origin: "http://localhost:5173" },
      method: "POST",
      payload: { reason: "unsafe", sharePromptAndAnswer: true },
      url: reportUrl,
    });
    expect(repeated.statusCode).toBe(200);
    expect(repeated.json()).toMatchObject({ id: createdBody.id, repeated: true });

    const states = await application.server.inject({
      headers: { "content-type": "application/json", origin: "http://localhost:5173" },
      method: "POST",
      payload: { messageIds: [started.userMessageId, started.messageId] },
      url: `/api/conversations/${conversation.id}/answer-report-states`,
    });
    expect(states.statusCode).toBe(200);
    expect(states.json()).toEqual({
      conversationId: conversation.id,
      reportedMessageIds: [started.messageId],
    });

    role = "admin";
    const list = await application.server.inject({
      method: "GET",
      url: "/api/admin/answer-reports",
    });
    expect(list.statusCode).toBe(200);
    expect(list.headers["cache-control"]).toBe("no-store");
    expect(list.json()).toMatchObject({
      items: [{ id: createdBody.id, note: privateNote, reason: "incorrect" }],
      nextCursor: null,
    });
    const detail = await application.server.inject({
      method: "GET",
      url: `/api/admin/answer-reports/${createdBody.id}`,
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({
      exchange: { answer: privateAnswer, prompt: privatePrompt },
      id: createdBody.id,
    });
    expect(JSON.stringify(detail.json())).not.toMatch(
      new RegExp(`${conversation.id}|${started.messageId}|${started.generationId}`, "u"),
    );

    resolvedWorkspaceId = randomUUID();
    const foreign = await application.server.inject({
      method: "GET",
      url: `/api/admin/answer-reports/${createdBody.id}`,
    });
    expect(foreign.statusCode).toBe(404);
    const privateCursor = await application.server.inject({
      method: "GET",
      url: "/api/admin/answer-reports?cursor=PRIVATE_REPORT_CURSOR_CANARY",
    });
    expect(privateCursor.statusCode).toBe(400);

    const exportedLogs = logLines.join("\n");
    expect(exportedLogs).not.toMatch(/PRIVATE_REPORT_(?:PROMPT|ANSWER|NOTE|CURSOR)_CANARY/gu);
    expect(exportedLogs).not.toContain(conversation.id);
    expect(exportedLogs).not.toContain(started.messageId);
    expect(exportedLogs).not.toContain(started.generationId);
    expect(exportedLogs).not.toContain(createdBody.id);
    expect(exportedLogs).toContain(
      '"route":"/api/conversations/:conversationId/messages/:messageId/report"',
    );
    expect(exportedLogs).toContain('"route":"/api/admin/answer-reports/:reportId"');
  });

  it("rejects ineligible targets and hides foreign conversations", async () => {
    const { conversation, started } = await answeredConversation("Pregunta ajena");
    await settle(started, "Respuesta");
    await expectCode(
      reports.create(stranger, conversation.id, started.messageId, {
        reason: "other",
        sharePromptAndAnswer: true,
      }),
      "NOT_FOUND",
    );
    await expectCode(
      reports.create(actor, conversation.id, started.userMessageId, {
        reason: "other",
        sharePromptAndAnswer: true,
      }),
      "BAD_REQUEST",
    );
    await expectCode(
      reports.create(actor, conversation.id, randomUUID(), {
        reason: "other",
        sharePromptAndAnswer: true,
      }),
      "NOT_FOUND",
    );
    await expectCode(
      reports.create(actor, conversation.id, started.messageId, {
        note: "   ",
        reason: "other",
        sharePromptAndAnswer: true,
      }),
      "BAD_REQUEST",
    );
    const failed = await answeredConversation("Pregunta fallida");
    await settle(failed.started, "", "failed");
    await expectCode(
      reports.create(actor, failed.conversation.id, failed.started.messageId, {
        reason: "incomplete",
        sharePromptAndAnswer: true,
      }),
      "BAD_REQUEST",
    );
    // Archived conversations remain reportable.
    await conversationsService.setArchived(actor, conversation.id, true, 2);
    await expect(
      reports.create(actor, conversation.id, started.messageId, {
        reason: "incomplete",
        sharePromptAndAnswer: true,
      }),
    ).resolves.toMatchObject({ repeated: false });
  });

  it("accepts nonblank partial failures and refusal answers", async () => {
    const partial = await answeredConversation("Pregunta con respuesta parcial");
    await settle(partial.started, "Contenido parcial útil", "failed");
    await expect(
      reports.create(actor, partial.conversation.id, partial.started.messageId, {
        reason: "incomplete",
        sharePromptAndAnswer: true,
      }),
    ).resolves.toMatchObject({ repeated: false });

    const refusal = await answeredConversation("Pregunta rechazada");
    await generationService.terminalize(refusal.started.generationId, {
      content: "No puedo ayudar con esa solicitud.",
      errorCode: null,
      firstTokenAt: new Date(),
      reason: "refusal",
      status: "completed",
    });
    await expect(
      reports.create(actor, refusal.conversation.id, refusal.started.messageId, {
        reason: "unsafe",
        sharePromptAndAnswer: true,
      }),
    ).resolves.toMatchObject({ repeated: false });
  });

  it("paginates with a signed workspace cursor and remains stable when its boundary is deleted", async () => {
    const created: string[] = [];
    for (let index = 0; index < 51; index += 1) {
      const { conversation, started } = await answeredConversation(`Pregunta ${index}`);
      await settle(started, `Respuesta ${index}`);
      const report = await reports.create(actor, conversation.id, started.messageId, {
        reason: "other",
        sharePromptAndAnswer: true,
      });
      created.push(report.id);
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    const first = await reports.listForWorkspace(workspaceId);
    expect(first.items).toHaveLength(50);
    expect(first.items.map((item) => item.id)).toEqual(created.slice(1).reverse());
    expect(first.nextCursor).not.toBeNull();
    if (first.nextCursor === null) {
      throw new Error("Expected a second report page");
    }
    await expectCode(reports.listForWorkspace(randomUUID(), first.nextCursor), "INVALID_CURSOR");
    const tampered = `${first.nextCursor.slice(0, -1)}${first.nextCursor.endsWith("a") ? "b" : "a"}`;
    await expectCode(reports.listForWorkspace(workspaceId, tampered), "INVALID_CURSOR");

    const boundary = first.items.at(-1);
    if (boundary === undefined) {
      throw new Error("Expected a report-page boundary");
    }
    await database.delete(answerReports).where(eq(answerReports.id, boundary.id));
    const second = await reports.listForWorkspace(workspaceId, first.nextCursor);
    expect(second.items.map((item) => item.id)).toEqual([created[0]]);
    expect(second.nextCursor).toBeNull();
  });
});

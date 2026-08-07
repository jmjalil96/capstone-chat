import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
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
import { user } from "../src/database/auth-schema.generated.js";
import { conversations, drafts, messages } from "../src/database/conversation-schema.js";
import { type AppDatabase, createDatabase } from "../src/database/database.js";
import { generations } from "../src/database/generation-schema.js";
import { workspaces } from "../src/database/identity-schema.js";
import { migrateDatabase } from "../src/database/migrate.js";
import { ApplicationError } from "../src/errors.js";
import { FakeModelGateway } from "../src/generations/fake-model-gateway.js";
import type { ModelGateway } from "../src/generations/model-gateway.js";
import { continueMessage, systemPrompt } from "../src/generations/prompt.js";
import { createGenerationService, type GenerationService } from "../src/generations/service.js";
import type { RequestActor } from "../src/identity/authorization.js";
import type { IdentityService } from "../src/identity/service.js";

function createActor(userId: string, workspaceId: string): RequestActor {
  return {
    employee: { email: "member@example.test", id: userId, name: "Persona sintética" },
    role: "member",
    session: {
      createdAt: new Date("2026-08-07T12:00:00.000Z"),
      expiresAt: new Date("2026-08-14T12:00:00.000Z"),
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

describe.sequential("generation lifecycle integration", () => {
  let container: StartedPostgreSqlContainer;
  let databaseUrl: string;
  let pool: Pool;
  let database: AppDatabase;
  let actor: RequestActor;
  let conversationsService: ConversationService;
  let generationService: GenerationService;
  let application: ApiApplication | undefined;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:18.4-alpine")
      .withDatabase("capstone_generations")
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
      'TRUNCATE TABLE "generations", "drafts", "messages", "conversations", "workspace_memberships", "employee_approvals", "user", "workspaces" RESTART IDENTITY CASCADE',
    );
    const workspaceId = randomUUID();
    const userId = `user-${randomUUID()}`;
    await database.insert(workspaces).values({
      displayName: "Synthetic",
      id: workspaceId,
      identity: `workspace-${randomUUID()}`,
    });
    await database.insert(user).values({
      email: "member@example.test",
      emailVerified: true,
      id: userId,
      name: "Member",
    });
    actor = createActor(userId, workspaceId);
    conversationsService = createConversationService(
      database,
      createCursorCodec("generation-test-secret-longer-than-thirty-two-characters"),
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

  async function adoptedConversation(content: string) {
    const draft = await conversationsService.saveDraft(actor, { kind: "new" }, content, 0);
    const conversation = await conversationsService.create(actor, draft.revision);
    expect(
      await conversationsService.getDraft(actor, {
        conversationId: conversation.id,
        kind: "conversation",
      }),
    ).toMatchObject({ content, revision: draft.revision });
    return { conversation, draft };
  }

  it("adopts and consumes a confirmed draft, checkpoints, completes, and continues", async () => {
    const { conversation, draft } = await adoptedConversation("Primera pregunta");
    const started = await generationService.startResponse(actor, conversation.id, randomUUID(), {
      content: [{ text: "Primera pregunta", type: "text" }],
      draftRevision: draft.revision,
      modelTier: "balanced",
      observedRevision: 0,
      parentMessageId: null,
      source: "draft",
    });

    expect(started).toMatchObject({ conversationId: conversation.id, revision: 1 });
    expect(started.request).toEqual({
      history: [],
      message: { role: "user", text: "Primera pregunta" },
      modelTier: "balanced",
      systemPrompt,
    });
    expect(
      await conversationsService.getDraft(actor, {
        conversationId: conversation.id,
        kind: "conversation",
      }),
    ).toMatchObject({ content: "", revision: 0 });
    const generation = (await database.select().from(generations))[0];
    expect(generation).toMatchObject({
      assistantMessageId: started.messageId,
      effectiveParameters: {},
      requestedTier: "balanced",
      status: "active",
      systemPromptVersion: "capstone-chat-v1",
    });

    const firstTokenAt = new Date(Date.now() + 10);
    expect(await generationService.checkpoint(started.generationId, "Parcial", firstTokenAt)).toBe(
      true,
    );
    const terminal = await generationService.terminalize(started.generationId, {
      content: "Respuesta limitada",
      errorCode: null,
      firstTokenAt,
      reason: "length",
      status: "completed",
    });
    expect(terminal).toMatchObject({
      reason: "length",
      revision: 2,
      status: "completed",
      won: true,
    });
    expect(await generationService.checkpoint(started.generationId, "late", firstTokenAt)).toBe(
      false,
    );
    expect(
      await generationService.responseStates(actor, conversation.id, [started.messageId]),
    ).toEqual({
      conversationId: conversation.id,
      responses: [
        {
          errorCode: null,
          generationId: started.generationId,
          messageId: started.messageId,
          reason: "length",
          status: "completed",
        },
      ],
      revision: 2,
    });

    const nextDraft = await conversationsService.saveDraft(
      actor,
      { conversationId: conversation.id, kind: "conversation" },
      "Borrador separado",
      0,
    );
    const continued = await generationService.startResponse(actor, conversation.id, randomUUID(), {
      modelTier: "balanced",
      observedRevision: 2,
      parentMessageId: started.messageId,
      source: "continue",
    });
    expect(continued.request.message.text).toBe(continueMessage.text);
    expect(
      await conversationsService.getDraft(actor, {
        conversationId: conversation.id,
        kind: "conversation",
      }),
    ).toMatchObject(nextDraft);
    const visible = await conversationsService.get(actor, conversation.id);
    expect(visible.messages.map((message) => message.content[0]?.text)).toContain(
      continueMessage.text,
    );
  });

  it("orders idempotency ahead of active conflicts and cancels idempotently", async () => {
    const { conversation, draft } = await adoptedConversation("Pregunta segura");
    const idempotencyKey = randomUUID();
    const input = {
      content: [{ text: "Pregunta segura", type: "text" as const }],
      draftRevision: draft.revision,
      modelTier: "balanced" as const,
      observedRevision: 0,
      parentMessageId: null,
      source: "draft" as const,
    };
    const started = await generationService.startResponse(
      actor,
      conversation.id,
      idempotencyKey,
      input,
    );
    await expectCode(
      generationService.startResponse(actor, conversation.id, idempotencyKey, input),
      "GENERATION_ALREADY_EXISTS",
    );
    await expectCode(
      generationService.startResponse(actor, conversation.id, randomUUID(), {
        ...input,
        observedRevision: 1,
        parentMessageId: started.messageId,
      }),
      "GENERATION_ACTIVE",
    );
    await expectCode(
      conversationsService.selectLeaf(actor, conversation.id, started.userMessageId, 1),
      "GENERATION_ACTIVE",
    );
    const otherUserId = `user-${randomUUID()}`;
    await database.insert(user).values({
      email: "other-member@example.test",
      emailVerified: true,
      id: otherUserId,
      name: "Other member",
    });
    const otherActor = createActor(otherUserId, actor.workspace.id);
    await expectCode(
      generationService.cancel(otherActor, conversation.id, started.generationId),
      "NOT_FOUND",
    );
    await expectCode(
      generationService.responseStates(otherActor, conversation.id, [started.messageId]),
      "NOT_FOUND",
    );

    const cancellationFloor = new Date(Date.now() + 60_000);
    await database
      .update(generations)
      .set({
        createdAt: cancellationFloor,
        startedAt: cancellationFloor,
        updatedAt: cancellationFloor,
      })
      .where(eq(generations.id, started.generationId));
    expect(await generationService.cancel(actor, conversation.id, started.generationId)).toBe(true);
    expect(await generationService.cancel(actor, conversation.id, started.generationId)).toBe(
      false,
    );
    expect(await generationService.readState(started.generationId)).toMatchObject({
      reason: "cancelled",
      revision: 2,
      status: "cancelled",
    });
    const cancelled = (await database.select().from(generations))[0];
    expect(cancelled?.completedAt?.getTime()).toBeGreaterThanOrEqual(cancellationFloor.getTime());
    expect(cancelled?.updatedAt.getTime()).toBeGreaterThanOrEqual(cancellationFloor.getTime());
  });

  it("keeps the latest durable checkpoint when another replica cancels", async () => {
    const { conversation, draft } = await adoptedConversation("Pregunta entre réplicas");
    const started = await generationService.startResponse(actor, conversation.id, randomUUID(), {
      content: [{ text: "Pregunta entre réplicas", type: "text" }],
      draftRevision: draft.revision,
      modelTier: "balanced",
      observedRevision: 0,
      parentMessageId: null,
      source: "draft",
    });
    const firstTokenAt = new Date();
    expect(
      await generationService.checkpoint(
        started.generationId,
        "Último checkpoint durable",
        firstTokenAt,
      ),
    ).toBe(true);

    const replicaPool = new Pool({ connectionString: databaseUrl });
    const replica = createGenerationService(createDatabase(replicaPool));
    try {
      expect(await replica.cancel(actor, conversation.id, started.generationId)).toBe(true);
    } finally {
      await replicaPool.end();
    }

    const canonical = await conversationsService.get(actor, conversation.id);
    expect(canonical.messages.at(-1)?.content).toEqual([
      { text: "Último checkpoint durable", type: "text" },
    ]);
    expect(await generationService.readState(started.generationId)).toMatchObject({
      reason: "cancelled",
      revision: 2,
      status: "cancelled",
    });
    const stored = (await database.select().from(generations))[0];
    expect(stored?.firstTokenAt?.getTime()).toBeGreaterThanOrEqual(firstTokenAt.getTime());
    expect(
      await generationService.checkpoint(
        started.generationId,
        "Texto no durable de la otra réplica",
        new Date(),
      ),
    ).toBe(false);
    expect(
      await generationService.terminalize(started.generationId, {
        content: "Final tardío",
        errorCode: null,
        firstTokenAt: new Date(),
        reason: "stop",
        status: "completed",
      }),
    ).toMatchObject({ reason: "cancelled", status: "cancelled", won: false });
  });

  it("clamps gateway timestamps to authoritative database lifecycle floors", async () => {
    const { conversation, draft } = await adoptedConversation("Pregunta con reloj adelantado");
    const started = await generationService.startResponse(actor, conversation.id, randomUUID(), {
      content: [{ text: "Pregunta con reloj adelantado", type: "text" }],
      draftRevision: draft.revision,
      modelTier: "balanced",
      observedRevision: 0,
      parentMessageId: null,
      source: "draft",
    });
    const databaseFloor = new Date(Date.now() + 60_000);
    await database
      .update(generations)
      .set({ createdAt: databaseFloor, startedAt: databaseFloor, updatedAt: databaseFloor })
      .where(eq(generations.id, started.generationId));

    const terminal = await generationService.terminalize(started.generationId, {
      content: "Respuesta segura",
      errorCode: null,
      firstTokenAt: new Date(0),
      reason: "stop",
      status: "completed",
    });
    expect(terminal.won).toBe(true);
    const stored = (await database.select().from(generations))[0];
    expect(stored?.firstTokenAt?.getTime()).toBeGreaterThanOrEqual(databaseFloor.getTime());
    expect(stored?.completedAt?.getTime()).toBeGreaterThanOrEqual(databaseFloor.getTime());
    expect(stored?.updatedAt.getTime()).toBeGreaterThanOrEqual(databaseFloor.getTime());
  });

  it("atomically cancels deletion and retains only non-content generation metadata", async () => {
    const { conversation, draft } = await adoptedConversation("Pregunta eliminable");
    const started = await generationService.startResponse(actor, conversation.id, randomUUID(), {
      content: [{ text: "Pregunta eliminable", type: "text" }],
      draftRevision: draft.revision,
      modelTier: "balanced",
      observedRevision: 0,
      parentMessageId: null,
      source: "draft",
    });
    const deletionFloor = new Date(Date.now() + 60_000);
    await database
      .update(generations)
      .set({ createdAt: deletionFloor, startedAt: deletionFloor, updatedAt: deletionFloor })
      .where(eq(generations.id, started.generationId));
    await generationService.checkpoint(
      started.generationId,
      "Contenido privado parcial",
      new Date(),
    );
    expect(await generationService.removeConversation(actor, conversation.id, 1)).toBe(
      started.generationId,
    );

    expect(await database.select().from(conversations)).toEqual([]);
    expect(await database.select().from(messages)).toEqual([]);
    expect(await database.select().from(drafts)).toEqual([]);
    const retainedGenerations = await database.select().from(generations);
    expect(retainedGenerations).toMatchObject([
      {
        assistantMessageId: null,
        conversationId: null,
        errorCode: null,
        status: "cancelled",
        terminalReason: "cancelled",
      },
    ]);
    expect(retainedGenerations[0]?.firstTokenAt?.getTime()).toBeGreaterThanOrEqual(
      deletionFloor.getTime(),
    );
    expect(retainedGenerations[0]?.completedAt?.getTime()).toBeGreaterThanOrEqual(
      deletionFloor.getTime(),
    );
  });

  it("does not create a conversation when draft adoption is stale or empty", async () => {
    const saved = await conversationsService.saveDraft(actor, { kind: "new" }, "Texto", 0);
    await expectCode(conversationsService.create(actor, saved.revision + 1), "DRAFT_CHANGED");
    expect(await database.select().from(conversations)).toEqual([]);
    await conversationsService.saveDraft(actor, { kind: "new" }, "   ", saved.revision);
    await expectCode(conversationsService.create(actor, saved.revision + 1), "BAD_REQUEST");
    expect(await database.select().from(conversations)).toEqual([]);
  });

  it("bounds authoritative context before persistence and preserves the draft", async () => {
    const conversation = await conversationsService.create(actor);
    const root = await conversationsService.insertImmutableMessage(actor, {
      content: [{ text: "context root", type: "text" }],
      conversationId: conversation.id,
      parentMessageId: null,
      role: "user",
    });
    const oversizedAssistant = await conversationsService.insertImmutableMessage(actor, {
      content: [{ text: "x".repeat(1_048_000), type: "text" }],
      conversationId: conversation.id,
      parentMessageId: root.id,
      role: "assistant",
    });
    await database
      .update(conversations)
      .set({ selectedLeafMessageId: oversizedAssistant.id })
      .where(eq(conversations.id, conversation.id));
    const draft = await conversationsService.saveDraft(
      actor,
      { conversationId: conversation.id, kind: "conversation" },
      "Nueva pregunta",
      0,
    );

    await expectCode(
      generationService.startResponse(actor, conversation.id, randomUUID(), {
        content: [{ text: "Nueva pregunta", type: "text" }],
        draftRevision: draft.revision + 1,
        modelTier: "balanced",
        observedRevision: 0,
        parentMessageId: oversizedAssistant.id,
        source: "draft",
      }),
      "DRAFT_CHANGED",
    );
    await expectCode(
      generationService.startResponse(actor, conversation.id, randomUUID(), {
        content: [{ text: "Nueva pregunta", type: "text" }],
        draftRevision: draft.revision,
        modelTier: "balanced",
        observedRevision: 0,
        parentMessageId: oversizedAssistant.id,
        source: "draft",
      }),
      "MESSAGE_TOO_LARGE",
    );
    expect(await database.select().from(generations)).toEqual([]);
    expect(await database.select().from(messages)).toHaveLength(2);
    expect(
      await conversationsService.getDraft(actor, {
        conversationId: conversation.id,
        kind: "conversation",
      }),
    ).toMatchObject(draft);
  });

  it("serializes concurrent sends as one start and one active conflict", async () => {
    const { conversation, draft } = await adoptedConversation("Pregunta concurrente");
    const input = {
      content: [{ text: "Pregunta concurrente", type: "text" as const }],
      draftRevision: draft.revision,
      modelTier: "balanced" as const,
      observedRevision: 0,
      parentMessageId: null,
      source: "draft" as const,
    };
    const results = await Promise.allSettled([
      generationService.startResponse(actor, conversation.id, randomUUID(), input),
      generationService.startResponse(actor, conversation.id, randomUUID(), input),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({
      reason: { code: "GENERATION_ACTIVE" },
      status: "rejected",
    });
  });

  it("resolves completion and deletion without a lock inversion", async () => {
    const { conversation, draft } = await adoptedConversation("Pregunta de carrera");
    const started = await generationService.startResponse(actor, conversation.id, randomUUID(), {
      content: [{ text: "Pregunta de carrera", type: "text" }],
      draftRevision: draft.revision,
      modelTier: "balanced",
      observedRevision: 0,
      parentMessageId: null,
      source: "draft",
    });
    const outcomes = await Promise.race([
      Promise.allSettled([
        generationService.terminalize(started.generationId, {
          content: "Respuesta de carrera",
          errorCode: null,
          firstTokenAt: new Date(),
          reason: "stop",
          status: "completed",
        }),
        generationService.removeConversation(actor, conversation.id, 1),
      ]),
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error("Generation deletion race timed out")), 2_000);
      }),
    ]);
    expect(outcomes).toHaveLength(2);
    const state = await generationService.readState(started.generationId);
    expect(state).toMatchObject({ status: expect.stringMatching(/^(cancelled|completed)$/u) });
    expect(
      await generationService.checkpoint(started.generationId, "resurrección tardía", new Date()),
    ).toBe(false);
    if (state?.conversationId === null) {
      expect(state).toMatchObject({ reason: "cancelled", status: "cancelled" });
      expect(await database.select().from(conversations)).toEqual([]);
      expect(await database.select().from(messages)).toEqual([]);
    } else {
      expect(state).toMatchObject({ reason: "stop", status: "completed" });
      expect(
        (await conversationsService.get(actor, conversation.id)).messages.at(-1)?.content,
      ).toEqual([{ text: "Respuesta de carrera", type: "text" }]);
    }
  });

  it("serializes completion and local cancellation through one terminal winner", async () => {
    const { conversation, draft } = await adoptedConversation("Pregunta cancelable en carrera");
    const started = await generationService.startResponse(actor, conversation.id, randomUUID(), {
      content: [{ text: "Pregunta cancelable en carrera", type: "text" }],
      draftRevision: draft.revision,
      modelTier: "balanced",
      observedRevision: 0,
      parentMessageId: null,
      source: "draft",
    });
    const firstTokenAt = new Date();
    const [completion, cancellation] = await Promise.all([
      generationService.terminalize(started.generationId, {
        content: "Respuesta completa ganadora",
        errorCode: null,
        firstTokenAt,
        reason: "stop",
        status: "completed",
      }),
      generationService.cancel(actor, conversation.id, started.generationId, () => ({
        content: "Parcial local visible",
        firstTokenAt,
      })),
    ]);
    expect(completion.won || cancellation).toBe(true);
    expect(completion.won && cancellation).toBe(false);

    const state = await generationService.readState(started.generationId);
    const canonical = await conversationsService.get(actor, conversation.id);
    expect(state?.revision).toBe(2);
    if (state?.status === "completed") {
      expect(state.reason).toBe("stop");
      expect(canonical.messages.at(-1)?.content).toEqual([
        { text: "Respuesta completa ganadora", type: "text" },
      ]);
    } else {
      expect(state).toMatchObject({ reason: "cancelled", status: "cancelled" });
      expect(canonical.messages.at(-1)?.content).toEqual([
        { text: "Parcial local visible", type: "text" },
      ]);
    }
    expect(
      await generationService.checkpoint(started.generationId, "checkpoint tardío", new Date()),
    ).toBe(false);
    expect(
      await generationService.terminalize(started.generationId, {
        content: "terminal tardío",
        errorCode: "GENERATION_FAILED",
        firstTokenAt: new Date(),
        reason: "error",
        status: "incomplete",
      }),
    ).toMatchObject({ status: state?.status, won: false });
    expect((await conversationsService.get(actor, conversation.id)).conversation.revision).toBe(2);
  });

  it("terminalizes from the latest revision after rename and archive mutations", async () => {
    const { conversation, draft } = await adoptedConversation("Pregunta con cambios estructurales");
    const started = await generationService.startResponse(actor, conversation.id, randomUUID(), {
      content: [{ text: "Pregunta con cambios estructurales", type: "text" }],
      draftRevision: draft.revision,
      modelTier: "balanced",
      observedRevision: 0,
      parentMessageId: null,
      source: "draft",
    });
    const renamed = await conversationsService.rename(
      actor,
      conversation.id,
      "Título durante generación",
      1,
    );
    expect(renamed.revision).toBe(2);
    const archived = await conversationsService.setArchived(actor, conversation.id, true, 2);
    expect(archived).toMatchObject({ isArchived: true, revision: 3 });

    const terminal = await generationService.terminalize(started.generationId, {
      content: "Respuesta después de cambios",
      errorCode: null,
      firstTokenAt: new Date(),
      reason: "stop",
      status: "completed",
    });
    expect(terminal).toMatchObject({ reason: "stop", revision: 4, status: "completed", won: true });
    expect((await conversationsService.get(actor, conversation.id)).conversation).toMatchObject({
      isArchived: true,
      revision: 4,
      title: "Título durante generación",
    });
  });

  it("returns response lifecycle and its structural revision from one coherent read", async () => {
    const { conversation, draft } = await adoptedConversation("Pregunta de estado");
    const started = await generationService.startResponse(actor, conversation.id, randomUUID(), {
      content: [{ text: "Pregunta de estado", type: "text" }],
      draftRevision: draft.revision,
      modelTier: "balanced",
      observedRevision: 0,
      parentMessageId: null,
      source: "draft",
    });
    const [state] = await Promise.all([
      generationService.responseStates(actor, conversation.id, [started.messageId]),
      generationService.terminalize(started.generationId, {
        content: "Respuesta final",
        errorCode: null,
        firstTokenAt: new Date(),
        reason: "stop",
        status: "completed",
      }),
    ]);
    const response = state.responses[0];
    expect(response).toBeDefined();
    if (response?.status === "active") {
      expect(state.revision).toBe(1);
    } else {
      expect(response?.status).toBe("completed");
      expect(state.revision).toBe(2);
    }
  });

  it("streams over a real listener with explicit headers and JSON-only preflight failures", async () => {
    const authentication = {
      auth: {
        api: {
          getSession: async () => ({
            headers: new Headers(),
            response: {
              session: {
                createdAt: actor.session.createdAt,
                expiresAt: actor.session.expiresAt,
              },
              user: {
                email: actor.employee.email,
                emailVerified: true,
                id: actor.employee.id,
                name: actor.employee.name,
              },
            },
          }),
        },
        handler: async () => new Response(null, { status: 404 }),
      },
      revokeUserSessions: async () => undefined,
    } as unknown as Authentication;
    const identity = {
      findActiveMemberships: async () => [
        {
          role: actor.role,
          workspaceDisplayName: actor.workspace.name,
          workspaceId: actor.workspace.id,
          workspaceIdentity: actor.workspace.identity,
        },
      ],
    } as unknown as IdentityService;
    const logLines: string[] = [];
    const cancellableRequest = "Respuesta cancelable sin checkpoint";
    const cancellablePartial = "Parcial visible y todavía no checkpointed";
    let cancellableGatewaySignal: AbortSignal | undefined;
    const ordinaryGateway = new FakeModelGateway([
      { event: { text: "Respuesta ", type: "content.delta" } },
      { event: { text: "simulada.", type: "content.delta" } },
      {
        event: {
          reason: "stop",
          type: "response.completed",
          usage: { inputTokens: 2, outputTokens: 2 },
        },
      },
    ]);
    const modelGateway: ModelGateway = {
      stream(request, signal) {
        if (request.message.text !== cancellableRequest) {
          return ordinaryGateway.stream(request, signal);
        }
        return (async function* () {
          cancellableGatewaySignal = signal;
          yield { text: cancellablePartial, type: "content.delta" } as const;
          signal.throwIfAborted();
          await new Promise<void>((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => reject(new DOMException("aborted", "AbortError")),
              { once: true },
            );
          });
        })();
      },
    };
    const listenerGenerations: GenerationService = {
      ...generationService,
      checkpoint: async () => false,
    };
    application = createApplication(
      loadConfig({
        DATABASE_URL: databaseUrl,
        LOG_LEVEL: "info",
        NODE_ENV: "test",
        PUBLIC_ORIGIN: "http://localhost:5173",
      }),
      {
        authentication,
        generations: listenerGenerations,
        identity,
        loggerStream: { write: (line) => logLines.push(line) },
        modelGateway,
        pool: new Pool({ connectionString: databaseUrl }),
        requestIdFactory: () => "stream-request-id",
      },
    );
    await application.server.listen({ host: "127.0.0.1", port: 0 });
    await application.lifecycle.initialize();
    const address = application.server.server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Real listener did not expose a TCP port");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const prepared = await adoptedConversation("contenido-sensible-de-prueba");
    const missingKey = await fetch(
      `${baseUrl}/api/conversations/${prepared.conversation.id}/responses`,
      {
        body: JSON.stringify({
          content: [{ text: "contenido-sensible-de-prueba", type: "text" }],
          draftRevision: prepared.draft.revision,
          modelTier: "balanced",
          observedRevision: 0,
          parentMessageId: null,
          source: "draft",
        }),
        headers: {
          accept: "application/x-ndjson",
          "content-type": "application/json",
          origin: "http://localhost:5173",
        },
        method: "POST",
      },
    );
    expect(missingKey.status).toBe(400);
    expect(await missingKey.json()).toMatchObject({ code: "IDEMPOTENCY_KEY_REQUIRED" });

    const malformedKey = await fetch(
      `${baseUrl}/api/conversations/${prepared.conversation.id}/responses`,
      {
        body: JSON.stringify({
          content: [{ text: "contenido-sensible-de-prueba", type: "text" }],
          draftRevision: prepared.draft.revision,
          modelTier: "balanced",
          observedRevision: 0,
          parentMessageId: null,
          source: "draft",
        }),
        headers: {
          accept: "application/x-ndjson",
          "content-type": "application/json",
          "idempotency-key": randomUUID().toUpperCase(),
          origin: "http://localhost:5173",
        },
        method: "POST",
      },
    );
    expect(malformedKey.status).toBe(400);
    expect(await malformedKey.json()).toMatchObject({ code: "IDEMPOTENCY_KEY_INVALID" });

    const streamed = await fetch(
      `${baseUrl}/api/conversations/${prepared.conversation.id}/responses`,
      {
        body: JSON.stringify({
          content: [{ text: "contenido-sensible-de-prueba", type: "text" }],
          draftRevision: prepared.draft.revision,
          modelTier: "balanced",
          observedRevision: 0,
          parentMessageId: null,
          source: "draft",
        }),
        headers: {
          accept: "application/x-ndjson",
          "content-type": "application/json",
          "idempotency-key": randomUUID(),
          origin: "http://localhost:5173",
        },
        method: "POST",
      },
    );
    expect(streamed.status).toBe(200);
    expect(streamed.headers.get("content-type")).toBe("application/x-ndjson");
    expect(streamed.headers.get("cache-control")).toBe("no-store");
    expect(streamed.headers.get("x-content-type-options")).toBe("nosniff");
    expect(streamed.headers.get("x-request-id")).toBe("stream-request-id");
    const events = (await streamed.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string });
    expect(events.map((event) => event.type)).toEqual([
      "response.started",
      "content.delta",
      "content.delta",
      "response.completed",
    ]);
    expect(
      (await conversationsService.get(actor, prepared.conversation.id)).messages.at(-1)?.content,
    ).toEqual([{ text: "Respuesta simulada.", type: "text" }]);
    const capturedLogs = logLines.join("\n");
    expect(capturedLogs).not.toContain("contenido-sensible-de-prueba");
    expect(capturedLogs).not.toContain("Respuesta simulada");
    expect(capturedLogs).not.toContain(systemPrompt.text);
    expect(capturedLogs).not.toContain(continueMessage.text);
    expect(capturedLogs).not.toContain("content.delta");

    const oversizedConversation = await conversationsService.create(actor);
    const messageTooLarge = await fetch(
      `${baseUrl}/api/conversations/${oversizedConversation.id}/responses`,
      {
        body: JSON.stringify({
          content: [{ text: "ñ".repeat(16_385), type: "text" }],
          draftRevision: 0,
          modelTier: "balanced",
          observedRevision: 0,
          parentMessageId: null,
          source: "draft",
        }),
        headers: {
          accept: "application/x-ndjson",
          "content-type": "application/json",
          "idempotency-key": randomUUID(),
          origin: "http://localhost:5173",
        },
        method: "POST",
      },
    );
    expect(messageTooLarge.status).toBe(413);
    expect(await messageTooLarge.json()).toMatchObject({ code: "MESSAGE_TOO_LARGE" });

    const cancellable = await adoptedConversation(cancellableRequest);
    const cancellableStream = await fetch(
      `${baseUrl}/api/conversations/${cancellable.conversation.id}/responses`,
      {
        body: JSON.stringify({
          content: [{ text: cancellableRequest, type: "text" }],
          draftRevision: cancellable.draft.revision,
          modelTier: "balanced",
          observedRevision: 0,
          parentMessageId: null,
          source: "draft",
        }),
        headers: {
          accept: "application/x-ndjson",
          "content-type": "application/json",
          "idempotency-key": randomUUID(),
          origin: "http://localhost:5173",
        },
        method: "POST",
      },
    );
    const cancellableReader = cancellableStream.body?.getReader();
    if (cancellableReader === undefined) {
      throw new Error("Cancellable stream did not expose a reader");
    }
    const cancellableDecoder = new TextDecoder();
    let cancellableBody = "";
    while (!cancellableBody.includes(cancellablePartial)) {
      const chunk = await cancellableReader.read();
      if (chunk.done) {
        throw new Error("Cancellable stream ended before its visible partial");
      }
      cancellableBody += cancellableDecoder.decode(chunk.value, { stream: true });
    }
    const cancellableStarted = cancellableBody
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            generationId?: string;
            messageId?: string;
            type: string;
          },
      )
      .find((event) => event.type === "response.started");
    if (!cancellableStarted?.generationId || !cancellableStarted.messageId) {
      throw new Error("Cancellable stream did not start canonically");
    }
    expect(
      (await conversationsService.get(actor, cancellable.conversation.id)).messages.at(-1)?.content,
    ).toEqual([{ text: "", type: "text" }]);
    expect(
      (
        await database
          .select({ firstTokenAt: generations.firstTokenAt })
          .from(generations)
          .where(eq(generations.id, cancellableStarted.generationId))
      )[0]?.firstTokenAt,
    ).toBeNull();
    const cancelledResponse = await fetch(
      `${baseUrl}/api/conversations/${cancellable.conversation.id}/responses/${cancellableStarted.generationId}/cancel`,
      {
        body: "{}",
        headers: {
          "content-type": "application/json",
          origin: "http://localhost:5173",
        },
        method: "POST",
      },
    );
    expect(cancelledResponse.status).toBe(204);
    expect(await cancelledResponse.text()).toBe("");
    while (true) {
      const chunk = await cancellableReader.read();
      if (chunk.done) {
        cancellableBody += cancellableDecoder.decode();
        break;
      }
      cancellableBody += cancellableDecoder.decode(chunk.value, { stream: true });
    }
    expect(
      cancellableBody
        .trim()
        .split("\n")
        .map((line) => (JSON.parse(line) as { type: string }).type),
    ).toEqual(["response.started", "content.delta", "response.cancelled"]);
    expect(cancellableGatewaySignal?.aborted).toBe(true);
    expect(
      (await conversationsService.get(actor, cancellable.conversation.id)).messages.at(-1)?.content,
    ).toEqual([{ text: cancellablePartial, type: "text" }]);
    expect(
      (
        await database
          .select({ firstTokenAt: generations.firstTokenAt, status: generations.status })
          .from(generations)
          .where(eq(generations.id, cancellableStarted.generationId))
      )[0],
    ).toMatchObject({ firstTokenAt: expect.any(Date), status: "cancelled" });

    const responseStates = await fetch(
      `${baseUrl}/api/conversations/${cancellable.conversation.id}/response-states`,
      {
        body: JSON.stringify({ messageIds: [cancellableStarted.messageId] }),
        headers: {
          "content-type": "application/json",
          origin: "http://localhost:5173",
        },
        method: "POST",
      },
    );
    expect(responseStates.status).toBe(200);
    expect(await responseStates.json()).toMatchObject({
      responses: [
        {
          generationId: cancellableStarted.generationId,
          messageId: cancellableStarted.messageId,
          reason: "cancelled",
          status: "cancelled",
        },
      ],
      revision: 2,
    });
  });
});

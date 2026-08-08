import type {
  CreateResponseRequest,
  ResponseState,
  ResponseStateResponse,
  StoredGenerationErrorCode,
} from "@capstone/protocol";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  createInitialTitle,
  normalizeStoredText,
  parseMessageContent,
} from "../conversations/content.js";
import { conversations, drafts, messages } from "../database/conversation-schema.js";
import type { AppDatabase } from "../database/database.js";
import { generations } from "../database/generation-schema.js";
import { ApplicationError } from "../errors.js";
import type { RequestActor } from "../identity/authorization.js";
import type {
  GatewayCompletionReason,
  GenerationContextMessage,
  GenerationRequest,
} from "./model-gateway.js";
import { continueMessage, systemPrompt } from "./prompt.js";
import { generationTuning } from "./settings.js";

const generationCopy = {
  active: "Esta conversación ya tiene una respuesta en curso.",
  alreadyExists: "Esta solicitud de respuesta ya fue utilizada.",
  archived: "Desarchiva la conversación antes de generar una respuesta.",
  changed: "La conversación cambió. Actualiza la información e inténtalo de nuevo.",
  draftChanged: "El borrador cambió en otra pestaña o dispositivo.",
  invalidMessage: "El mensaje no es válido para esta conversación.",
  messageTooLarge: "El mensaje supera el tamaño permitido.",
  notFound: "No se encontró la conversación solicitada.",
} as const;

type TerminalStatus = "cancelled" | "completed" | "failed" | "incomplete";

interface ContextRow {
  readonly accumulatedBytes: number | string;
  readonly content: unknown;
  readonly depth: number | string;
  readonly id: string;
  readonly parentMessageId: string | null;
  readonly role: "assistant" | "user";
}

interface SelectedPathMessageRow {
  readonly content: unknown;
  readonly id: string;
  readonly parentMessageId: string | null;
  readonly role: "assistant" | "user";
}

type DatabaseTransaction = Parameters<Parameters<AppDatabase["transaction"]>[0]>[0];

export interface StartedResponse {
  readonly conversationId: string;
  readonly generationId: string;
  readonly messageId: string;
  readonly request: GenerationRequest;
  readonly revision: number;
  readonly userMessageId: string;
}

export interface DurableGenerationState {
  readonly assistantMessageId: string | null;
  readonly conversationId: string | null;
  readonly errorCode: StoredGenerationErrorCode | null;
  readonly reason: "cancelled" | "content_filter" | "error" | "length" | "refusal" | "stop" | null;
  readonly revision: number | null;
  readonly status: "active" | "cancelled" | "completed" | "failed" | "incomplete";
}

export interface TerminalGenerationResult extends DurableGenerationState {
  readonly won: boolean;
}

export interface LocalCancellationPartial {
  readonly content: string;
  readonly firstTokenAt: Date | null;
}

function ownedConversationWhere(actor: RequestActor, conversationId: string) {
  return and(
    eq(conversations.id, conversationId),
    eq(conversations.workspaceId, actor.workspace.id),
    eq(conversations.userId, actor.employee.id),
  );
}

function notFound(): never {
  throw new ApplicationError(404, "NOT_FOUND", generationCopy.notFound);
}

function changed(): never {
  throw new ApplicationError(409, "CONVERSATION_CHANGED", generationCopy.changed);
}

function draftChanged(): never {
  throw new ApplicationError(409, "DRAFT_CHANGED", generationCopy.draftChanged);
}

function generationActive(): never {
  throw new ApplicationError(409, "GENERATION_ACTIVE", generationCopy.active);
}

function generationAlreadyExists(): never {
  throw new ApplicationError(409, "GENERATION_ALREADY_EXISTS", generationCopy.alreadyExists);
}

function isUniqueViolation(error: unknown, constraintName: string): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === "23505" &&
    "constraint" in error &&
    (error as { constraint?: unknown }).constraint === constraintName
  );
}

function textFromStoredContent(content: unknown): string {
  const parsed = parseMessageContent(content);
  const block = parsed[0];
  if (block === undefined) {
    throw new Error("Stored message content is empty");
  }
  return block.text;
}

function usefulText(value: string): boolean {
  return /\S/u.test(value);
}

function atOrAfter(...timestamps: readonly (Date | null | undefined)[]): Date {
  return new Date(
    Math.max(
      ...timestamps.flatMap((timestamp) =>
        timestamp === null || timestamp === undefined ? [] : [timestamp.getTime()],
      ),
    ),
  );
}

function toStoredContent(text: string) {
  return [{ type: "text" as const, text }];
}

function toDurableState(row: {
  assistantMessageId: string | null;
  conversationId: string | null;
  errorCode: string | null;
  revision: number | null;
  status: DurableGenerationState["status"];
  terminalReason: DurableGenerationState["reason"];
}): DurableGenerationState {
  return {
    assistantMessageId: row.assistantMessageId,
    conversationId: row.conversationId,
    errorCode: row.errorCode as StoredGenerationErrorCode | null,
    reason: row.terminalReason,
    revision: row.revision,
    status: row.status,
  };
}

export function createGenerationService(database: AppDatabase) {
  async function assertEmptyConversation(
    transaction: DatabaseTransaction,
    conversationId: string,
  ): Promise<void> {
    const existing = await transaction
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .limit(1);
    if (existing.length !== 0) {
      throw new Error("Empty conversation has stored messages");
    }
  }

  async function reconstructContextPrefix(
    transaction: DatabaseTransaction,
    conversationId: string,
    endpointMessageId: string | null,
    maximumHistoryBytes: number,
  ): Promise<readonly GenerationContextMessage[]> {
    if (endpointMessageId === null) {
      return [];
    }

    const result = await transaction.execute(sql<ContextRow>`
      WITH RECURSIVE selected_branch AS (
        SELECT message.id, message.parent_message_id, message.role, message.content, 0 AS depth,
          64 + octet_length(coalesce(message.content -> 0 ->> 'text', ''))
            AS accumulated_bytes
        FROM messages AS message
        WHERE message.conversation_id = ${conversationId}
          AND message.id = ${endpointMessageId}
        UNION ALL
        SELECT parent.id, parent.parent_message_id, parent.role, parent.content,
          selected_branch.depth + 1,
          selected_branch.accumulated_bytes + 64
            + octet_length(coalesce(parent.content -> 0 ->> 'text', ''))
        FROM messages AS parent
        INNER JOIN selected_branch
          ON parent.conversation_id = ${conversationId}
          AND parent.id = selected_branch.parent_message_id
        WHERE selected_branch.accumulated_bytes <= ${maximumHistoryBytes}
      )
      SELECT id AS "id", parent_message_id AS "parentMessageId", role AS "role",
        content AS "content", depth AS "depth", accumulated_bytes AS "accumulatedBytes"
      FROM selected_branch
      ORDER BY depth DESC
    `);
    const rows = result.rows as unknown as ContextRow[];
    if (rows.length === 0) {
      throw new Error("Selected conversation branch could not be reconstructed");
    }
    if (rows.some((row) => Number(row.accumulatedBytes) > maximumHistoryBytes)) {
      throw new ApplicationError(413, "MESSAGE_TOO_LARGE", generationCopy.messageTooLarge);
    }
    for (const [index, row] of rows.entries()) {
      const expectedRole = index % 2 === 0 ? "user" : "assistant";
      const previous = rows[index - 1];
      if (
        row.role !== expectedRole ||
        (index === 0 ? row.parentMessageId !== null : row.parentMessageId !== previous?.id)
      ) {
        throw new Error("Stored conversation branch violates role alternation");
      }
    }
    return rows.map((row) => ({ role: row.role, text: textFromStoredContent(row.content) }));
  }

  async function selectedPathMessage(
    transaction: DatabaseTransaction,
    conversationId: string,
    selectedEndpointId: string | null,
    targetMessageId: string,
  ): Promise<SelectedPathMessageRow> {
    if (selectedEndpointId === null) {
      throw new ApplicationError(400, "BAD_REQUEST", generationCopy.invalidMessage);
    }
    const result = await transaction.execute(sql<SelectedPathMessageRow>`
      WITH RECURSIVE selected_path AS (
        SELECT message.id, message.parent_message_id, message.role, message.content
        FROM messages AS message
        WHERE message.conversation_id = ${conversationId}
          AND message.id = ${selectedEndpointId}
        UNION ALL
        SELECT parent.id, parent.parent_message_id, parent.role, parent.content
        FROM messages AS parent
        INNER JOIN selected_path
          ON parent.conversation_id = ${conversationId}
          AND parent.id = selected_path.parent_message_id
      )
      SELECT selected.id AS "id",
        selected.parent_message_id AS "parentMessageId",
        selected.role AS "role",
        selected.content AS "content"
      FROM selected_path AS selected
      WHERE selected.id = ${targetMessageId}
      LIMIT 1
    `);
    const target = (result.rows as unknown as SelectedPathMessageRow[])[0];
    if (target === undefined) {
      throw new ApplicationError(400, "BAD_REQUEST", generationCopy.invalidMessage);
    }
    return target;
  }

  function assertContextFits(
    history: readonly GenerationContextMessage[],
    messageText: string,
  ): void {
    let totalBytes =
      Buffer.byteLength(systemPrompt.text, "utf8") + Buffer.byteLength(messageText, "utf8");
    for (const message of history) {
      totalBytes += Buffer.byteLength(message.text, "utf8");
      if (totalBytes > generationTuning.maximumContextBytes) {
        throw new ApplicationError(413, "MESSAGE_TOO_LARGE", generationCopy.messageTooLarge);
      }
    }
  }

  async function startResponse(
    actor: RequestActor,
    conversationId: string,
    idempotencyKey: string,
    input: CreateResponseRequest,
  ): Promise<StartedResponse> {
    const submittedMessageText =
      input.source === "draft" || input.source === "edit"
        ? normalizeStoredText(input.content[0]?.text ?? "")
        : input.source === "continue"
          ? continueMessage.text
          : null;
    const draftRevision = input.source === "draft" ? input.draftRevision : null;
    if (submittedMessageText !== null) {
      if (!usefulText(submittedMessageText)) {
        throw new ApplicationError(400, "BAD_REQUEST", generationCopy.invalidMessage);
      }
      if (Buffer.byteLength(submittedMessageText, "utf8") > generationTuning.messageBytes) {
        throw new ApplicationError(413, "MESSAGE_TOO_LARGE", generationCopy.messageTooLarge);
      }
    }

    try {
      return await database.transaction(async (transaction) => {
        const conversationRows = await transaction
          .select()
          .from(conversations)
          .where(ownedConversationWhere(actor, conversationId))
          .limit(1)
          .for("update");
        const conversation = conversationRows[0];
        if (conversation === undefined) {
          return notFound();
        }

        const idempotentRows = await transaction
          .select({ id: generations.id })
          .from(generations)
          .where(
            and(
              eq(generations.workspaceId, actor.workspace.id),
              eq(generations.userId, actor.employee.id),
              eq(generations.idempotencyKey, idempotencyKey),
            ),
          )
          .limit(1);
        if (idempotentRows.length !== 0) {
          return generationAlreadyExists();
        }
        const activeRows = await transaction
          .select({ id: generations.id })
          .from(generations)
          .where(
            and(eq(generations.conversationId, conversationId), eq(generations.status, "active")),
          )
          .limit(1);
        if (activeRows.length !== 0) {
          return generationActive();
        }
        if (conversation.archivedAt !== null) {
          throw new ApplicationError(409, "CONVERSATION_ARCHIVED", generationCopy.archived);
        }
        if (conversation.revision !== input.observedRevision) {
          return changed();
        }

        let consumedDraftId: string | undefined;
        let historyEndpointId: string | null;
        let insertUserMessage = true;
        let messageText: string;
        let userMessageId: string | undefined;
        let userParentMessageId: string | null;

        switch (input.source) {
          case "draft": {
            if (conversation.selectedLeafMessageId !== input.parentMessageId) {
              throw new ApplicationError(400, "BAD_REQUEST", generationCopy.invalidMessage);
            }
            messageText = submittedMessageText ?? "";
            historyEndpointId = conversation.selectedLeafMessageId;
            userParentMessageId = input.parentMessageId;
            if (conversation.selectedLeafMessageId === null) {
              await assertEmptyConversation(transaction, conversationId);
            }
            const draftRows = await transaction
              .select()
              .from(drafts)
              .where(
                and(
                  eq(drafts.workspaceId, actor.workspace.id),
                  eq(drafts.userId, actor.employee.id),
                  eq(drafts.conversationId, conversationId),
                ),
              )
              .limit(1)
              .for("update");
            const draft = draftRows[0];
            if (
              draft === undefined ||
              draft.revision !== draftRevision ||
              draft.content !== messageText
            ) {
              return draftChanged();
            }
            consumedDraftId = draft.id;
            break;
          }
          case "continue": {
            if (conversation.selectedLeafMessageId !== input.parentMessageId) {
              throw new ApplicationError(400, "BAD_REQUEST", generationCopy.invalidMessage);
            }
            messageText = submittedMessageText ?? "";
            historyEndpointId = conversation.selectedLeafMessageId;
            userParentMessageId = input.parentMessageId;
            const parentGeneration = await transaction
              .select({ id: generations.id })
              .from(generations)
              .where(
                and(
                  eq(generations.conversationId, conversationId),
                  eq(generations.assistantMessageId, input.parentMessageId),
                  eq(generations.status, "completed"),
                  eq(generations.terminalReason, "length"),
                ),
              )
              .limit(1);
            if (parentGeneration.length !== 1) {
              throw new ApplicationError(400, "BAD_REQUEST", generationCopy.invalidMessage);
            }
            break;
          }
          case "edit": {
            const target = await selectedPathMessage(
              transaction,
              conversationId,
              conversation.selectedLeafMessageId,
              input.targetMessageId,
            );
            messageText = submittedMessageText ?? "";
            if (
              target.role !== "user" ||
              target.parentMessageId !== input.parentMessageId ||
              textFromStoredContent(target.content) === messageText
            ) {
              throw new ApplicationError(400, "BAD_REQUEST", generationCopy.invalidMessage);
            }
            historyEndpointId = target.parentMessageId;
            userParentMessageId = target.parentMessageId;
            break;
          }
          case "retry": {
            const target = await selectedPathMessage(
              transaction,
              conversationId,
              conversation.selectedLeafMessageId,
              input.targetMessageId,
            );
            const parent = await selectedPathMessage(
              transaction,
              conversationId,
              conversation.selectedLeafMessageId,
              input.parentMessageId,
            );
            if (
              target.role !== "assistant" ||
              target.parentMessageId !== input.parentMessageId ||
              parent.role !== "user"
            ) {
              throw new ApplicationError(400, "BAD_REQUEST", generationCopy.invalidMessage);
            }
            messageText = textFromStoredContent(parent.content);
            historyEndpointId = parent.parentMessageId;
            insertUserMessage = false;
            userMessageId = parent.id;
            userParentMessageId = parent.parentMessageId;
            break;
          }
          default: {
            const exhaustive: never = input;
            throw new Error(`Unsupported response source: ${String(exhaustive)}`);
          }
        }

        if (!usefulText(messageText)) {
          throw new ApplicationError(400, "BAD_REQUEST", generationCopy.invalidMessage);
        }
        if (Buffer.byteLength(messageText, "utf8") > generationTuning.messageBytes) {
          throw new ApplicationError(413, "MESSAGE_TOO_LARGE", generationCopy.messageTooLarge);
        }

        const fixedContextBytes =
          Buffer.byteLength(systemPrompt.text, "utf8") + Buffer.byteLength(messageText, "utf8");
        if (fixedContextBytes > generationTuning.maximumContextBytes) {
          throw new ApplicationError(413, "MESSAGE_TOO_LARGE", generationCopy.messageTooLarge);
        }
        const history = await reconstructContextPrefix(
          transaction,
          conversationId,
          historyEndpointId,
          generationTuning.maximumContextBytes - fixedContextBytes,
        );
        if (historyEndpointId !== null && history.at(-1)?.role !== "assistant") {
          throw new ApplicationError(400, "BAD_REQUEST", generationCopy.invalidMessage);
        }

        assertContextFits(history, messageText);

        if (insertUserMessage) {
          const userRows = await transaction
            .insert(messages)
            .values({
              content: toStoredContent(messageText),
              conversationId,
              parentMessageId: userParentMessageId,
              role: "user",
            })
            .returning({ id: messages.id });
          userMessageId = userRows[0]?.id;
          if (userMessageId === undefined) {
            throw new Error("User message insertion returned no row");
          }
        }
        if (userMessageId === undefined) {
          throw new Error("Response source did not resolve a user message");
        }
        const assistantRows = await transaction
          .insert(messages)
          .values({
            content: toStoredContent(""),
            conversationId,
            parentMessageId: userMessageId,
            role: "assistant",
          })
          .returning();
        const assistantMessage = assistantRows[0];
        if (assistantMessage === undefined) {
          throw new Error("Assistant message insertion returned no row");
        }

        const generationRows = await transaction
          .insert(generations)
          .values({
            assistantMessageId: assistantMessage.id,
            conversationId,
            effectiveParameters: {},
            idempotencyKey,
            requestedTier: "balanced",
            status: "active",
            systemPromptVersion: systemPrompt.version,
            userId: actor.employee.id,
            workspaceId: actor.workspace.id,
          })
          .returning();
        const generation = generationRows[0];
        if (generation === undefined) {
          throw new Error("Generation insertion returned no row");
        }

        const now = new Date();
        const updatedRows = await transaction
          .update(conversations)
          .set({
            revision: conversation.revision + 1,
            selectedLeafMessageId: assistantMessage.id,
            title:
              input.source === "edit" || input.source === "retry"
                ? conversation.title
                : (conversation.title ?? createInitialTitle(messageText)),
            updatedAt: now,
          })
          .where(
            and(
              ownedConversationWhere(actor, conversationId),
              eq(conversations.revision, input.observedRevision),
            ),
          )
          .returning({ revision: conversations.revision });
        const updated = updatedRows[0];
        if (updated === undefined) {
          return changed();
        }
        if (consumedDraftId !== undefined) {
          const deleted = await transaction
            .delete(drafts)
            .where(and(eq(drafts.id, consumedDraftId), eq(drafts.revision, draftRevision ?? -1)))
            .returning({ id: drafts.id });
          if (deleted.length !== 1) {
            return draftChanged();
          }
        }

        return {
          conversationId,
          generationId: generation.id,
          messageId: assistantMessage.id,
          request: {
            history,
            message: { role: "user", text: messageText },
            modelTier: "balanced",
            systemPrompt,
          },
          revision: updated.revision,
          userMessageId,
        };
      });
    } catch (error: unknown) {
      if (isUniqueViolation(error, "generations_scoped_idempotency_unique")) {
        return generationAlreadyExists();
      }
      if (isUniqueViolation(error, "generations_active_conversation_unique")) {
        return generationActive();
      }
      throw error;
    }
  }

  async function readState(generationId: string): Promise<DurableGenerationState | null> {
    const rows = await database
      .select({
        assistantMessageId: generations.assistantMessageId,
        conversationId: generations.conversationId,
        errorCode: generations.errorCode,
        revision: conversations.revision,
        status: generations.status,
        terminalReason: generations.terminalReason,
      })
      .from(generations)
      .leftJoin(conversations, eq(conversations.id, generations.conversationId))
      .where(eq(generations.id, generationId))
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : toDurableState(row);
  }

  async function checkpoint(
    generationId: string,
    content: string,
    firstTokenAt: Date | null,
  ): Promise<boolean> {
    return database.transaction(async (transaction) => {
      const generationRows = await transaction
        .select()
        .from(generations)
        .where(eq(generations.id, generationId))
        .limit(1)
        .for("update");
      const generation = generationRows[0];
      if (
        generation === undefined ||
        generation.status !== "active" ||
        generation.conversationId === null ||
        generation.assistantMessageId === null
      ) {
        return false;
      }
      const updated = await transaction
        .update(messages)
        .set({ content: toStoredContent(content) })
        .where(
          and(
            eq(messages.id, generation.assistantMessageId),
            eq(messages.conversationId, generation.conversationId),
          ),
        )
        .returning({ id: messages.id });
      if (updated.length !== 1) {
        return false;
      }
      if (generation.firstTokenAt === null && firstTokenAt !== null) {
        const safeFirstTokenAt = atOrAfter(firstTokenAt, generation.startedAt);
        await transaction
          .update(generations)
          .set({
            firstTokenAt: safeFirstTokenAt,
            updatedAt: atOrAfter(
              new Date(),
              safeFirstTokenAt,
              generation.createdAt,
              generation.updatedAt,
            ),
          })
          .where(eq(generations.id, generationId));
      }
      return true;
    });
  }

  async function terminalize(
    generationId: string,
    input: {
      readonly content: string;
      readonly errorCode: StoredGenerationErrorCode | null;
      readonly firstTokenAt: Date | null;
      readonly reason: "cancelled" | GatewayCompletionReason | "error";
      readonly status: TerminalStatus;
    },
  ): Promise<TerminalGenerationResult> {
    const locationRows = await database
      .select({ conversationId: generations.conversationId })
      .from(generations)
      .where(eq(generations.id, generationId))
      .limit(1);
    const location = locationRows[0];
    if (location === undefined) {
      throw new Error("Generation disappeared during terminalization");
    }

    return database.transaction(async (transaction) => {
      const conversationRows =
        location.conversationId === null
          ? []
          : await transaction
              .select({ revision: conversations.revision })
              .from(conversations)
              .where(eq(conversations.id, location.conversationId))
              .limit(1)
              .for("update");
      const conversation = conversationRows[0];
      const generationRows = await transaction
        .select()
        .from(generations)
        .where(eq(generations.id, generationId))
        .limit(1)
        .for("update");
      const generation = generationRows[0];
      if (generation === undefined) {
        throw new Error("Generation disappeared during terminalization");
      }
      if (generation.status !== "active") {
        return {
          ...toDurableState({
            assistantMessageId: generation.assistantMessageId,
            conversationId: generation.conversationId,
            errorCode: generation.errorCode,
            revision: conversation?.revision ?? null,
            status: generation.status,
            terminalReason: generation.terminalReason,
          }),
          won: false,
        };
      }
      if (
        conversation === undefined ||
        generation.conversationId === null ||
        generation.assistantMessageId === null
      ) {
        throw new Error("Active generation lost its conversation content references");
      }

      const messageContent = usefulText(input.content) ? input.content : "";
      const messageUpdated = await transaction
        .update(messages)
        .set({ content: toStoredContent(messageContent) })
        .where(
          and(
            eq(messages.id, generation.assistantMessageId),
            eq(messages.conversationId, generation.conversationId),
          ),
        )
        .returning({ id: messages.id });
      if (messageUpdated.length !== 1) {
        throw new Error("Active assistant message disappeared during terminalization");
      }

      const firstTokenAt =
        generation.firstTokenAt ??
        (input.firstTokenAt === null ? null : atOrAfter(input.firstTokenAt, generation.startedAt));
      const now = atOrAfter(
        new Date(),
        generation.startedAt,
        firstTokenAt,
        generation.createdAt,
        generation.updatedAt,
      );
      await transaction
        .update(generations)
        .set({
          completedAt: now,
          errorCode: input.errorCode,
          firstTokenAt,
          status: input.status,
          terminalReason: input.reason,
          updatedAt: now,
        })
        .where(and(eq(generations.id, generationId), eq(generations.status, "active")));
      const updatedConversations = await transaction
        .update(conversations)
        .set({ revision: conversation.revision + 1, updatedAt: now })
        .where(
          and(
            eq(conversations.id, generation.conversationId),
            eq(conversations.revision, conversation.revision),
          ),
        )
        .returning({ revision: conversations.revision });
      const updatedConversation = updatedConversations[0];
      if (updatedConversation === undefined) {
        throw new Error("Conversation changed while its terminal row was locked");
      }
      return {
        assistantMessageId: generation.assistantMessageId,
        conversationId: generation.conversationId,
        errorCode: input.errorCode,
        reason: input.reason,
        revision: updatedConversation.revision,
        status: input.status,
        won: true,
      };
    });
  }

  async function cancel(
    actor: RequestActor,
    conversationId: string,
    generationId: string,
    captureLocalPartial?: () => LocalCancellationPartial | undefined,
  ): Promise<boolean> {
    const scopedRows = await database
      .select({ id: generations.id })
      .from(generations)
      .where(
        and(
          eq(generations.id, generationId),
          eq(generations.workspaceId, actor.workspace.id),
          eq(generations.userId, actor.employee.id),
          eq(generations.conversationId, conversationId),
        ),
      )
      .limit(1);
    if (scopedRows.length !== 1) {
      return notFound();
    }

    return database.transaction(async (transaction) => {
      const conversationRows = await transaction
        .select({ revision: conversations.revision })
        .from(conversations)
        .where(ownedConversationWhere(actor, conversationId))
        .limit(1)
        .for("update");
      const conversation = conversationRows[0];
      if (conversation === undefined) {
        return notFound();
      }
      const generationRows = await transaction
        .select()
        .from(generations)
        .where(
          and(
            eq(generations.id, generationId),
            eq(generations.workspaceId, actor.workspace.id),
            eq(generations.userId, actor.employee.id),
            eq(generations.conversationId, conversationId),
          ),
        )
        .limit(1)
        .for("update");
      const generation = generationRows[0];
      if (generation === undefined) {
        return notFound();
      }
      if (generation.status !== "active") {
        return false;
      }
      const localPartial = captureLocalPartial?.();
      if (localPartial !== undefined) {
        if (generation.assistantMessageId === null || generation.conversationId === null) {
          throw new Error("Active generation lost its conversation content references");
        }
        const updated = await transaction
          .update(messages)
          .set({ content: toStoredContent(localPartial.content) })
          .where(
            and(
              eq(messages.id, generation.assistantMessageId),
              eq(messages.conversationId, generation.conversationId),
            ),
          )
          .returning({ id: messages.id });
        if (updated.length !== 1) {
          throw new Error("Active assistant message disappeared during cancellation");
        }
      }
      const firstTokenAt =
        generation.firstTokenAt ??
        (localPartial?.firstTokenAt === null || localPartial?.firstTokenAt === undefined
          ? null
          : atOrAfter(localPartial.firstTokenAt, generation.startedAt));
      const now = atOrAfter(
        new Date(),
        generation.startedAt,
        firstTokenAt,
        generation.createdAt,
        generation.updatedAt,
      );
      await transaction
        .update(generations)
        .set({
          completedAt: now,
          errorCode: null,
          firstTokenAt,
          status: "cancelled",
          terminalReason: "cancelled",
          updatedAt: now,
        })
        .where(and(eq(generations.id, generationId), eq(generations.status, "active")));
      await transaction
        .update(conversations)
        .set({ revision: conversation.revision + 1, updatedAt: now })
        .where(eq(conversations.id, conversationId));
      return true;
    });
  }

  async function responseStates(
    actor: RequestActor,
    conversationId: string,
    messageIds: readonly string[],
  ): Promise<ResponseStateResponse> {
    return database.transaction(async (transaction) => {
      const conversationRows = await transaction
        .select({ revision: conversations.revision })
        .from(conversations)
        .where(ownedConversationWhere(actor, conversationId))
        .limit(1)
        .for("share");
      const conversation = conversationRows[0];
      if (conversation === undefined) {
        return notFound();
      }
      const rows = await transaction
        .select({
          errorCode: generations.errorCode,
          generationId: generations.id,
          messageId: generations.assistantMessageId,
          reason: generations.terminalReason,
          status: generations.status,
        })
        .from(generations)
        .innerJoin(messages, eq(messages.id, generations.assistantMessageId))
        .where(
          and(
            eq(generations.workspaceId, actor.workspace.id),
            eq(generations.userId, actor.employee.id),
            eq(generations.conversationId, conversationId),
            eq(messages.conversationId, conversationId),
            eq(messages.role, "assistant"),
            inArray(messages.id, [...messageIds]),
          ),
        );
      const byMessageId = new Map(
        rows.flatMap((row) =>
          row.messageId === null
            ? []
            : [
                [
                  row.messageId,
                  {
                    errorCode: row.errorCode,
                    generationId: row.generationId,
                    messageId: row.messageId,
                    reason: row.reason,
                    status: row.status,
                  } as ResponseState,
                ] as const,
              ],
        ),
      );
      return {
        conversationId,
        responses: messageIds.flatMap((messageId) => {
          const state = byMessageId.get(messageId);
          return state === undefined ? [] : [state];
        }),
        revision: conversation.revision,
      };
    });
  }

  async function removeConversation(
    actor: RequestActor,
    conversationId: string,
    observedRevision: number,
  ): Promise<string | null> {
    return database.transaction(async (transaction) => {
      const conversationRows = await transaction
        .select({ revision: conversations.revision })
        .from(conversations)
        .where(ownedConversationWhere(actor, conversationId))
        .limit(1)
        .for("update");
      const conversation = conversationRows[0];
      if (conversation === undefined) {
        return notFound();
      }
      if (conversation.revision !== observedRevision) {
        return changed();
      }

      const activeRows = await transaction
        .select({
          createdAt: generations.createdAt,
          firstTokenAt: generations.firstTokenAt,
          id: generations.id,
          startedAt: generations.startedAt,
          updatedAt: generations.updatedAt,
        })
        .from(generations)
        .where(
          and(eq(generations.conversationId, conversationId), eq(generations.status, "active")),
        )
        .limit(1)
        .for("update");
      const activeGeneration = activeRows[0];
      const activeGenerationId = activeGeneration?.id ?? null;
      if (activeGenerationId !== null) {
        const now = atOrAfter(
          new Date(),
          activeGeneration?.startedAt,
          activeGeneration?.firstTokenAt,
          activeGeneration?.createdAt,
          activeGeneration?.updatedAt,
        );
        await transaction
          .update(generations)
          .set({
            completedAt: now,
            errorCode: null,
            status: "cancelled",
            terminalReason: "cancelled",
            updatedAt: now,
          })
          .where(and(eq(generations.id, activeGenerationId), eq(generations.status, "active")));
      }
      const deleted = await transaction
        .delete(conversations)
        .where(
          and(
            ownedConversationWhere(actor, conversationId),
            eq(conversations.revision, observedRevision),
          ),
        )
        .returning({ id: conversations.id });
      if (deleted.length !== 1) {
        return changed();
      }
      return activeGenerationId;
    });
  }

  return Object.freeze({
    cancel,
    checkpoint,
    readState,
    removeConversation,
    responseStates,
    startResponse,
    terminalize,
  });
}

export type GenerationService = ReturnType<typeof createGenerationService>;

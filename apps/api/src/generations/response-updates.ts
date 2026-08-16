import type {
  ResponseState,
  ResponseUpdatesPhase,
  ResponseUpdatesResponse,
} from "@capstone/protocol";
import { RESPONSE_UPDATES_MAX_TEXT_UTF8_BYTES } from "@capstone/protocol";
import { and, eq, sql } from "drizzle-orm";
import { parseMessageContent } from "../conversations/content.js";
import { type CursorCodec, cursorInteger, cursorString } from "../conversations/cursor.js";
import { conversations, messages } from "../database/conversation-schema.js";
import type { AppDatabase } from "../database/database.js";
import { generations, isNonterminalGenerationStatus } from "../database/generation-schema.js";
import { ApplicationError } from "../errors.js";
import type { RequestActor } from "../identity/authorization.js";

export const responseUpdatesTuning = Object.freeze({
  longPollMilliseconds: 10_000,
  pollIntervalMilliseconds: 500,
});

const cursorKind = "response-updates";
const invalidCursorMessage = "El cursor de paginación no es válido.";
const notFoundMessage = "No se encontró la respuesta solicitada.";

interface UpdatesSnapshot {
  readonly content: string;
  readonly phase: ResponseUpdatesPhase;
  readonly response: ResponseState;
  readonly revision: number;
}

interface UpdatesCursor {
  readonly messageId: string;
  readonly offset: number;
  readonly phase: ResponseUpdatesPhase;
}

interface ReadUpdatesOptions {
  readonly deadlineMilliseconds?: number;
  readonly pollIntervalMilliseconds?: number;
  readonly signal?: AbortSignal;
  /** Returns false once the API is draining so long polls end promptly. */
  readonly stillServing?: () => boolean;
}

/** Internal control flow for a downstream socket that can no longer receive a response. */
export class ResponseUpdatesRequestAborted extends Error {
  constructor() {
    super("The response updates request was aborted");
    this.name = "ResponseUpdatesRequestAborted";
  }
}

function invalidCursor(): never {
  throw new ApplicationError(400, "INVALID_CURSOR", invalidCursorMessage);
}

function notFound(): never {
  throw new ApplicationError(404, "NOT_FOUND", notFoundMessage);
}

function requestAborted(): never {
  throw new ResponseUpdatesRequestAborted();
}

function signalIsAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

const fatalUtf8 = new TextDecoder("utf-8", { fatal: true });

function waitFor(milliseconds: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    const timer = setTimeout(finish, milliseconds);
    const aborted = (): void => finish();
    function finish(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", aborted);
      resolve();
    }
    signal?.addEventListener("abort", aborted, { once: true });
  });
}

/**
 * Durable, cursor-based reattachment to one owned response. Every read is a fresh short query
 * over the checkpointed assistant content and generation lifecycle; no connection or transaction
 * is held while waiting.
 */
export function createResponseUpdatesService(database: AppDatabase, cursorCodec: CursorCodec) {
  async function snapshot(
    actor: RequestActor,
    conversationId: string,
    generationId: string,
  ): Promise<UpdatesSnapshot | null> {
    const rows = await database
      .select({
        content: messages.content,
        errorCode: generations.errorCode,
        messageId: generations.assistantMessageId,
        purpose: generations.purpose,
        reason: generations.terminalReason,
        revision: conversations.revision,
        status: generations.status,
      })
      .from(generations)
      .innerJoin(conversations, eq(conversations.id, generations.conversationId))
      .innerJoin(
        messages,
        and(
          eq(messages.id, generations.assistantMessageId),
          eq(messages.conversationId, generations.conversationId),
        ),
      )
      .where(
        and(
          eq(generations.id, generationId),
          eq(generations.workspaceId, actor.workspace.id),
          eq(generations.userId, actor.employee.id),
          eq(generations.conversationId, conversationId),
          sql`(${generations.purpose} IS NULL OR ${generations.purpose} = 'chat')`,
        ),
      )
      .limit(1);
    const row = rows[0];
    if (row === undefined || row.messageId === null) {
      return null;
    }
    const content = parseMessageContent(row.content)[0]?.text ?? "";
    const response = (
      isNonterminalGenerationStatus(row.status)
        ? {
            errorCode: null,
            generationId,
            messageId: row.messageId,
            reason: null,
            status: "active",
          }
        : {
            errorCode: row.errorCode,
            generationId,
            messageId: row.messageId,
            reason: row.reason,
            status: row.status,
          }
    ) as ResponseState;
    return Object.freeze({
      content,
      phase: row.status === "finalizing" ? "naming" : "responding",
      response,
      revision: row.revision,
    });
  }

  function decodeCursor(
    cursor: string,
    conversationId: string,
    generationId: string,
  ): UpdatesCursor {
    const payload = cursorCodec.decode(cursor, cursorKind);
    if (
      cursorString(payload, "conversationId") !== conversationId ||
      cursorString(payload, "generationId") !== generationId
    ) {
      return invalidCursor();
    }
    const phase = payload.phase;
    if (phase !== "responding" && phase !== "naming") {
      return invalidCursor();
    }
    return Object.freeze({
      messageId: cursorString(payload, "messageId"),
      offset: cursorInteger(payload, "offset"),
      phase,
    });
  }

  function encodeCursor(
    conversationId: string,
    generationId: string,
    messageId: string,
    offset: number,
    phase: ResponseUpdatesPhase,
  ): string {
    return cursorCodec.encode({
      conversationId,
      generationId,
      kind: cursorKind,
      messageId,
      offset,
      phase,
      version: 1,
    });
  }

  function respond(
    conversationId: string,
    generationId: string,
    snap: UpdatesSnapshot,
    content: ResponseUpdatesResponse["content"],
    contentBytes: number,
  ): ResponseUpdatesResponse {
    return {
      content,
      conversationId,
      nextCursor:
        snap.response.status === "active"
          ? encodeCursor(
              conversationId,
              generationId,
              snap.response.messageId,
              contentBytes,
              snap.phase,
            )
          : null,
      phase: snap.phase,
      response: snap.response,
      revision: snap.revision,
    };
  }

  async function readUpdates(
    actor: RequestActor,
    conversationId: string,
    generationId: string,
    cursor: string | null,
    options: ReadUpdatesOptions = {},
  ): Promise<ResponseUpdatesResponse> {
    const decoded = cursor === null ? null : decodeCursor(cursor, conversationId, generationId);
    const deadlineAt =
      Date.now() + (options.deadlineMilliseconds ?? responseUpdatesTuning.longPollMilliseconds);
    const pollInterval =
      options.pollIntervalMilliseconds ?? responseUpdatesTuning.pollIntervalMilliseconds;
    const previous: UpdatesCursor | null = decoded;

    while (true) {
      if (signalIsAborted(options.signal)) {
        return requestAborted();
      }
      const snap = await snapshot(actor, conversationId, generationId);
      if (signalIsAborted(options.signal)) {
        return requestAborted();
      }
      if (snap === null) {
        return notFound();
      }
      const bytes = Buffer.from(snap.content, "utf8");
      if (bytes.length > RESPONSE_UPDATES_MAX_TEXT_UTF8_BYTES) {
        throw new Error("Durable response content exceeded its protocol limit");
      }
      if (previous === null) {
        return respond(
          conversationId,
          generationId,
          snap,
          { mode: "replace", text: snap.content },
          bytes.length,
        );
      }
      if (previous.messageId !== snap.response.messageId) {
        return invalidCursor();
      }
      // Naming never returns to responding while the parent is still active; a terminal parent
      // simply reports its settled state.
      const impossibleTransition =
        previous.phase === "naming" &&
        snap.phase === "responding" &&
        snap.response.status === "active";
      if (previous.offset > bytes.length || impossibleTransition) {
        return respond(
          conversationId,
          generationId,
          snap,
          { mode: "replace", text: snap.content },
          bytes.length,
        );
      }
      if (previous.offset < bytes.length) {
        let delta: string;
        try {
          delta = fatalUtf8.decode(bytes.subarray(previous.offset));
        } catch {
          return respond(
            conversationId,
            generationId,
            snap,
            { mode: "replace", text: snap.content },
            bytes.length,
          );
        }
        return respond(
          conversationId,
          generationId,
          snap,
          { mode: "append", text: delta },
          bytes.length,
        );
      }
      if (snap.response.status !== "active" || snap.phase !== previous.phase) {
        return respond(
          conversationId,
          generationId,
          snap,
          { mode: "append", text: "" },
          bytes.length,
        );
      }
      const remaining = deadlineAt - Date.now();
      if (remaining <= 0 || options.stillServing?.() === false) {
        return respond(
          conversationId,
          generationId,
          snap,
          { mode: "append", text: "" },
          bytes.length,
        );
      }
      await waitFor(Math.min(pollInterval, remaining), options.signal);
    }
  }

  return Object.freeze({ readUpdates });
}

export type ResponseUpdatesService = ReturnType<typeof createResponseUpdatesService>;

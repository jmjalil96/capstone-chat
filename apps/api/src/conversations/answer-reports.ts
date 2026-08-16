import {
  ADMIN_ANSWER_REPORT_PAGE_SIZE,
  type AdminAnswerReport,
  type AdminAnswerReportDetail,
  type AdminAnswerReportListResponse,
  ANSWER_REPORT_NOTE_MAX_CODE_POINTS,
  type AnswerReportStateResponse,
  type CreateAnswerReportRequest,
  type CreateAnswerReportResponse,
} from "@capstone/protocol";
import { and, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import { answerReports } from "../database/answer-report-schema.js";
import { user as authUser } from "../database/auth-schema.generated.js";
import { conversations, messages } from "../database/conversation-schema.js";
import type { AppDatabase, AppDatabaseExecutor } from "../database/database.js";
import { isNonterminalGenerationStatus } from "../database/generation-schema.js";
import { ApplicationError } from "../errors.js";
import type { RequestActor } from "../identity/authorization.js";
import { hasUnsupportedControlCharacter, parseMessageContent } from "./content.js";
import { type CursorCodec, cursorString } from "./cursor.js";

const reportCopy = {
  active: "Espera a que la respuesta termine antes de reportarla.",
  invalidNote: "La nota del reporte no es válida.",
  invalidTarget: "Solo puedes reportar una respuesta terminada del asistente.",
  notFound: "No se encontró la respuesta solicitada.",
  reportNotFound: "El reporte ya no está disponible.",
} as const;

const inboxCursorKind = "admin-answer-reports";

interface EligibilityRow extends Record<string, unknown> {
  readonly answerText: string | null;
  readonly generationId: string | null;
  readonly generationStatus: string | null;
  readonly promptRole: string | null;
  readonly role: string | null;
}

interface InboxRow {
  readonly createdAt: Date;
  readonly email: string;
  readonly id: string;
  readonly name: string;
  readonly note: string | null;
  readonly reason: AdminAnswerReport["reason"];
}

function notFound(): never {
  throw new ApplicationError(404, "NOT_FOUND", reportCopy.notFound);
}

/** Normalizes an optional note exactly like message text: NFC, `\n`, trimmed, bounded. */
export function normalizeReportNote(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }
  if (!value.isWellFormed()) {
    throw new ApplicationError(400, "BAD_REQUEST", reportCopy.invalidNote);
  }
  const normalized = value.normalize("NFC").replace(/\r\n?/gu, "\n").trim();
  if (
    normalized.length === 0 ||
    hasUnsupportedControlCharacter(normalized) ||
    [...normalized].length > ANSWER_REPORT_NOTE_MAX_CODE_POINTS
  ) {
    throw new ApplicationError(400, "BAD_REQUEST", reportCopy.invalidNote);
  }
  return normalized;
}

function toInboxItem(row: InboxRow): AdminAnswerReport {
  return Object.freeze({
    createdAt: row.createdAt.toISOString(),
    id: row.id,
    note: row.note,
    reason: row.reason,
    reporter: Object.freeze({ email: row.email, name: row.name }),
  });
}

export function createAnswerReportService(database: AppDatabase, cursorCodec: CursorCodec) {
  async function ownedConversationExists(
    actor: RequestActor,
    conversationId: string,
  ): Promise<boolean> {
    const rows = await database
      .select({ id: conversations.id })
      .from(conversations)
      .where(
        and(
          eq(conversations.id, conversationId),
          eq(conversations.workspaceId, actor.workspace.id),
          eq(conversations.userId, actor.employee.id),
        ),
      )
      .limit(1);
    return rows.length === 1;
  }

  async function findExisting(
    executor: AppDatabaseExecutor,
    messageId: string,
  ): Promise<
    { readonly createdAt: Date; readonly generationId: string; readonly id: string } | undefined
  > {
    const rows = await executor
      .select({
        createdAt: answerReports.createdAt,
        generationId: answerReports.generationId,
        id: answerReports.id,
      })
      .from(answerReports)
      .where(eq(answerReports.assistantMessageId, messageId))
      .limit(1);
    return rows[0];
  }

  /**
   * Creates one immutable report for an owned, terminal assistant answer with a direct user
   * parent. Generation/message uniqueness is the idempotency: duplicates return the first report.
   */
  async function create(
    actor: RequestActor,
    conversationId: string,
    messageId: string,
    input: CreateAnswerReportRequest,
  ): Promise<CreateAnswerReportResponse> {
    const note = normalizeReportNote(input.note);
    return database.transaction(async (transaction) => {
      // Conversation deletion takes FOR UPDATE first. Holding this share lock until the insert
      // commits gives reporting and deletion one deterministic order without holding a lock
      // across network work.
      const conversationRows = await transaction
        .select({ id: conversations.id })
        .from(conversations)
        .where(
          and(
            eq(conversations.id, conversationId),
            eq(conversations.workspaceId, actor.workspace.id),
            eq(conversations.userId, actor.employee.id),
          ),
        )
        .limit(1)
        .for("share");
      if (conversationRows[0] === undefined) {
        return notFound();
      }
      const eligibility = await transaction.execute<EligibilityRow>(sql`
        SELECT
          answer.role AS "role",
          answer.content->0->>'text' AS "answerText",
          prompt.role AS "promptRole",
          generation.id AS "generationId",
          generation.status::text AS "generationStatus"
        FROM messages AS answer
        LEFT JOIN messages AS prompt
          ON prompt.id = answer.parent_message_id AND prompt.conversation_id = answer.conversation_id
        LEFT JOIN generations AS generation
          ON generation.assistant_message_id = answer.id
          AND generation.conversation_id = answer.conversation_id
          AND (generation.purpose IS NULL OR generation.purpose = 'chat')
        WHERE answer.id = ${messageId}::uuid
          AND answer.conversation_id = ${conversationId}::uuid
        LIMIT 1
      `);
      const target = eligibility.rows[0];
      if (target === undefined) {
        return notFound();
      }
      if (
        target.role !== "assistant" ||
        target.promptRole !== "user" ||
        target.generationId === null ||
        target.generationStatus === null
      ) {
        throw new ApplicationError(400, "BAD_REQUEST", reportCopy.invalidTarget);
      }
      if (isNonterminalGenerationStatus(target.generationStatus as never)) {
        throw new ApplicationError(409, "GENERATION_ACTIVE", reportCopy.active);
      }
      if (target.answerText === null || !/\S/u.test(target.answerText)) {
        throw new ApplicationError(400, "BAD_REQUEST", reportCopy.invalidTarget);
      }
      const existing = await findExisting(transaction, messageId);
      if (existing !== undefined) {
        return {
          createdAt: existing.createdAt.toISOString(),
          id: existing.id,
          messageId,
          repeated: true,
        };
      }
      const inserted = await transaction
        .insert(answerReports)
        .values({
          assistantMessageId: messageId,
          conversationId,
          generationId: target.generationId,
          note,
          reason: input.reason,
          userId: actor.employee.id,
          workspaceId: actor.workspace.id,
        })
        .onConflictDoNothing()
        .returning({ createdAt: answerReports.createdAt, id: answerReports.id });
      const row = inserted[0];
      if (row !== undefined) {
        return { createdAt: row.createdAt.toISOString(), id: row.id, messageId, repeated: false };
      }
      const raced = await findExisting(transaction, messageId);
      if (raced === undefined || raced.generationId !== target.generationId) {
        throw new Error("Answer report uniqueness conflict did not resolve to its source answer");
      }
      return {
        createdAt: raced.createdAt.toISOString(),
        id: raced.id,
        messageId,
        repeated: true,
      };
    });
  }

  async function reportedStates(
    actor: RequestActor,
    conversationId: string,
    messageIds: readonly string[],
  ): Promise<AnswerReportStateResponse> {
    if (!(await ownedConversationExists(actor, conversationId))) {
      return notFound();
    }
    const rows = await database
      .select({ messageId: answerReports.assistantMessageId })
      .from(answerReports)
      .where(
        and(
          eq(answerReports.conversationId, conversationId),
          eq(answerReports.userId, actor.employee.id),
          inArray(answerReports.assistantMessageId, [...messageIds]),
        ),
      );
    const reported = new Set(rows.map((row) => row.messageId));
    return { conversationId, reportedMessageIds: messageIds.filter((id) => reported.has(id)) };
  }

  function decodeInboxCursor(
    cursor: string,
    workspaceId: string,
  ): { readonly createdAt: Date; readonly id: string } {
    const payload = cursorCodec.decode(cursor, inboxCursorKind);
    if (cursorString(payload, "workspaceId") !== workspaceId) {
      throw new ApplicationError(400, "INVALID_CURSOR", "El cursor de paginación no es válido.");
    }
    const createdAt = new Date(cursorString(payload, "createdAt"));
    if (Number.isNaN(createdAt.getTime())) {
      throw new ApplicationError(400, "INVALID_CURSOR", "El cursor de paginación no es válido.");
    }
    return { createdAt, id: cursorString(payload, "id") };
  }

  async function listForWorkspace(
    workspaceId: string,
    cursor?: string,
  ): Promise<AdminAnswerReportListResponse> {
    const after = cursor === undefined ? null : decodeInboxCursor(cursor, workspaceId);
    const rows = await database
      .select({
        createdAt: answerReports.createdAt,
        email: authUser.email,
        id: answerReports.id,
        name: authUser.name,
        note: answerReports.note,
        reason: answerReports.reason,
      })
      .from(answerReports)
      .innerJoin(authUser, eq(authUser.id, answerReports.userId))
      .where(
        and(
          eq(answerReports.workspaceId, workspaceId),
          after === null
            ? undefined
            : or(
                lt(answerReports.createdAt, after.createdAt),
                and(eq(answerReports.createdAt, after.createdAt), lt(answerReports.id, after.id)),
              ),
        ),
      )
      .orderBy(desc(answerReports.createdAt), desc(answerReports.id))
      .limit(ADMIN_ANSWER_REPORT_PAGE_SIZE + 1);
    const visible = rows.slice(0, ADMIN_ANSWER_REPORT_PAGE_SIZE);
    const last = visible.at(-1);
    return {
      items: visible.map(toInboxItem),
      nextCursor:
        rows.length <= ADMIN_ANSWER_REPORT_PAGE_SIZE || last === undefined
          ? null
          : cursorCodec.encode({
              createdAt: last.createdAt.toISOString(),
              id: last.id,
              kind: inboxCursorKind,
              version: 1,
              workspaceId,
            }),
    };
  }

  /** The consented pair only: no identifiers, titles, surrounding messages, or model metadata. */
  async function detailForWorkspace(
    workspaceId: string,
    reportId: string,
  ): Promise<AdminAnswerReportDetail> {
    const rows = await database
      .select({
        answerContent: messages.content,
        conversationId: answerReports.conversationId,
        createdAt: answerReports.createdAt,
        email: authUser.email,
        id: answerReports.id,
        name: authUser.name,
        note: answerReports.note,
        parentMessageId: messages.parentMessageId,
        reason: answerReports.reason,
      })
      .from(answerReports)
      .innerJoin(authUser, eq(authUser.id, answerReports.userId))
      .innerJoin(
        messages,
        and(
          eq(messages.id, answerReports.assistantMessageId),
          eq(messages.conversationId, answerReports.conversationId),
        ),
      )
      .where(and(eq(answerReports.id, reportId), eq(answerReports.workspaceId, workspaceId)))
      .limit(1);
    const row = rows[0];
    if (row === undefined || row.parentMessageId === null) {
      throw new ApplicationError(404, "NOT_FOUND", reportCopy.reportNotFound);
    }
    const promptRows = await database
      .select({ content: messages.content })
      .from(messages)
      .where(
        and(eq(messages.id, row.parentMessageId), eq(messages.conversationId, row.conversationId)),
      )
      .limit(1);
    const prompt = promptRows[0];
    if (prompt === undefined) {
      throw new ApplicationError(404, "NOT_FOUND", reportCopy.reportNotFound);
    }
    return {
      ...toInboxItem(row),
      exchange: Object.freeze({
        answer: parseMessageContent(row.answerContent)[0]?.text ?? "",
        prompt: parseMessageContent(prompt.content)[0]?.text ?? "",
      }),
    };
  }

  return Object.freeze({ create, detailForWorkspace, listForWorkspace, reportedStates });
}

export type AnswerReportService = ReturnType<typeof createAnswerReportService>;

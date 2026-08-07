import type {
  ConversationDetailResponse,
  ConversationListResponse,
  ConversationMessage,
  ConversationSearchResponse,
  ConversationSelectionResponse,
  ConversationSummary,
  ConversationView,
  DraftScope,
  DraftState,
  MessageContent,
} from "@capstone/protocol";
import { and, desc, eq, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { conversations, drafts, messages } from "../database/conversation-schema.js";
import type { AppDatabase } from "../database/database.js";
import { ApplicationError } from "../errors.js";
import type { RequestActor } from "../identity/authorization.js";
import {
  createPostgresSearchSnippet,
  normalizeDraftContent,
  normalizeManualTitle,
  normalizeSearchQuery,
  normalizeStoredText,
} from "./content.js";
import { type CursorCodec, cursorInteger, cursorString } from "./cursor.js";
import { conversationCoreTuning } from "./settings.js";

const conversationCopy = {
  changed: "La conversación cambió. Actualiza la información e inténtalo de nuevo.",
  draftChanged: "El borrador cambió en otra pestaña o dispositivo.",
  invalidContent: "El contenido almacenado de la conversación no es válido.",
  notFound: "No se encontró la conversación solicitada.",
} as const;

interface ConversationRow {
  readonly archivedAt: Date | null;
  readonly createdAt: Date | string;
  readonly id: string;
  readonly revision: number;
  readonly selectedLeafMessageId: string | null;
  readonly title: string | null;
  readonly updatedAt: Date | string;
  readonly userId: string;
  readonly workspaceId: string;
}

interface BranchRow {
  readonly content: unknown;
  readonly createdAt: Date | string;
  readonly id: string;
  readonly parentMessageId: string | null;
  readonly role: "assistant" | "user";
  readonly siblingCount: number | string;
}

interface SearchRow extends ConversationRow {
  readonly leafMessageId: string;
  readonly matchKind: "message" | "title";
  readonly matchedMessageId: string | null;
  readonly queryLexemes: string[] | null;
  readonly queryPrefixFlags: boolean[] | null;
  readonly rank: string;
  readonly resultId: string;
  readonly sourceText: string;
  readonly sourceFolds: string[] | null;
}

function changed(): never {
  throw new ApplicationError(409, "CONVERSATION_CHANGED", conversationCopy.changed);
}

function draftChanged(): never {
  throw new ApplicationError(409, "DRAFT_CHANGED", conversationCopy.draftChanged);
}

function notFound(): never {
  throw new ApplicationError(404, "NOT_FOUND", conversationCopy.notFound);
}

function toSummary(row: ConversationRow): ConversationSummary {
  return {
    createdAt: toDate(row.createdAt).toISOString(),
    id: row.id,
    isArchived: row.archivedAt !== null,
    revision: row.revision,
    title: row.title,
    updatedAt: toDate(row.updatedAt).toISOString(),
  };
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function parseMessageContent(value: unknown): MessageContent {
  if (
    !Array.isArray(value) ||
    value.length !== 1 ||
    value[0] === null ||
    typeof value[0] !== "object" ||
    Array.isArray(value[0]) ||
    (value[0] as Record<string, unknown>).type !== "text" ||
    typeof (value[0] as Record<string, unknown>).text !== "string" ||
    Object.keys(value[0] as Record<string, unknown>).some((key) => key !== "type" && key !== "text")
  ) {
    throw new Error(conversationCopy.invalidContent);
  }
  return [{ type: "text", text: (value[0] as { text: string }).text }];
}

function toMessage(row: BranchRow): ConversationMessage {
  return {
    content: parseMessageContent(row.content),
    createdAt: toDate(row.createdAt).toISOString(),
    id: row.id,
    parentMessageId: row.parentMessageId,
    role: row.role,
    siblingCount: Number(row.siblingCount),
  };
}

function ownedConversationWhere(actor: RequestActor, conversationId: string) {
  return and(
    eq(conversations.id, conversationId),
    eq(conversations.workspaceId, actor.workspace.id),
    eq(conversations.userId, actor.employee.id),
  );
}

function assertCursorUuid(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) {
    throw new ApplicationError(400, "INVALID_CURSOR", "El cursor de paginación no es válido.");
  }
  return value;
}

function assertCursorDate(value: string): Date {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) {
    throw new ApplicationError(400, "INVALID_CURSOR", "El cursor de paginación no es válido.");
  }
  return date;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === "23505"
  );
}

export function createConversationService(database: AppDatabase, cursorCodec: CursorCodec) {
  async function list(
    actor: RequestActor,
    view: ConversationView,
    cursor?: string,
  ): Promise<ConversationListResponse> {
    let cursorUpdatedAt: Date | undefined;
    let cursorId: string | undefined;
    if (cursor !== undefined) {
      const payload = cursorCodec.decode(cursor, "conversation-list");
      if (cursorString(payload, "view") !== view) {
        throw new ApplicationError(400, "INVALID_CURSOR", "El cursor de paginación no es válido.");
      }
      cursorUpdatedAt = assertCursorDate(cursorString(payload, "updatedAt"));
      cursorId = assertCursorUuid(cursorString(payload, "id"));
    }

    const archivedCondition =
      view === "archived" ? isNotNull(conversations.archivedAt) : isNull(conversations.archivedAt);
    const keysetCondition =
      cursorUpdatedAt === undefined || cursorId === undefined
        ? undefined
        : or(
            lt(conversations.updatedAt, cursorUpdatedAt),
            and(eq(conversations.updatedAt, cursorUpdatedAt), lt(conversations.id, cursorId)),
          );
    const rows = await database
      .select()
      .from(conversations)
      .where(
        and(
          eq(conversations.workspaceId, actor.workspace.id),
          eq(conversations.userId, actor.employee.id),
          archivedCondition,
          keysetCondition,
        ),
      )
      .orderBy(desc(conversations.updatedAt), desc(conversations.id))
      .limit(conversationCoreTuning.historyPageSize + 1);
    const page = rows.slice(0, conversationCoreTuning.historyPageSize);
    const last = page.at(-1);
    return {
      conversations: page.map(toSummary),
      nextCursor:
        rows.length > conversationCoreTuning.historyPageSize && last !== undefined
          ? cursorCodec.encode({
              id: last.id,
              kind: "conversation-list",
              updatedAt: toDate(last.updatedAt).toISOString(),
              version: 1,
              view,
            })
          : null,
    };
  }

  async function create(actor: RequestActor): Promise<ConversationSummary> {
    const inserted = await database
      .insert(conversations)
      .values({ userId: actor.employee.id, workspaceId: actor.workspace.id })
      .returning();
    const row = inserted[0];
    if (row === undefined) {
      throw new Error("Conversation creation returned no row");
    }
    return toSummary(row);
  }

  async function insertImmutableMessage(
    actor: RequestActor,
    input: {
      readonly content: unknown;
      readonly conversationId: string;
      readonly parentMessageId: string | null;
      readonly role: "assistant" | "user";
    },
  ): Promise<ConversationMessage> {
    const parsed = parseMessageContent(input.content);
    const block = parsed[0];
    if (block === undefined) {
      throw new Error(conversationCopy.invalidContent);
    }
    const content: MessageContent = [{ type: "text", text: normalizeStoredText(block.text) }];
    return database.transaction(async (transaction) => {
      const owned = await transaction
        .select({
          id: conversations.id,
          selectedLeafMessageId: conversations.selectedLeafMessageId,
        })
        .from(conversations)
        .where(ownedConversationWhere(actor, input.conversationId))
        .limit(1)
        .for("update");
      const conversation = owned[0];
      if (conversation === undefined) {
        return notFound();
      }

      if (input.parentMessageId === null) {
        if (input.role !== "user") {
          throw new ApplicationError(400, "BAD_REQUEST", "La estructura del mensaje no es válida.");
        }
        const existingMessages = await transaction
          .select({ id: messages.id })
          .from(messages)
          .where(eq(messages.conversationId, input.conversationId))
          .limit(1);
        if (existingMessages.length !== 0) {
          throw new ApplicationError(400, "BAD_REQUEST", "La estructura del mensaje no es válida.");
        }
      } else {
        if (conversation.selectedLeafMessageId === input.parentMessageId) {
          throw new ApplicationError(
            400,
            "BAD_REQUEST",
            "La selección debe actualizarse junto con el nuevo mensaje.",
          );
        }
        const parentRows = await transaction
          .select({ role: messages.role })
          .from(messages)
          .where(
            and(
              eq(messages.conversationId, input.conversationId),
              eq(messages.id, input.parentMessageId),
            ),
          )
          .limit(1);
        const parent = parentRows[0];
        if (parent === undefined) {
          return notFound();
        }
        if (parent.role === input.role) {
          throw new ApplicationError(400, "BAD_REQUEST", "La estructura del mensaje no es válida.");
        }
      }

      const inserted = await transaction
        .insert(messages)
        .values({
          content,
          conversationId: input.conversationId,
          parentMessageId: input.parentMessageId,
          role: input.role,
        })
        .returning();
      const row = inserted[0];
      if (row === undefined) {
        throw new Error("Message insertion returned no row");
      }
      return {
        content: parseMessageContent(row.content),
        createdAt: row.createdAt.toISOString(),
        id: row.id,
        parentMessageId: row.parentMessageId,
        role: row.role,
        siblingCount: 0,
      };
    });
  }

  async function get(
    actor: RequestActor,
    conversationId: string,
    cursor?: string,
  ): Promise<ConversationDetailResponse> {
    return database.transaction(async (transaction) => {
      const conversationsRows = await transaction
        .select()
        .from(conversations)
        .where(ownedConversationWhere(actor, conversationId))
        .limit(1)
        .for("key share");
      const conversation = conversationsRows[0];
      if (conversation === undefined) {
        return notFound();
      }

      const cursorPayload =
        cursor === undefined ? undefined : cursorCodec.decode(cursor, "conversation-branch");
      if (conversation.selectedLeafMessageId === null) {
        if (cursorPayload !== undefined) {
          assertCursorUuid(cursorString(cursorPayload, "conversationId"));
          assertCursorUuid(cursorString(cursorPayload, "selectedLeafId"));
          cursorInteger(cursorPayload, "revision");
          assertCursorUuid(cursorString(cursorPayload, "startMessageId"));
          changed();
        }
        return {
          conversation: toSummary(conversation),
          messages: [],
          nextCursor: null,
          selectedLeafId: null,
        };
      }

      let startMessageId = conversation.selectedLeafMessageId;
      if (cursorPayload !== undefined) {
        if (
          assertCursorUuid(cursorString(cursorPayload, "conversationId")) !== conversation.id ||
          assertCursorUuid(cursorString(cursorPayload, "selectedLeafId")) !==
            conversation.selectedLeafMessageId ||
          cursorInteger(cursorPayload, "revision") !== conversation.revision
        ) {
          changed();
        }
        startMessageId = assertCursorUuid(cursorString(cursorPayload, "startMessageId"));
      }

      const result = await transaction.execute(sql<BranchRow>`
        WITH RECURSIVE selected_branch AS (
          SELECT message.id, message.parent_message_id, message.role, message.content,
            message.created_at, 0 AS depth
          FROM messages AS message
          WHERE message.conversation_id = ${conversation.id} AND message.id = ${startMessageId}
          UNION ALL
          SELECT parent.id, parent.parent_message_id, parent.role, parent.content,
            parent.created_at, selected_branch.depth + 1
          FROM messages AS parent
          INNER JOIN selected_branch
            ON parent.conversation_id = ${conversation.id}
            AND parent.id = selected_branch.parent_message_id
          WHERE selected_branch.depth < ${conversationCoreTuning.branchMessagePageSize}
        )
        SELECT selected_branch.id AS "id",
          selected_branch.parent_message_id AS "parentMessageId",
          selected_branch.role AS "role",
          selected_branch.content AS "content",
          selected_branch.created_at AS "createdAt",
          (
            SELECT count(*) - 1
            FROM messages AS sibling
            WHERE sibling.conversation_id = ${conversation.id}
              AND sibling.parent_message_id IS NOT DISTINCT FROM selected_branch.parent_message_id
          ) AS "siblingCount"
        FROM selected_branch
        ORDER BY selected_branch.depth ASC
        LIMIT ${conversationCoreTuning.branchMessagePageSize + 1}
      `);
      const rows = result.rows as unknown as BranchRow[];
      if (rows.length === 0) {
        throw new Error("Selected conversation branch could not be reconstructed");
      }
      const page = rows.slice(0, conversationCoreTuning.branchMessagePageSize);
      const nextStart = rows[conversationCoreTuning.branchMessagePageSize];
      return {
        conversation: toSummary(conversation),
        messages: [...page].reverse().map(toMessage),
        nextCursor:
          nextStart === undefined
            ? null
            : cursorCodec.encode({
                conversationId: conversation.id,
                kind: "conversation-branch",
                revision: conversation.revision,
                selectedLeafId: conversation.selectedLeafMessageId,
                startMessageId: nextStart.id,
                version: 1,
              }),
        selectedLeafId: conversation.selectedLeafMessageId,
      };
    });
  }

  async function rename(
    actor: RequestActor,
    conversationId: string,
    titleInput: string,
    observedRevision: number,
  ): Promise<ConversationSummary> {
    const title = normalizeManualTitle(titleInput);
    return database.transaction(async (transaction) => {
      const rows = await transaction
        .select()
        .from(conversations)
        .where(ownedConversationWhere(actor, conversationId))
        .limit(1)
        .for("update");
      const conversation = rows[0];
      if (conversation === undefined) {
        return notFound();
      }
      if (conversation.title === title) {
        return toSummary(conversation);
      }
      if (conversation.revision !== observedRevision) {
        return changed();
      }
      const updated = await transaction
        .update(conversations)
        .set({ revision: conversation.revision + 1, title, updatedAt: new Date() })
        .where(
          and(
            ownedConversationWhere(actor, conversationId),
            eq(conversations.revision, observedRevision),
          ),
        )
        .returning();
      return updated[0] === undefined ? changed() : toSummary(updated[0]);
    });
  }

  async function selectLeaf(
    actor: RequestActor,
    conversationId: string,
    leafMessageId: string,
    observedRevision: number,
  ): Promise<ConversationSelectionResponse> {
    return database.transaction(async (transaction) => {
      const rows = await transaction
        .select()
        .from(conversations)
        .where(ownedConversationWhere(actor, conversationId))
        .limit(1)
        .for("update");
      const conversation = rows[0];
      if (conversation === undefined) {
        return notFound();
      }
      if (conversation.selectedLeafMessageId === leafMessageId) {
        return { conversation: toSummary(conversation), selectedLeafId: leafMessageId };
      }
      if (conversation.revision !== observedRevision) {
        return changed();
      }

      const candidates = await transaction
        .select({ id: messages.id })
        .from(messages)
        .where(and(eq(messages.conversationId, conversation.id), eq(messages.id, leafMessageId)))
        .limit(1);
      if (candidates.length !== 1) {
        return notFound();
      }
      const children = await transaction
        .select({ id: messages.id })
        .from(messages)
        .where(
          and(
            eq(messages.conversationId, conversation.id),
            eq(messages.parentMessageId, leafMessageId),
          ),
        )
        .limit(1);
      if (children.length !== 0) {
        return notFound();
      }

      const updated = await transaction
        .update(conversations)
        .set({
          revision: conversation.revision + 1,
          selectedLeafMessageId: leafMessageId,
          updatedAt: new Date(),
        })
        .where(
          and(
            ownedConversationWhere(actor, conversationId),
            eq(conversations.revision, observedRevision),
          ),
        )
        .returning();
      const row = updated[0];
      if (row === undefined) {
        return changed();
      }
      return { conversation: toSummary(row), selectedLeafId: leafMessageId };
    });
  }

  async function setArchived(
    actor: RequestActor,
    conversationId: string,
    archived: boolean,
    observedRevision: number,
  ): Promise<ConversationSummary> {
    return database.transaction(async (transaction) => {
      const rows = await transaction
        .select()
        .from(conversations)
        .where(ownedConversationWhere(actor, conversationId))
        .limit(1)
        .for("update");
      const conversation = rows[0];
      if (conversation === undefined) {
        return notFound();
      }
      if ((conversation.archivedAt !== null) === archived) {
        return toSummary(conversation);
      }
      if (conversation.revision !== observedRevision) {
        return changed();
      }
      const now = new Date();
      const updated = await transaction
        .update(conversations)
        .set({
          archivedAt: archived ? now : null,
          revision: conversation.revision + 1,
          updatedAt: now,
        })
        .where(
          and(
            ownedConversationWhere(actor, conversationId),
            eq(conversations.revision, observedRevision),
          ),
        )
        .returning();
      return updated[0] === undefined ? changed() : toSummary(updated[0]);
    });
  }

  async function remove(
    actor: RequestActor,
    conversationId: string,
    observedRevision: number,
  ): Promise<void> {
    await database.transaction(async (transaction) => {
      const rows = await transaction
        .select({ revision: conversations.revision })
        .from(conversations)
        .where(ownedConversationWhere(actor, conversationId))
        .limit(1)
        .for("update");
      const conversation = rows[0];
      if (conversation === undefined) {
        return notFound();
      }
      if (conversation.revision !== observedRevision) {
        return changed();
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
    });
  }

  function draftScopeWhere(actor: RequestActor, scope: DraftScope) {
    return and(
      eq(drafts.workspaceId, actor.workspace.id),
      eq(drafts.userId, actor.employee.id),
      scope.kind === "new"
        ? isNull(drafts.conversationId)
        : eq(drafts.conversationId, scope.conversationId),
    );
  }

  async function getDraft(actor: RequestActor, scope: DraftScope): Promise<DraftState> {
    return database.transaction(async (transaction) => {
      if (scope.kind === "conversation") {
        const owned = await transaction
          .select({ id: conversations.id })
          .from(conversations)
          .where(ownedConversationWhere(actor, scope.conversationId))
          .limit(1)
          .for("key share");
        if (owned.length !== 1) {
          return notFound();
        }
      }

      const rows = await transaction
        .select()
        .from(drafts)
        .where(draftScopeWhere(actor, scope))
        .limit(1);
      const draft = rows[0];
      if (draft === undefined) {
        return { content: "", revision: 0, scope, updatedAt: null };
      }
      return {
        content: draft.content,
        revision: draft.revision,
        scope,
        updatedAt: draft.updatedAt.toISOString(),
      };
    });
  }

  async function saveDraft(
    actor: RequestActor,
    scope: DraftScope,
    contentInput: string,
    observedRevision: number,
  ): Promise<DraftState> {
    const content = normalizeDraftContent(contentInput);
    try {
      return await database.transaction(async (transaction) => {
        if (scope.kind === "conversation") {
          const owned = await transaction
            .select({ id: conversations.id })
            .from(conversations)
            .where(ownedConversationWhere(actor, scope.conversationId))
            .limit(1)
            .for("key share");
          if (owned.length !== 1) {
            return notFound();
          }
        }

        const rows = await transaction
          .select()
          .from(drafts)
          .where(draftScopeWhere(actor, scope))
          .limit(1)
          .for("update");
        const draft = rows[0];
        const now = new Date();
        if (draft === undefined) {
          if (observedRevision !== 0) {
            return draftChanged();
          }
          const inserted = await transaction
            .insert(drafts)
            .values({
              content,
              conversationId: scope.kind === "conversation" ? scope.conversationId : null,
              revision: 1,
              updatedAt: now,
              userId: actor.employee.id,
              workspaceId: actor.workspace.id,
            })
            .returning();
          const row = inserted[0];
          if (row === undefined) {
            throw new Error("Draft insertion returned no row");
          }
          return {
            content: row.content,
            revision: row.revision,
            scope,
            updatedAt: row.updatedAt.toISOString(),
          };
        }
        if (draft.revision !== observedRevision) {
          return draftChanged();
        }
        const updated = await transaction
          .update(drafts)
          .set({ content, revision: draft.revision + 1, updatedAt: now })
          .where(and(eq(drafts.id, draft.id), eq(drafts.revision, observedRevision)))
          .returning();
        const row = updated[0];
        if (row === undefined) {
          return draftChanged();
        }
        return {
          content: row.content,
          revision: row.revision,
          scope,
          updatedAt: row.updatedAt.toISOString(),
        };
      });
    } catch (error: unknown) {
      if (isUniqueViolation(error)) {
        return draftChanged();
      }
      throw error;
    }
  }

  async function search(
    actor: RequestActor,
    queryInput: string,
    cursor?: string,
  ): Promise<ConversationSearchResponse> {
    const normalizedQuery = normalizeSearchQuery(queryInput);
    let cursorPriority: number | undefined;
    let cursorRank: string | undefined;
    let cursorUpdatedAt: Date | undefined;
    let cursorConversationId: string | undefined;
    let cursorResultId: string | undefined;
    if (cursor !== undefined) {
      const payload = cursorCodec.decode(cursor, "conversation-search");
      if (cursorString(payload, "query") !== normalizedQuery) {
        throw new ApplicationError(400, "INVALID_CURSOR", "El cursor de paginación no es válido.");
      }
      cursorPriority = cursorInteger(payload, "priority");
      cursorRank = cursorString(payload, "rank");
      if (
        !/^\d+(?:\.\d+)?(?:e-?\d+)?$/iu.test(cursorRank) ||
        !Number.isFinite(Number(cursorRank))
      ) {
        throw new ApplicationError(400, "INVALID_CURSOR", "El cursor de paginación no es válido.");
      }
      cursorUpdatedAt = assertCursorDate(cursorString(payload, "updatedAt"));
      cursorConversationId = assertCursorUuid(cursorString(payload, "conversationId"));
      cursorResultId = assertCursorUuid(cursorString(payload, "resultId"));
    }

    const cursorPredicate =
      cursorPriority === undefined ||
      cursorRank === undefined ||
      cursorUpdatedAt === undefined ||
      cursorConversationId === undefined ||
      cursorResultId === undefined
        ? sql``
        : sql`
          WHERE hit.match_priority > ${cursorPriority}
            OR (
              hit.match_priority = ${cursorPriority}
              AND (
                hit.rank < ${cursorRank}::real
                OR (
                  hit.rank = ${cursorRank}::real
                  AND (
                    hit.updated_at < ${cursorUpdatedAt}
                    OR (
                      hit.updated_at = ${cursorUpdatedAt}
                      AND (
                        hit.conversation_id < ${cursorConversationId}::uuid
                        OR (
                          hit.conversation_id = ${cursorConversationId}::uuid
                          AND hit.result_id < ${cursorResultId}::uuid
                        )
                      )
                    )
                  )
                )
              )
            )
        `;

    const result = await database.execute(sql<SearchRow>`
      WITH query_terms AS (
        SELECT query_term.value, query_term.term_position
        FROM string_to_table(${normalizedQuery}, ' ')
          WITH ORDINALITY AS query_term(value, term_position)
        WHERE query_term.value <> ''
      ),
      parsed_lexemes AS (
        SELECT query_term.term_position, parsed.ordinality AS parser_position,
          derived.lexeme_ordinality, derived.lexeme
        FROM query_terms AS query_term
        CROSS JOIN LATERAL ts_debug(
          'simple',
          public.capstone_search_normalize(query_term.value)
        ) WITH ORDINALITY AS parsed
        CROSS JOIN LATERAL unnest(coalesce(parsed.lexemes, ARRAY[]::text[]))
          WITH ORDINALITY AS derived(lexeme, lexeme_ordinality)
        WHERE derived.lexeme <> ''
      ),
      ordered_lexemes AS (
        SELECT lexeme,
          row_number() OVER (
            ORDER BY term_position, parser_position, lexeme_ordinality
          ) AS position,
          term_position = max(term_position) OVER () AS uses_prefix
        FROM parsed_lexemes
      ),
      prepared_query AS (
        SELECT CASE
          WHEN count(*) = 0 THEN NULL::tsquery
          ELSE to_tsquery(
            'simple',
            string_agg(
              quote_literal(lexeme) || CASE WHEN uses_prefix THEN ':*' ELSE '' END,
              ' & ' ORDER BY position
            )
          )
        END AS query,
        array_agg(lexeme ORDER BY position) AS lexemes,
        array_agg(uses_prefix ORDER BY position) AS prefix_flags
        FROM ordered_lexemes
      ),
      title_hits AS (
        SELECT conversation.id AS conversation_id,
          conversation.workspace_id,
          conversation.user_id,
          conversation.title,
          conversation.selected_leaf_message_id,
          conversation.revision,
          conversation.archived_at,
          conversation.created_at,
          conversation.updated_at,
          conversation.selected_leaf_message_id AS leaf_message_id,
          NULL::uuid AS matched_message_id,
          'title'::text AS match_kind,
          conversation.title AS source_text,
          prepared_query.lexemes AS query_lexemes,
          prepared_query.prefix_flags AS query_prefix_flags,
          0 AS match_priority,
          ts_rank_cd(conversation.title_search_vector, prepared_query.query) AS rank,
          conversation.id AS result_id
        FROM conversations AS conversation
        CROSS JOIN prepared_query
        WHERE conversation.workspace_id = ${actor.workspace.id}
          AND conversation.user_id = ${actor.employee.id}
          AND conversation.selected_leaf_message_id IS NOT NULL
          AND conversation.title_search_vector @@ prepared_query.query
      ),
      message_hits AS (
        SELECT conversation.id AS conversation_id,
          conversation.workspace_id,
          conversation.user_id,
          conversation.title,
          conversation.selected_leaf_message_id,
          conversation.revision,
          conversation.archived_at,
          conversation.created_at,
          conversation.updated_at,
          resolved_leaf.id AS leaf_message_id,
          message.id AS matched_message_id,
          'message'::text AS match_kind,
          message.content -> 0 ->> 'text' AS source_text,
          prepared_query.lexemes AS query_lexemes,
          prepared_query.prefix_flags AS query_prefix_flags,
          1 AS match_priority,
          ts_rank_cd(message.content_search_vector, prepared_query.query) AS rank,
          message.id AS result_id
        FROM messages AS message
        INNER JOIN conversations AS conversation ON conversation.id = message.conversation_id
        CROSS JOIN prepared_query
        INNER JOIN LATERAL (
          WITH RECURSIVE descendants AS (
            SELECT candidate.id, candidate.created_at
            FROM messages AS candidate
            WHERE candidate.conversation_id = conversation.id AND candidate.id = message.id
            UNION ALL
            SELECT child.id, child.created_at
            FROM messages AS child
            INNER JOIN descendants ON child.parent_message_id = descendants.id
            WHERE child.conversation_id = conversation.id
          )
          SELECT descendant.id
          FROM descendants AS descendant
          WHERE NOT EXISTS (
            SELECT 1
            FROM messages AS child
            WHERE child.conversation_id = conversation.id
              AND child.parent_message_id = descendant.id
          )
          ORDER BY
            (descendant.id = conversation.selected_leaf_message_id) DESC,
            descendant.created_at DESC,
            descendant.id DESC
          LIMIT 1
        ) AS resolved_leaf ON true
        WHERE conversation.workspace_id = ${actor.workspace.id}
          AND conversation.user_id = ${actor.employee.id}
          AND conversation.selected_leaf_message_id IS NOT NULL
          AND message.content_search_vector @@ prepared_query.query
      ),
      all_hits AS (
        SELECT * FROM title_hits
        UNION ALL
        SELECT * FROM message_hits
      ),
      paged_hits AS (
        SELECT hit.*
        FROM all_hits AS hit
        ${cursorPredicate}
        ORDER BY hit.match_priority ASC, hit.rank DESC, hit.updated_at DESC,
          hit.conversation_id DESC, hit.result_id DESC
        LIMIT ${conversationCoreTuning.searchPageSize + 1}
      )
      SELECT hit.conversation_id AS "id",
        hit.workspace_id AS "workspaceId",
        hit.user_id AS "userId",
        hit.title AS "title",
        hit.selected_leaf_message_id AS "selectedLeafMessageId",
        hit.revision AS "revision",
        hit.archived_at AS "archivedAt",
        hit.created_at AS "createdAt",
        hit.updated_at AS "updatedAt",
        hit.leaf_message_id AS "leafMessageId",
        hit.matched_message_id AS "matchedMessageId",
        hit.match_kind AS "matchKind",
        hit.source_text AS "sourceText",
        hit.query_lexemes AS "queryLexemes",
        hit.query_prefix_flags AS "queryPrefixFlags",
        snippet_metadata.source_folds AS "sourceFolds",
        hit.rank::text AS "rank",
        hit.result_id AS "resultId"
      FROM paged_hits AS hit
      LEFT JOIN LATERAL (
        -- Stored text rejects U+0001, so it is an unambiguous separator for
        -- one authoritative unaccent call while retaining each code-point fold.
        SELECT string_to_array(
          public.capstone_search_normalize(
            string_agg(source_character.value, chr(1) ORDER BY source_character.ordinality)
          ),
          chr(1)
        ) AS source_folds
        FROM unnest(string_to_array(hit.source_text, NULL))
          WITH ORDINALITY AS source_character(value, ordinality)
      ) AS snippet_metadata ON true
      ORDER BY hit.match_priority ASC, hit.rank DESC, hit.updated_at DESC,
        hit.conversation_id DESC, hit.result_id DESC
    `);
    const rows = result.rows as unknown as SearchRow[];
    const page = rows.slice(0, conversationCoreTuning.searchPageSize);
    const last = page.at(-1);
    return {
      nextCursor:
        rows.length > conversationCoreTuning.searchPageSize && last !== undefined
          ? cursorCodec.encode({
              conversationId: last.id,
              kind: "conversation-search",
              priority: last.matchKind === "title" ? 0 : 1,
              query: normalizedQuery,
              rank: last.rank,
              resultId: last.resultId,
              updatedAt: toDate(last.updatedAt).toISOString(),
              version: 1,
            })
          : null,
      results: page.map((row) => {
        if (
          row.sourceFolds === null ||
          row.queryLexemes === null ||
          row.queryPrefixFlags === null
        ) {
          throw new Error("Search hit is missing its PostgreSQL-derived snippet metadata");
        }
        const common = {
          conversation: toSummary(row),
          leafMessageId: row.leafMessageId,
          snippet: [
            ...createPostgresSearchSnippet(
              row.sourceText,
              row.sourceFolds,
              row.queryLexemes,
              row.queryPrefixFlags,
            ),
          ],
        };
        if (row.matchKind === "title") {
          return { ...common, matchKind: "title" as const, matchedMessageId: null };
        }
        if (row.matchedMessageId === null) {
          throw new Error("Message search result is missing its message identifier");
        }
        return {
          ...common,
          matchKind: "message" as const,
          matchedMessageId: row.matchedMessageId,
        };
      }),
    };
  }

  return Object.freeze({
    create,
    get,
    getDraft,
    insertImmutableMessage,
    list,
    remove,
    rename,
    saveDraft,
    search,
    selectLeaf,
    setArchived,
  });
}

export type ConversationService = ReturnType<typeof createConversationService>;

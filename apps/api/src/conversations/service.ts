import type {
  AlternativeContextResponse,
  ConversationDetailResponse,
  ConversationListResponse,
  ConversationMessage,
  ConversationPreferredTierResponse,
  ConversationSearchResponse,
  ConversationSelectionResponse,
  ConversationSummary,
  ConversationView,
  DraftScope,
  DraftState,
  GenerationModelTier,
  MessageContent,
} from "@capstone/protocol";
import { ALTERNATIVE_CONTEXT_MAX_MESSAGE_IDS } from "@capstone/protocol";
import { and, desc, eq, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import type { ModelGatewayMode } from "../config.js";
import { conversations, drafts, messages } from "../database/conversation-schema.js";
import type { AppDatabase } from "../database/database.js";
import { generations, nonterminalGenerationStatuses } from "../database/generation-schema.js";
import { isPostgresError } from "../database/postgres-error.js";
import { ApplicationError } from "../errors.js";
import type { RequestActor } from "../identity/authorization.js";
import {
  createModelPolicyService,
  ModelPolicyNotFoundError,
  type ModelPolicyService,
  ModelPolicyUnavailableError,
} from "../model-policy/service.js";
import {
  createPostgresSearchSnippet,
  normalizeDraftContent,
  normalizeManualTitle,
  normalizeSearchQuery,
  normalizeStoredText,
  parseMessageContent,
} from "./content.js";
import { type CursorCodec, cursorInteger, cursorString } from "./cursor.js";
import { conversationCoreTuning } from "./settings.js";

const conversationCopy = {
  changed: "La conversación cambió. Actualiza la información e inténtalo de nuevo.",
  draftChanged: "El borrador cambió en otra pestaña o dispositivo.",
  generationActive: "Detén la respuesta en curso antes de cambiar de rama.",
  invalidAlternativeContext: "Los mensajes solicitados no pertenecen a la rama seleccionada.",
  invalidContent: "El contenido almacenado de la conversación no es válido.",
  notFound: "No se encontró la conversación solicitada.",
  tierUnavailable: "Este nivel no está disponible en este momento.",
  undoUnavailable: "No hay un turno anterior para deshacer.",
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

interface AlternativeContextRow {
  readonly messageId: string;
  readonly nextLeafMessageId: string | null;
  readonly position: number | string;
  readonly previousLeafMessageId: string | null;
  readonly total: number | string;
}

interface UndoTargetRow {
  readonly currentRole: "assistant" | "user";
  readonly targetMessageId: string | null;
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

export function createConversationService(
  database: AppDatabase,
  cursorCodec: CursorCodec,
  modelGateway: ModelGatewayMode = "fake",
  modelPolicy: ModelPolicyService = createModelPolicyService(database),
) {
  const modelPolicyMode = modelGateway === "openrouter" ? "openrouter" : "simulated";

  async function workspaceDefaultTier(workspaceId: string): Promise<GenerationModelTier> {
    const policy = await modelPolicy.readEmployeeTierPolicy(workspaceId, modelPolicyMode);
    return policy.defaultTier;
  }

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

  async function create(
    actor: RequestActor,
    adoptNewDraftRevision?: number,
  ): Promise<ConversationSummary> {
    const preferredTier = await workspaceDefaultTier(actor.workspace.id);
    if (adoptNewDraftRevision === undefined) {
      const inserted = await database
        .insert(conversations)
        .values({ preferredTier, userId: actor.employee.id, workspaceId: actor.workspace.id })
        .returning();
      const row = inserted[0];
      if (row === undefined) {
        throw new Error("Conversation creation returned no row");
      }
      return toSummary(row);
    }

    return database.transaction(async (transaction) => {
      const draftRows = await transaction
        .select()
        .from(drafts)
        .where(
          and(
            eq(drafts.workspaceId, actor.workspace.id),
            eq(drafts.userId, actor.employee.id),
            isNull(drafts.conversationId),
          ),
        )
        .limit(1)
        .for("update");
      const draft = draftRows[0];
      if (draft === undefined || draft.revision !== adoptNewDraftRevision) {
        return draftChanged();
      }
      if (!/\S/u.test(draft.content)) {
        throw new ApplicationError(400, "BAD_REQUEST", "Escribe un mensaje antes de enviarlo.");
      }

      const inserted = await transaction
        .insert(conversations)
        .values({ preferredTier, userId: actor.employee.id, workspaceId: actor.workspace.id })
        .returning();
      const conversation = inserted[0];
      if (conversation === undefined) {
        throw new Error("Conversation creation returned no row");
      }
      const adopted = await transaction
        .update(drafts)
        .set({ conversationId: conversation.id })
        .where(and(eq(drafts.id, draft.id), eq(drafts.revision, adoptNewDraftRevision)))
        .returning({ id: drafts.id });
      if (adopted.length !== 1) {
        return draftChanged();
      }
      return toSummary(conversation);
    });
  }

  async function getPreferredTier(
    actor: RequestActor,
    conversationId: string,
  ): Promise<ConversationPreferredTierResponse> {
    const modelTier = await modelPolicy.getPreferredTier({
      conversationId,
      userId: actor.employee.id,
      workspaceId: actor.workspace.id,
    });
    if (modelTier === null) {
      return notFound();
    }
    return { conversationId, modelTier };
  }

  async function setPreferredTier(
    actor: RequestActor,
    conversationId: string,
    modelTier: GenerationModelTier,
  ): Promise<ConversationPreferredTierResponse> {
    try {
      const updated = await modelPolicy.setPreferredTier(
        {
          conversationId,
          userId: actor.employee.id,
          workspaceId: actor.workspace.id,
        },
        modelTier,
        modelPolicyMode,
      );
      return { conversationId, modelTier: updated };
    } catch (error: unknown) {
      if (error instanceof ModelPolicyNotFoundError) {
        return notFound();
      }
      if (error instanceof ModelPolicyUnavailableError) {
        throw new ApplicationError(409, "TIER_UNAVAILABLE", conversationCopy.tierUnavailable);
      }
      throw error;
    }
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
        // A same-title rename stays a revision no-op but still records manual intent so a pending
        // automatic title can never overwrite the employee's choice.
        if (conversation.automaticTitlePending) {
          await transaction
            .update(conversations)
            .set({ automaticTitlePending: false })
            .where(eq(conversations.id, conversation.id));
        }
        return toSummary(conversation);
      }
      const automaticTitleSettledSinceObservation =
        conversation.revision === observedRevision + 1 &&
        conversation.automaticTitleSettledRevision === conversation.revision;
      if (conversation.revision !== observedRevision && !automaticTitleSettledSinceObservation) {
        return changed();
      }
      const currentRevision = conversation.revision;
      const updated = await transaction
        .update(conversations)
        .set({
          automaticTitlePending: false,
          revision: currentRevision + 1,
          title,
          updatedAt: new Date(),
        })
        .where(
          and(
            ownedConversationWhere(actor, conversationId),
            eq(conversations.revision, currentRevision),
          ),
        )
        .returning();
      return updated[0] === undefined ? changed() : toSummary(updated[0]);
    });
  }

  async function selectLeaf(
    actor: RequestActor,
    conversationId: string,
    selectionTargetMessageId: string,
    observedRevision: number,
  ): Promise<ConversationSelectionResponse> {
    const preflightRows = await database
      .select()
      .from(conversations)
      .where(ownedConversationWhere(actor, conversationId))
      .limit(1);
    const preflightConversation = preflightRows[0];
    if (preflightConversation === undefined) {
      return notFound();
    }
    if (preflightConversation.selectedLeafMessageId === selectionTargetMessageId) {
      return {
        conversation: toSummary(preflightConversation),
        selectedLeafId: selectionTargetMessageId,
      };
    }
    const preflightActiveGenerations = await database
      .select({ id: generations.id })
      .from(generations)
      .where(
        and(
          eq(generations.conversationId, conversationId),
          inArray(generations.status, [...nonterminalGenerationStatuses]),
        ),
      )
      .limit(1);
    if (preflightActiveGenerations.length !== 0) {
      throw new ApplicationError(409, "GENERATION_ACTIVE", conversationCopy.generationActive);
    }
    if (preflightConversation.revision !== observedRevision) {
      return changed();
    }

    const candidates = await database
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, preflightConversation.id),
          eq(messages.id, selectionTargetMessageId),
        ),
      )
      .limit(1);
    if (candidates.length !== 1) {
      return notFound();
    }
    let resolvedLeafMessageId = selectionTargetMessageId;
    const children = await database
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, preflightConversation.id),
          eq(messages.parentMessageId, selectionTargetMessageId),
        ),
      )
      .limit(1);
    if (children.length !== 0) {
      // Alternative metadata keeps its leaf-named wire fields for compatibility but carries an
      // adjacent sibling root. Resolve its deterministic leaf only after the employee activates it.
      // This potentially large immutable-tree read stays outside the short selection transaction;
      // the revision fence below rejects any structural change that races with this snapshot.
      const result = await database.execute(sql<{ id: string }>`
        WITH RECURSIVE selected_path AS (
          SELECT message.id, message.parent_message_id
          FROM messages AS message
          WHERE message.conversation_id = ${preflightConversation.id}
            AND message.id = ${preflightConversation.selectedLeafMessageId}
          UNION ALL
          SELECT parent.id, parent.parent_message_id
          FROM messages AS parent
          INNER JOIN selected_path
            ON parent.conversation_id = ${preflightConversation.id}
            AND parent.id = selected_path.parent_message_id
        ),
        alternative_root AS (
          SELECT candidate.id, candidate.created_at
          FROM messages AS candidate
          WHERE candidate.conversation_id = ${preflightConversation.id}
            AND candidate.id = ${selectionTargetMessageId}
            AND EXISTS (
              SELECT 1
              FROM selected_path AS selected
              WHERE selected.id <> candidate.id
                AND selected.parent_message_id IS NOT DISTINCT FROM candidate.parent_message_id
            )
        ),
        descendants AS (
          SELECT root.id, root.created_at
          FROM alternative_root AS root
          UNION ALL
          SELECT child.id, child.created_at
          FROM descendants AS descendant
          INNER JOIN messages AS child
            ON child.conversation_id = ${preflightConversation.id}
            AND child.parent_message_id = descendant.id
        )
        SELECT descendant.id AS "id"
        FROM descendants AS descendant
        WHERE NOT EXISTS (
          SELECT 1
          FROM messages AS child
          WHERE child.conversation_id = ${preflightConversation.id}
            AND child.parent_message_id = descendant.id
        )
        ORDER BY descendant.created_at DESC, descendant.id DESC
        LIMIT 1
      `);
      const resolved = (result.rows as unknown as { readonly id: string }[])[0];
      if (resolved === undefined) {
        return notFound();
      }
      resolvedLeafMessageId = resolved.id;
    }

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
      if (conversation.selectedLeafMessageId === selectionTargetMessageId) {
        return {
          conversation: toSummary(conversation),
          selectedLeafId: selectionTargetMessageId,
        };
      }
      const activeGenerations = await transaction
        .select({ id: generations.id })
        .from(generations)
        .where(
          and(
            eq(generations.conversationId, conversationId),
            inArray(generations.status, [...nonterminalGenerationStatuses]),
          ),
        )
        .limit(1);
      if (activeGenerations.length !== 0) {
        throw new ApplicationError(409, "GENERATION_ACTIVE", conversationCopy.generationActive);
      }
      if (
        conversation.revision !== observedRevision ||
        conversation.revision !== preflightConversation.revision
      ) {
        return changed();
      }
      const updated = await transaction
        .update(conversations)
        .set({
          revision: conversation.revision + 1,
          selectedLeafMessageId: resolvedLeafMessageId,
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
      return { conversation: toSummary(row), selectedLeafId: resolvedLeafMessageId };
    });
  }

  async function getAlternativeContexts(
    actor: RequestActor,
    conversationId: string,
    messageIds: readonly string[],
  ): Promise<AlternativeContextResponse> {
    if (
      messageIds.length === 0 ||
      messageIds.length > ALTERNATIVE_CONTEXT_MAX_MESSAGE_IDS ||
      new Set(messageIds).size !== messageIds.length
    ) {
      throw new ApplicationError(400, "BAD_REQUEST", conversationCopy.invalidAlternativeContext);
    }

    return database.transaction(async (transaction) => {
      const conversationRows = await transaction
        .select()
        .from(conversations)
        .where(ownedConversationWhere(actor, conversationId))
        .limit(1)
        .for("share");
      const conversation = conversationRows[0];
      if (conversation === undefined) {
        return notFound();
      }
      if (conversation.selectedLeafMessageId === null) {
        throw new ApplicationError(400, "BAD_REQUEST", conversationCopy.invalidAlternativeContext);
      }
      const requestedMessageIds = sql.join(
        messageIds.map((messageId) => sql`${messageId}`),
        sql`, `,
      );

      const result = await transaction.execute(sql<AlternativeContextRow>`
        WITH RECURSIVE selected_path AS (
          SELECT message.id, message.parent_message_id
          FROM messages AS message
          WHERE message.conversation_id = ${conversation.id}
            AND message.id = ${conversation.selectedLeafMessageId}
          UNION ALL
          SELECT parent.id, parent.parent_message_id
          FROM messages AS parent
          INNER JOIN selected_path
            ON parent.conversation_id = ${conversation.id}
            AND parent.id = selected_path.parent_message_id
        ),
        requested AS (
          SELECT requested_message.id, requested_message.input_position
          FROM unnest(ARRAY[${requestedMessageIds}]::uuid[]) WITH ORDINALITY
            AS requested_message(id, input_position)
        ),
        requested_messages AS (
          SELECT message.id, message.parent_message_id,
            requested.input_position
          FROM requested
          INNER JOIN selected_path ON selected_path.id = requested.id
          INNER JOIN messages AS message
            ON message.conversation_id = ${conversation.id}
            AND message.id = requested.id
        ),
        requested_parents AS (
          SELECT DISTINCT requested_message.parent_message_id
          FROM requested_messages AS requested_message
        ),
        ordered_siblings AS (
          SELECT sibling.id, sibling.parent_message_id,
            row_number() OVER (
              PARTITION BY sibling.parent_message_id
              ORDER BY sibling.created_at ASC, sibling.id ASC
            ) AS position,
            count(*) OVER (PARTITION BY sibling.parent_message_id) AS total
          FROM messages AS sibling
          WHERE sibling.conversation_id = ${conversation.id}
            AND EXISTS (
              SELECT 1
              FROM requested_parents AS requested_parent
              WHERE requested_parent.parent_message_id
                IS NOT DISTINCT FROM sibling.parent_message_id
            )
        ),
        current_context AS (
          SELECT requested_message.id AS message_id,
            requested_message.input_position,
            current_sibling.position,
            current_sibling.total,
            previous_sibling.id AS previous_sibling_id,
            next_sibling.id AS next_sibling_id
          FROM requested_messages AS requested_message
          INNER JOIN ordered_siblings AS current_sibling
            ON current_sibling.id = requested_message.id
          LEFT JOIN ordered_siblings AS previous_sibling
            ON previous_sibling.parent_message_id
              IS NOT DISTINCT FROM current_sibling.parent_message_id
            AND previous_sibling.position = current_sibling.position - 1
          LEFT JOIN ordered_siblings AS next_sibling
            ON next_sibling.parent_message_id
              IS NOT DISTINCT FROM current_sibling.parent_message_id
            AND next_sibling.position = current_sibling.position + 1
        )
        -- Keep automatic metadata reads bounded to the selected path and its direct siblings.
        -- The existing selection route resolves an internal adjacent target only after activation.
        SELECT context.message_id AS "messageId",
          context.position AS "position",
          context.total AS "total",
          context.previous_sibling_id AS "previousLeafMessageId",
          context.next_sibling_id AS "nextLeafMessageId"
        FROM current_context AS context
        ORDER BY context.input_position ASC
      `);
      const rows = result.rows as unknown as AlternativeContextRow[];
      if (rows.length !== messageIds.length) {
        throw new ApplicationError(400, "BAD_REQUEST", conversationCopy.invalidAlternativeContext);
      }
      return {
        contexts: rows.map((row) => ({
          messageId: row.messageId,
          nextLeafMessageId: row.nextLeafMessageId,
          position: Number(row.position),
          previousLeafMessageId: row.previousLeafMessageId,
          total: Number(row.total),
        })),
        conversationId,
        revision: conversation.revision,
      };
    });
  }

  async function undo(
    actor: RequestActor,
    conversationId: string,
    observedRevision: number,
  ): Promise<ConversationSelectionResponse> {
    return database.transaction(async (transaction) => {
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
      const activeRows = await transaction
        .select({ id: generations.id })
        .from(generations)
        .where(
          and(
            eq(generations.conversationId, conversationId),
            inArray(generations.status, [...nonterminalGenerationStatuses]),
          ),
        )
        .limit(1);
      if (activeRows.length !== 0) {
        throw new ApplicationError(409, "GENERATION_ACTIVE", conversationCopy.generationActive);
      }
      if (conversation.revision !== observedRevision) {
        return changed();
      }
      if (conversation.selectedLeafMessageId === null) {
        throw new ApplicationError(400, "BAD_REQUEST", conversationCopy.undoUnavailable);
      }

      const targetResult = await transaction.execute(sql<UndoTargetRow>`
        WITH RECURSIVE selected_path AS (
          SELECT message.id, message.parent_message_id, message.role, 0 AS depth
          FROM messages AS message
          WHERE message.conversation_id = ${conversation.id}
            AND message.id = ${conversation.selectedLeafMessageId}
          UNION ALL
          SELECT parent.id, parent.parent_message_id, parent.role,
            selected_path.depth + 1
          FROM messages AS parent
          INNER JOIN selected_path
            ON parent.conversation_id = ${conversation.id}
            AND parent.id = selected_path.parent_message_id
        )
        SELECT (
            SELECT selected.role FROM selected_path AS selected WHERE selected.depth = 0
          ) AS "currentRole",
          (
            SELECT ancestor.id
            FROM selected_path AS ancestor
            WHERE ancestor.depth > 0 AND ancestor.role = 'assistant'
            ORDER BY ancestor.depth ASC
            LIMIT 1
          ) AS "targetMessageId"
      `);
      const target = (targetResult.rows as unknown as UndoTargetRow[])[0];
      if (target?.currentRole !== "assistant" || target.targetMessageId === null) {
        throw new ApplicationError(400, "BAD_REQUEST", conversationCopy.undoUnavailable);
      }

      const now = new Date();
      const updatedRows = await transaction
        .update(conversations)
        .set({
          revision: conversation.revision + 1,
          selectedLeafMessageId: target.targetMessageId,
          updatedAt: now,
        })
        .where(
          and(
            ownedConversationWhere(actor, conversationId),
            eq(conversations.revision, observedRevision),
          ),
        )
        .returning();
      const updated = updatedRows[0];
      if (updated === undefined) {
        return changed();
      }
      return { conversation: toSummary(updated), selectedLeafId: target.targetMessageId };
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
      const activeRows = await transaction
        .select({ id: generations.id })
        .from(generations)
        .where(
          and(
            eq(generations.conversationId, conversationId),
            inArray(generations.status, [...nonterminalGenerationStatuses]),
          ),
        )
        .limit(1);
      if (activeRows.length !== 0) {
        throw new ApplicationError(409, "GENERATION_ACTIVE", conversationCopy.generationActive);
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
      if (
        isPostgresError(error, "23505", "drafts_conversation_scope_unique") ||
        isPostgresError(error, "23505", "drafts_new_chat_scope_unique")
      ) {
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
          WHERE descendant.id = conversation.selected_leaf_message_id
            OR NOT EXISTS (
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
    getAlternativeContexts,
    getDraft,
    getPreferredTier,
    insertImmutableMessage,
    list,
    rename,
    saveDraft,
    search,
    selectLeaf,
    setArchived,
    setPreferredTier,
    undo,
  });
}

export type ConversationService = ReturnType<typeof createConversationService>;

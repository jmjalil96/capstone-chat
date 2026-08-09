import type {
  CreateResponseRequest,
  GenerationModelTier,
  ResponseState,
  ResponseStateResponse,
  StoredGenerationErrorCode,
} from "@capstone/protocol";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  createInitialTitle,
  hasUnsupportedControlCharacter,
  normalizeStoredText,
  parseMessageContent,
} from "../conversations/content.js";
import { conversationCompactions } from "../database/compaction-schema.js";
import { conversations, messages } from "../database/conversation-schema.js";
import type { AppDatabase } from "../database/database.js";
import { generations } from "../database/generation-schema.js";
import { isPostgresError } from "../database/postgres-error.js";
import { ApplicationError } from "../errors.js";
import type { RequestActor } from "../identity/authorization.js";
import {
  type AuthoritativeGenerationUsage,
  type BudgetService,
  ContextBudgetExceededError,
  createBudgetService,
  EmployeeGenerationLimitError,
  WorkspaceBudgetExceededError,
} from "../model-policy/budget-service.js";
import { unitPricePerMillion } from "../model-policy/money.js";
import {
  createModelPolicyService,
  type ModelPolicyMode,
  type ModelPolicyService,
  ModelPolicyUnavailableError,
  type ResolvedTierPolicy,
} from "../model-policy/service.js";
import type { ApplicationTelemetry } from "../observability/telemetry-contract.js";
import {
  type ContextPlan,
  ContextPlanTooLargeError,
  type PendingContextPlan,
  planContext,
} from "./context-planner.js";
import { type ContextWindow, loadContextWindow } from "./context-service.js";
import type {
  GatewayAccounting,
  GatewayCompletionReason,
  GatewayProviderMetadata,
  GatewayUsage,
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
  employeeGenerationLimit:
    "Ya alcanzaste el límite de respuestas activas. Detén o espera una respuesta antes de continuar.",
  invalidMessage: "El mensaje no es válido para esta conversación.",
  messageTooLarge: "El mensaje supera el tamaño permitido.",
  notFound: "No se encontró la conversación solicitada.",
  tierUnavailable: "Este nivel no está disponible en este momento.",
  workspaceBudget: "El espacio de trabajo alcanzó su presupuesto mensual.",
} as const;

type TerminalStatus = "cancelled" | "completed" | "failed" | "incomplete";

interface SelectedPathMessageRow {
  readonly content: unknown;
  readonly id: string;
  readonly parentMessageId: string | null;
  readonly role: "assistant" | "user";
}

interface PreloadedContextWindow {
  readonly endpointMessageId: string | null;
  readonly maximumSourceBytes: number;
  readonly revision: number;
  readonly window: ContextWindow;
}

interface InsertedResponseMessagesRow extends Record<string, unknown> {
  readonly assistantMessageId: string;
  readonly userMessageId: string;
}

interface CommittedDraftResponseRow extends Record<string, unknown> {
  readonly draftDeleted: boolean;
  readonly revision: number | null;
}

interface AdmissionConversationRow extends Record<string, unknown> {
  readonly activeGeneration: boolean | null;
  readonly archivedAt: Date | null;
  readonly conversationId: string | null;
  readonly draftContent: string | null;
  readonly draftId: string | null;
  readonly draftRevision: number | null;
  readonly idempotencyFound: boolean;
  readonly revision: number | null;
  readonly selectedLeafMessageId: string | null;
  readonly title: string | null;
}

type DatabaseTransaction = Parameters<Parameters<AppDatabase["transaction"]>[0]>[0];

export interface StartedResponse {
  readonly admittedAt: Date;
  readonly compaction?: {
    readonly fastPolicy: ResolvedTierPolicy;
    readonly plan: PendingContextPlan;
    readonly userId: string;
    readonly workspaceId: string;
  };
  readonly contextWarning?: true;
  readonly conversationId: string;
  readonly generationId: string;
  readonly messageId: string;
  readonly request: GenerationRequest;
  readonly revision: number;
  readonly startedAt?: Date;
  readonly userMessageId: string;
}

export interface DurableGenerationState {
  readonly assistantMessageId: string | null;
  readonly conversationId: string | null;
  readonly errorCode: StoredGenerationErrorCode | null;
  readonly reason: "cancelled" | "content_filter" | "error" | "length" | "refusal" | "stop" | null;
  readonly revision: number | null;
  readonly status: "active" | "cancelled" | "completed" | "failed" | "incomplete" | "preparing";
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

function authoritativeUsage(
  usage: GatewayUsage,
  accounting: GatewayAccounting,
): AuthoritativeGenerationUsage {
  return {
    cachedTokens: accounting.cachedTokens,
    completionTokens: usage.outputTokens,
    costUsd: accounting.costUsd,
    openRouterGenerationId: accounting.metadata.providerGenerationId,
    promptTokens: usage.inputTokens,
    provider: accounting.metadata.provider,
    reasoningTokens: accounting.reasoningTokens,
  };
}

function safeProviderMetadataValue(value: string | undefined): string | undefined {
  if (
    value === undefined ||
    value.length === 0 ||
    value.length > 512 ||
    !value.isWellFormed() ||
    hasUnsupportedControlCharacter(value) ||
    value.includes("\t") ||
    value.includes("\n") ||
    !/\S/u.test(value)
  ) {
    return undefined;
  }
  return value;
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

export interface GenerationServiceOptions {
  readonly budget?: BudgetService;
  readonly mode?: ModelPolicyMode;
  readonly modelPolicy?: ModelPolicyService;
  readonly telemetry?:
    | Pick<
        ApplicationTelemetry,
        "recordCancellation" | "recordReservationSettlement" | "recordSettlement"
      >
    | undefined;
}

export function createGenerationService(
  database: AppDatabase,
  options: GenerationServiceOptions = {},
) {
  const budget = options.budget ?? createBudgetService(database);
  const mode = options.mode ?? "simulated";
  const modelPolicy = options.modelPolicy ?? createModelPolicyService(database);
  function observe(action: () => void): void {
    try {
      action();
    } catch {
      // Telemetry cannot affect generation authority or persistence.
    }
  }
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

  async function preloadSelectedContext(
    actor: RequestActor,
    conversationId: string,
    input: CreateResponseRequest,
  ): Promise<PreloadedContextWindow | null> {
    if (input.source !== "draft" && input.source !== "continue") {
      return null;
    }
    const rows = await database
      .select({
        archivedAt: conversations.archivedAt,
        revision: conversations.revision,
        selectedLeafMessageId: conversations.selectedLeafMessageId,
      })
      .from(conversations)
      .where(ownedConversationWhere(actor, conversationId))
      .limit(1);
    const conversation = rows[0];
    if (
      conversation === undefined ||
      conversation.archivedAt !== null ||
      conversation.revision !== input.observedRevision ||
      conversation.selectedLeafMessageId !== input.parentMessageId
    ) {
      return null;
    }

    const policies = await modelPolicy.resolveGenerationPolicies(
      database,
      actor.workspace.id,
      input.modelTier,
      mode,
    );
    const resolvedTier = policies.chat;
    const fastTier = policies.fast;
    const maximumSourceBytes = Math.min(
      generationTuning.maximumContextBytes,
      fastTier?.contextLength ?? resolvedTier.contextLength,
    );
    return Object.freeze({
      endpointMessageId: conversation.selectedLeafMessageId,
      maximumSourceBytes,
      revision: conversation.revision,
      window: await loadContextWindow(
        database,
        conversationId,
        conversation.selectedLeafMessageId,
        maximumSourceBytes,
      ),
    });
  }

  async function startResponse(
    actor: RequestActor,
    conversationId: string,
    idempotencyKey: string,
    input: CreateResponseRequest,
  ): Promise<StartedResponse> {
    const admittedAt = new Date();
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
      // Selected-branch reconstruction is bounded but query-heavy. It is immutable at a matching
      // conversation revision, so prepare it before taking the workspace-wide budget lock and
      // revalidate that revision, endpoint, and policy-derived byte bound inside the transaction.
      const preloadedContext = await preloadSelectedContext(actor, conversationId, input);
      return await database.transaction(async (transaction) => {
        const startedAt = new Date();
        const admission = await budget.lockAdmission(
          transaction,
          actor.workspace.id,
          actor.employee.id,
          startedAt,
        );

        // This keeps idempotency ahead of the active-conversation conflict while spending one
        // serialized round trip under the workspace budget lock. An idempotent retry deliberately
        // skips the conversation lock entirely.
        const admissionRows = await transaction.execute<AdmissionConversationRow>(sql`
          WITH idempotency AS MATERIALIZED (
            SELECT EXISTS (
              SELECT 1
              FROM generations AS existing_generation
              WHERE existing_generation.workspace_id = ${actor.workspace.id}::uuid
                AND existing_generation.user_id = ${actor.employee.id}
                AND existing_generation.idempotency_key = ${idempotencyKey}::uuid
            ) AS found
          ),
          locked_conversation AS MATERIALIZED (
            SELECT
              conversation.id,
              conversation.archived_at,
              conversation.revision,
              conversation.selected_leaf_message_id,
              conversation.title,
              EXISTS (
                SELECT 1
                FROM generations AS active_generation
                WHERE active_generation.conversation_id = conversation.id
                  AND active_generation.status IN ('preparing', 'active')
                  AND (active_generation.purpose IS NULL OR active_generation.purpose = 'chat')
              ) AS active_generation
            FROM conversations AS conversation
            CROSS JOIN idempotency
            WHERE NOT idempotency.found
              AND conversation.id = ${conversationId}::uuid
              AND conversation.workspace_id = ${actor.workspace.id}::uuid
              AND conversation.user_id = ${actor.employee.id}
            LIMIT 1
            FOR UPDATE OF conversation
          ),
          locked_draft AS MATERIALIZED (
            SELECT draft.id, draft.content, draft.revision
            FROM drafts AS draft
            CROSS JOIN locked_conversation
            WHERE ${input.source === "draft"}
              AND draft.workspace_id = ${actor.workspace.id}::uuid
              AND draft.user_id = ${actor.employee.id}
              AND draft.conversation_id = locked_conversation.id
            LIMIT 1
            FOR UPDATE OF draft
          )
          SELECT
            idempotency.found AS "idempotencyFound",
            locked_conversation.id AS "conversationId",
            locked_conversation.archived_at AS "archivedAt",
            locked_conversation.revision,
            locked_conversation.selected_leaf_message_id AS "selectedLeafMessageId",
            locked_conversation.title,
            locked_conversation.active_generation AS "activeGeneration",
            locked_draft.id AS "draftId",
            locked_draft.content AS "draftContent",
            locked_draft.revision AS "draftRevision"
          FROM idempotency
          LEFT JOIN locked_conversation ON true
          LEFT JOIN locked_draft ON true
        `);
        const conversationAdmission = admissionRows.rows[0];
        if (conversationAdmission === undefined) {
          throw new Error("Generation admission returned no row");
        }
        if (conversationAdmission.idempotencyFound) {
          return generationAlreadyExists();
        }
        if (
          conversationAdmission.conversationId === null ||
          conversationAdmission.revision === null
        ) {
          return notFound();
        }
        const conversation = {
          activeGeneration: conversationAdmission.activeGeneration === true,
          archivedAt: conversationAdmission.archivedAt,
          revision: conversationAdmission.revision,
          selectedLeafMessageId: conversationAdmission.selectedLeafMessageId,
          title: conversationAdmission.title,
        };

        if (conversation.activeGeneration) {
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
            if (
              conversationAdmission.draftId === null ||
              conversationAdmission.draftRevision !== draftRevision ||
              conversationAdmission.draftContent !== messageText
            ) {
              return draftChanged();
            }
            consumedDraftId = conversationAdmission.draftId;
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

        const policies = await modelPolicy.resolveGenerationPolicies(
          transaction,
          actor.workspace.id,
          input.modelTier,
          mode,
        );
        const resolvedTier = policies.chat;
        const fastTier = policies.fast;
        const maximumSourceBytes = Math.min(
          generationTuning.maximumContextBytes,
          fastTier?.contextLength ?? resolvedTier.contextLength,
        );
        const window =
          preloadedContext !== null &&
          preloadedContext.revision === conversation.revision &&
          preloadedContext.endpointMessageId === historyEndpointId &&
          preloadedContext.maximumSourceBytes === maximumSourceBytes
            ? preloadedContext.window
            : await loadContextWindow(
                transaction,
                conversationId,
                historyEndpointId,
                maximumSourceBytes,
              );
        let contextPlan: ContextPlan;
        try {
          contextPlan = planContext({
            chatRoute: resolvedTier,
            fastRoute: fastTier,
            latestMessage: messageText,
            modelTier: input.modelTier,
            previousCompaction: window.previousCompaction,
            recentTurns: window.recentTurns,
            sourceOverflow: window.sourceOverflow,
            sourceTurns: window.sourceTurns,
          });
        } catch (error: unknown) {
          if (error instanceof ContextPlanTooLargeError) {
            throw new ApplicationError(413, "MESSAGE_TOO_LARGE", generationCopy.messageTooLarge);
          }
          throw error;
        }
        const estimatedInputTokens =
          contextPlan.mode === "pending"
            ? contextPlan.maximumChatInputTokens
            : contextPlan.estimatedInputTokens;
        const reservation = budget.reserveResolvedTier(
          admission,
          resolvedTier,
          estimatedInputTokens,
          startedAt,
        );

        let assistantMessageId: string | undefined;
        if (insertUserMessage) {
          const inserted = await transaction.execute<InsertedResponseMessagesRow>(sql`
            WITH user_message AS (
              INSERT INTO messages (conversation_id, parent_message_id, role, content)
              VALUES (
                ${conversationId}::uuid,
                ${userParentMessageId}::uuid,
                'user',
                ${JSON.stringify(toStoredContent(messageText))}::jsonb
              )
              RETURNING id
            ),
            assistant_message AS (
              INSERT INTO messages (conversation_id, parent_message_id, role, content)
              SELECT
                ${conversationId}::uuid,
                user_message.id,
                'assistant',
                ${JSON.stringify(toStoredContent(""))}::jsonb
              FROM user_message
              RETURNING id
            )
            SELECT
              user_message.id AS "userMessageId",
              assistant_message.id AS "assistantMessageId"
            FROM user_message
            CROSS JOIN assistant_message
          `);
          const row = inserted.rows[0];
          userMessageId = row?.userMessageId;
          assistantMessageId = row?.assistantMessageId;
        } else if (userMessageId !== undefined) {
          const assistantRows = await transaction
            .insert(messages)
            .values({
              content: toStoredContent(""),
              conversationId,
              parentMessageId: userMessageId,
              role: "assistant",
            })
            .returning({ id: messages.id });
          assistantMessageId = assistantRows[0]?.id;
        }
        if (userMessageId === undefined || assistantMessageId === undefined) {
          throw new Error("Response message insertion returned no row");
        }

        const contextParameters =
          contextPlan.mode === "pending"
            ? {
                mode: "pending",
                promptVersion: contextPlan.compaction.request.systemPrompt.version,
                strategy: contextPlan.strategy,
                throughMessageId: contextPlan.compaction.throughMessageId,
              }
            : contextPlan.mode === "compacted"
              ? { compactionId: contextPlan.compactionId, mode: "compacted" }
              : contextPlan.mode === "fallback"
                ? { mode: "fallback", reason: contextPlan.reason }
                : { mode: "full" };
        const generationRows = await transaction
          .insert(generations)
          .values({
            assistantMessageId,
            conversationId,
            createdAt: startedAt,
            effectiveParameters: {
              context: contextParameters,
              ...(mode === "openrouter"
                ? {
                    maximumOutputTokens: resolvedTier.maximumOutputTokens,
                    priceCeiling: {
                      completionUsdPerMillion: unitPricePerMillion(
                        resolvedTier.completionPriceCeilingPerToken,
                      ),
                      promptUsdPerMillion: unitPricePerMillion(
                        resolvedTier.promptPriceCeilingPerToken,
                      ),
                      requestUsd: resolvedTier.requestPriceCeilingUsd,
                    },
                    provider: {
                      dataCollection: "deny",
                      requireParameters: true,
                      zeroDataRetention: true,
                    },
                    reasoning: { exclude: true },
                  }
                : {}),
            },
            idempotencyKey,
            purpose: "chat",
            requestedTier: input.modelTier,
            ...(mode === "openrouter"
              ? {
                  accountingStatus: reservation.accountingStatus,
                  budgetPeriodEnd: reservation.budgetPeriodEnd,
                  budgetPeriodStart: reservation.budgetPeriodStart,
                  completionPriceCeilingPerToken: reservation.completionPriceCeilingPerToken,
                  estimatedInputTokens: reservation.estimatedInputTokens,
                  maximumOutputTokens: reservation.maximumOutputTokens,
                  requestPriceCeilingUsd: reservation.requestPriceCeilingUsd,
                  requestedModel: resolvedTier.resolvedModel,
                  reservationExpiresAt: reservation.reservationExpiresAt,
                  reservationMarginBasisPoints: reservation.reservationMarginBasisPoints,
                  reservedCostUsd: reservation.reservedCostUsd,
                  resolvedModel: resolvedTier.resolvedModel,
                  promptPriceCeilingPerToken: reservation.promptPriceCeilingPerToken,
                }
              : {}),
            startedAt,
            status: contextPlan.mode === "pending" ? "preparing" : "active",
            systemPromptVersion: systemPrompt.version,
            userId: actor.employee.id,
            updatedAt: startedAt,
            workspaceId: actor.workspace.id,
          })
          .returning();
        const generation = generationRows[0];
        if (generation === undefined) {
          throw new Error("Generation insertion returned no row");
        }

        const now = new Date();
        let updatedRevision: number | undefined;
        if (consumedDraftId !== undefined) {
          const committed = await transaction.execute<CommittedDraftResponseRow>(sql`
            WITH updated_conversation AS (
              UPDATE conversations AS conversation
              SET
                revision = ${conversation.revision + 1},
                selected_leaf_message_id = ${assistantMessageId}::uuid,
                preferred_tier = ${input.modelTier},
                title = ${conversation.title ?? createInitialTitle(messageText)},
                updated_at = ${now}
              WHERE conversation.id = ${conversationId}::uuid
                AND conversation.workspace_id = ${actor.workspace.id}::uuid
                AND conversation.user_id = ${actor.employee.id}
                AND conversation.revision = ${input.observedRevision}
              RETURNING revision
            ),
            deleted_draft AS (
              DELETE FROM drafts AS draft
              WHERE draft.id = ${consumedDraftId}::uuid
                AND draft.revision = ${draftRevision ?? -1}
              RETURNING id
            )
            SELECT
              (SELECT revision FROM updated_conversation) AS revision,
              EXISTS (SELECT 1 FROM deleted_draft) AS "draftDeleted"
          `);
          const row = committed.rows[0];
          if (row?.revision === null || row?.revision === undefined) {
            return changed();
          }
          if (!row.draftDeleted) {
            return draftChanged();
          }
          updatedRevision = row.revision;
        } else {
          const updatedRows = await transaction
            .update(conversations)
            .set({
              revision: conversation.revision + 1,
              selectedLeafMessageId: assistantMessageId,
              preferredTier: input.modelTier,
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
          updatedRevision = updatedRows[0]?.revision;
          if (updatedRevision === undefined) {
            return changed();
          }
        }

        const plannedChatRequest =
          contextPlan.mode === "pending" ? contextPlan.fallback.request : contextPlan.request;
        return {
          admittedAt,
          ...(contextPlan.mode === "pending" && fastTier !== null
            ? {
                compaction: {
                  fastPolicy: fastTier,
                  plan: contextPlan,
                  userId: actor.employee.id,
                  workspaceId: actor.workspace.id,
                },
              }
            : {}),
          ...(contextPlan.mode === "fallback" ? { contextWarning: true as const } : {}),
          conversationId,
          generationId: generation.id,
          messageId: assistantMessageId,
          request: {
            ...plannedChatRequest,
            ...(mode === "openrouter"
              ? {
                  route: {
                    completionPriceCeilingUsdPerToken: resolvedTier.completionPriceCeilingPerToken,
                    maximumOutputTokens: resolvedTier.maximumOutputTokens,
                    promptPriceCeilingUsdPerToken: resolvedTier.promptPriceCeilingPerToken,
                    requestPriceCeilingUsd: resolvedTier.requestPriceCeilingUsd,
                    requestedModel: resolvedTier.resolvedModel,
                  },
                }
              : {}),
            systemPrompt,
          },
          revision: updatedRevision,
          startedAt,
          userMessageId,
        };
      });
    } catch (error: unknown) {
      if (isPostgresError(error, "23505", "generations_scoped_idempotency_unique")) {
        return generationAlreadyExists();
      }
      if (isPostgresError(error, "23505", "generations_active_conversation_unique")) {
        return generationActive();
      }
      if (isPostgresError(error, "23505", "generations_chat_workflow_conversation_unique")) {
        return generationActive();
      }
      if (error instanceof ModelPolicyUnavailableError) {
        throw new ApplicationError(409, "TIER_UNAVAILABLE", generationCopy.tierUnavailable);
      }
      if (error instanceof EmployeeGenerationLimitError) {
        throw new ApplicationError(
          409,
          "EMPLOYEE_GENERATION_LIMIT_REACHED",
          generationCopy.employeeGenerationLimit,
        );
      }
      if (error instanceof WorkspaceBudgetExceededError) {
        throw new ApplicationError(
          409,
          "WORKSPACE_BUDGET_EXCEEDED",
          generationCopy.workspaceBudget,
        );
      }
      if (error instanceof ContextBudgetExceededError) {
        throw new ApplicationError(413, "MESSAGE_TOO_LARGE", generationCopy.messageTooLarge);
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

  async function recordProviderMetadata(
    generationId: string,
    metadata: GatewayProviderMetadata,
  ): Promise<boolean> {
    const openRouterGenerationId = safeProviderMetadataValue(metadata.providerGenerationId);
    const provider = safeProviderMetadataValue(metadata.provider);
    const resolvedModel = safeProviderMetadataValue(metadata.resolvedModel);
    if (
      openRouterGenerationId === undefined &&
      provider === undefined &&
      resolvedModel === undefined
    ) {
      return false;
    }
    const updated = await database
      .update(generations)
      .set({
        ...(openRouterGenerationId === undefined ? {} : { openRouterGenerationId }),
        ...(provider === undefined ? {} : { provider }),
        ...(resolvedModel === undefined ? {} : { resolvedModel }),
        updatedAt: sql`GREATEST(${generations.updatedAt}, CURRENT_TIMESTAMP)`,
      })
      .where(and(eq(generations.id, generationId), eq(generations.accountingStatus, "reserved")))
      .returning({ id: generations.id });
    return updated.length === 1;
  }

  async function settleAccounting(
    generationId: string,
    usage: GatewayUsage,
    accounting: GatewayAccounting,
  ): Promise<boolean> {
    return budget.settleAuthoritativeUsage(generationId, authoritativeUsage(usage, accounting));
  }

  async function settleDeterministicZero(generationId: string): Promise<boolean> {
    return budget.settleDeterministicZero(generationId);
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
      readonly accounting?: {
        readonly metadata: GatewayAccounting;
        readonly usage: GatewayUsage;
      };
      readonly content: string;
      readonly errorCode: StoredGenerationErrorCode | null;
      readonly firstTokenAt: Date | null;
      readonly reason: "cancelled" | GatewayCompletionReason | "error";
      readonly settleDeterministicZero?: boolean;
      readonly status: TerminalStatus;
    },
  ): Promise<TerminalGenerationResult> {
    const settlementStartedAt = performance.now();
    const locationRows = await database
      .select({
        conversationId: generations.conversationId,
        purpose: generations.purpose,
        requestedTier: generations.requestedTier,
      })
      .from(generations)
      .where(eq(generations.id, generationId))
      .limit(1);
    const location = locationRows[0];
    if (location === undefined) {
      throw new Error("Generation disappeared during terminalization");
    }

    let settledReservation = false;
    const result = await database.transaction(async (transaction) => {
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
      if (
        input.status === "completed" &&
        generation.accountingStatus === "reserved" &&
        input.accounting === undefined
      ) {
        throw new Error("Billable completion is missing authoritative accounting");
      }
      if (input.accounting !== undefined) {
        const resolvedModel = safeProviderMetadataValue(
          input.accounting.metadata.metadata.resolvedModel,
        );
        if (resolvedModel !== undefined) {
          await transaction
            .update(generations)
            .set({ resolvedModel })
            .where(eq(generations.id, generationId));
        }
        const settled = await budget.settleAuthoritativeUsageInTransaction(
          transaction,
          generationId,
          authoritativeUsage(input.accounting.usage, input.accounting.metadata),
          now,
        );
        if (generation.accountingStatus === "reserved" && !settled) {
          throw new Error("Authoritative generation accounting could not be settled");
        }
        settledReservation = generation.accountingStatus === "reserved" && settled;
      } else if (input.settleDeterministicZero && generation.accountingStatus === "reserved") {
        const settled = await budget.settleAuthoritativeUsageInTransaction(
          transaction,
          generationId,
          { completionTokens: 0, costUsd: "0", promptTokens: 0 },
          now,
        );
        if (!settled) {
          throw new Error("Deterministic zero-cost accounting could not be settled");
        }
        settledReservation = true;
      }
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
    if (
      result.won &&
      (location.requestedTier === "fast" ||
        location.requestedTier === "balanced" ||
        location.requestedTier === "pro")
    ) {
      const purpose = location.purpose === "compaction" ? "compaction" : "chat";
      observe(() =>
        options.telemetry?.recordSettlement(
          location.requestedTier as GenerationModelTier,
          purpose,
          input.status,
          performance.now() - settlementStartedAt,
        ),
      );
    }
    if (result.won && settledReservation) {
      observe(() => options.telemetry?.recordReservationSettlement("actual"));
    }
    return result;
  }

  async function cancel(
    actor: RequestActor,
    conversationId: string,
    generationId: string,
    captureLocalPartial?: () => LocalCancellationPartial | undefined,
  ): Promise<boolean> {
    const cancellationStartedAt = performance.now();
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

    let cancelledTier: GenerationModelTier | undefined;
    let releasedReservation = false;
    const cancelled = await database.transaction(async (transaction) => {
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
      if (generation.status !== "active" && generation.status !== "preparing") {
        return false;
      }
      const localPartial = captureLocalPartial?.();
      if (localPartial !== undefined && generation.status === "active") {
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
      if (generation.status === "preparing" && generation.accountingStatus === "reserved") {
        const settled = await budget.settleAuthoritativeUsageInTransaction(
          transaction,
          generationId,
          { completionTokens: 0, costUsd: "0", promptTokens: 0 },
          now,
        );
        if (!settled) {
          throw new Error("Preparing chat accounting could not be released during cancellation");
        }
        releasedReservation = true;
      }
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
        .where(
          and(
            eq(generations.id, generationId),
            inArray(generations.status, ["preparing", "active"]),
          ),
        );
      await transaction
        .update(conversations)
        .set({ revision: conversation.revision + 1, updatedAt: now })
        .where(eq(conversations.id, conversationId));
      if (
        generation.requestedTier === "fast" ||
        generation.requestedTier === "balanced" ||
        generation.requestedTier === "pro"
      ) {
        cancelledTier = generation.requestedTier;
      }
      return true;
    });
    if (cancelled && cancelledTier !== undefined) {
      observe(() =>
        options.telemetry?.recordCancellation(
          cancelledTier as GenerationModelTier,
          "chat",
          "cancelled",
          performance.now() - cancellationStartedAt,
        ),
      );
      if (releasedReservation) {
        observe(() => options.telemetry?.recordReservationSettlement("actual"));
      }
    }
    return cancelled;
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
                    status: row.status === "preparing" ? "active" : row.status,
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
    let settledReservations = 0;
    const activeGenerationId = await database.transaction(async (transaction) => {
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
          accountingStatus: generations.accountingStatus,
          purpose: generations.purpose,
          startedAt: generations.startedAt,
          status: generations.status,
          updatedAt: generations.updatedAt,
        })
        .from(generations)
        .where(
          and(
            eq(generations.conversationId, conversationId),
            inArray(generations.status, ["preparing", "active"]),
          ),
        )
        .for("update");
      const activeGenerationId =
        activeRows.find(({ purpose }) => purpose === null || purpose === "chat")?.id ?? null;
      for (const activeGeneration of activeRows) {
        const now = atOrAfter(
          new Date(),
          activeGeneration.startedAt,
          activeGeneration.firstTokenAt,
          activeGeneration.createdAt,
          activeGeneration.updatedAt,
        );
        if (
          activeGeneration.status === "preparing" &&
          activeGeneration.accountingStatus === "reserved"
        ) {
          const settled = await budget.settleAuthoritativeUsageInTransaction(
            transaction,
            activeGeneration.id,
            { completionTokens: 0, costUsd: "0", promptTokens: 0 },
            now,
          );
          settledReservations += settled ? 1 : 0;
        }
        await transaction
          .update(generations)
          .set({
            completedAt: now,
            errorCode: null,
            status: "cancelled",
            terminalReason: "cancelled",
            updatedAt: now,
          })
          .where(
            and(
              eq(generations.id, activeGeneration.id),
              inArray(generations.status, ["preparing", "active"]),
            ),
          );
        if (activeGeneration.purpose === "compaction") {
          await transaction
            .update(conversationCompactions)
            .set({ completedAt: now, status: "cancelled", updatedAt: now })
            .where(
              and(
                eq(conversationCompactions.generationId, activeGeneration.id),
                eq(conversationCompactions.status, "active"),
              ),
            );
        }
      }
      await transaction
        .update(generations)
        .set({ conversationId: null })
        .where(
          and(
            eq(generations.conversationId, conversationId),
            eq(generations.purpose, "compaction"),
          ),
        );
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
    for (let index = 0; index < settledReservations; index += 1) {
      observe(() => options.telemetry?.recordReservationSettlement("actual"));
    }
    return activeGenerationId;
  }

  return Object.freeze({
    cancel,
    checkpoint,
    readState,
    recordProviderMetadata,
    removeConversation,
    responseStates,
    settleAccounting,
    settleDeterministicZero,
    startResponse,
    terminalize,
  });
}

export type GenerationService = ReturnType<typeof createGenerationService>;

import type {
  CreateResponseRequest,
  GenerationModelTier,
  ResponseState,
  ResponseStateResponse,
  StoredGenerationErrorCode,
} from "@capstone/protocol";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  createInitialTitle,
  hasUnsupportedControlCharacter,
  normalizeStoredText,
  parseMessageContent,
} from "../conversations/content.js";
import { conversations, messages } from "../database/conversation-schema.js";
import { type AppDatabase, executePrepared } from "../database/database.js";
import {
  type GenerationLifecycleStatus,
  generations,
  isNonterminalGenerationStatus,
  nonterminalGenerationStatuses,
} from "../database/generation-schema.js";
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
  lockConversationAdmission,
  lockDraftGenerationAdmission,
  lockSessionAdmission,
} from "./admission.js";
import {
  type ContextPlan,
  ContextPlanTooLargeError,
  type PendingContextPlan,
  planContext,
} from "./context-planner.js";
import { preloadDraftContext } from "./context-preload.js";
import { boundContextWindow, type ContextWindow, loadContextWindow } from "./context-service.js";
import { settleNonterminalGeneration } from "./lifecycle.js";
import type {
  GatewayAccounting,
  GatewayCompletionReason,
  GatewayProviderMetadata,
  GatewayUsage,
  GenerationRequest,
} from "./model-gateway.js";
import { continueMessage, systemPrompt } from "./prompt.js";
import { generationTuning } from "./settings.js";
import { createTitleService, type NamingHandoff, type TitleService } from "./title-service.js";

const generationCopy = {
  active: "Esta conversación ya tiene una respuesta en curso.",
  alreadyExists: "Esta solicitud de respuesta ya fue utilizada.",
  archived: "Desarchiva la conversación antes de generar una respuesta.",
  authenticationRequired: "Inicia sesión para continuar.",
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

interface InsertedResponseWorkflowRow extends Record<string, unknown> {
  readonly assistantMessageId: string | null;
  readonly draftDeleted: boolean;
  readonly generationId: string | null;
  readonly revision: number | null;
  readonly userMessageId: string | null;
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
  readonly status: GenerationLifecycleStatus;
}

export interface TerminalGenerationResult extends DurableGenerationState {
  /** Present when a completed initial answer handed off to the naming phase. */
  readonly naming?: NamingHandoff;
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
  readonly titles?: TitleService;
}

export function createGenerationService(
  database: AppDatabase,
  options: GenerationServiceOptions = {},
) {
  const budget = options.budget ?? createBudgetService(database);
  const mode = options.mode ?? "simulated";
  const modelPolicy = options.modelPolicy ?? createModelPolicyService(database);
  const titles =
    options.titles ??
    createTitleService({ budget, database, mode, modelPolicy, telemetry: options.telemetry });
  function observe(action: () => void): void {
    try {
      action();
    } catch {
      // Telemetry cannot affect generation authority or persistence.
    }
  }

  async function attemptOptionalNaming<TResult>(
    transaction: DatabaseTransaction,
    action: (savepoint: DatabaseTransaction) => Promise<TResult>,
  ): Promise<TResult | null> {
    try {
      return await transaction.transaction((savepoint) => action(savepoint));
    } catch (error: unknown) {
      // A savepoint makes policy, lock-timeout, and handoff failures title-local. Prove the outer
      // transaction is still usable before allowing the authoritative chat completion to proceed.
      try {
        await transaction.execute(sql`SELECT 1`);
      } catch {
        throw error;
      }
      return null;
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
    if (input.source === "draft") {
      return preloadDraftContext(database, modelPolicy, {
        conversationId,
        mode,
        observedRevision: input.observedRevision,
        parentMessageId: input.parentMessageId,
        tier: input.modelTier,
        userId: actor.employee.id,
        workspaceId: actor.workspace.id,
      });
    }
    if (input.source !== "continue") {
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
      // Selected-branch reconstruction is immutable at a matching conversation revision. Prepare
      // its bounded window before the workspace-wide budget lock, then revalidate revision,
      // endpoint, and the fresh policy-derived byte bound inside the transaction.
      const preloadedContext = await preloadSelectedContext(actor, conversationId, input);
      return await database.transaction(async (transaction) => {
        const startedAt = new Date();
        const sessionCurrent = await lockSessionAdmission(
          transaction,
          actor.session.id,
          actor.employee.id,
          startedAt,
        );
        if (!sessionCurrent) {
          throw new ApplicationError(
            401,
            "AUTHENTICATION_REQUIRED",
            generationCopy.authenticationRequired,
          );
        }
        await budget.lockAdmissionAuthority(transaction, actor.workspace.id, actor.employee.id);

        // The ordinary draft path uses one fresh post-authority snapshot. Other sources keep their
        // recursive validation ahead of policy locking so invalid requests retain error precedence.
        const pendingDraftAdmission =
          input.source === "draft"
            ? await lockDraftGenerationAdmission(
                transaction,
                {
                  at: startedAt,
                  conversationId,
                  draftContent: submittedMessageText ?? "",
                  draftRevision: input.draftRevision,
                  idempotencyKey,
                  mode,
                  observedRevision: input.observedRevision,
                  parentMessageId: input.parentMessageId,
                  tier: input.modelTier,
                  userId: actor.employee.id,
                  workspaceId: actor.workspace.id,
                },
                modelPolicy,
              )
            : null;
        const conversationAdmission =
          pendingDraftAdmission?.conversation ??
          (await lockConversationAdmission(transaction, {
            conversationId,
            idempotencyKey,
            userId: actor.employee.id,
            workspaceId: actor.workspace.id,
          }));
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
            if (
              conversation.selectedLeafMessageId === null &&
              conversationAdmission.hasMessages === true
            ) {
              throw new Error("Empty conversation has stored messages");
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

        const { admission, policies } =
          pendingDraftAdmission?.resolve() ??
          (await modelPolicy.resolveGenerationAdmission(
            transaction,
            actor.workspace.id,
            actor.employee.id,
            startedAt,
            input.modelTier,
            mode,
          ));
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
          preloadedContext.maximumSourceBytes >= maximumSourceBytes
            ? boundContextWindow(preloadedContext.window, maximumSourceBytes)
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
          { enforceEmployeeLimit: true, purpose: "chat" },
        );

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
        const effectiveParameters = {
          context: contextParameters,
          ...(mode === "openrouter"
            ? {
                maximumOutputTokens: resolvedTier.maximumOutputTokens,
                priceCeiling: {
                  completionUsdPerMillion: unitPricePerMillion(
                    resolvedTier.completionPriceCeilingPerToken,
                  ),
                  promptUsdPerMillion: unitPricePerMillion(resolvedTier.promptPriceCeilingPerToken),
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
        };
        const generationStatus = contextPlan.mode === "pending" ? "preparing" : "active";
        const realReservation = mode === "openrouter" ? reservation : null;

        let assistantMessageId: string | undefined;
        let generationId: string | undefined;
        let updatedRevision: number | undefined;
        if (insertUserMessage) {
          const committedAt = new Date();
          const nextTitle =
            input.source === "edit"
              ? conversation.title
              : (conversation.title ?? createInitialTitle(messageText));
          // The ordinary path commits its immutable messages, reservation, selection, and draft
          // consumption as one guarded statement while the workspace budget lock is held.
          const inserted = await executePrepared<InsertedResponseWorkflowRow>(
            transaction,
            "generation-response-workflow-v1",
            sql`
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
            ),
            inserted_generation AS (
              INSERT INTO generations (
                workspace_id,
                user_id,
                conversation_id,
                assistant_message_id,
                idempotency_key,
                requested_tier,
                purpose,
                requested_model,
                resolved_model,
                system_prompt_version,
                effective_parameters,
                status,
                accounting_status,
                estimated_input_tokens,
                maximum_output_tokens,
                reserved_cost_usd,
                prompt_price_ceiling_per_token,
                completion_price_ceiling_per_token,
                request_price_ceiling_usd,
                reservation_margin_basis_points,
                budget_period_start,
                budget_period_end,
                reservation_expires_at,
                started_at,
                created_at,
                updated_at
              )
              SELECT
                ${actor.workspace.id}::uuid,
                ${actor.employee.id},
                ${conversationId}::uuid,
                assistant_message.id,
                ${idempotencyKey}::uuid,
                ${input.modelTier},
                'chat',
                ${mode === "openrouter" ? resolvedTier.resolvedModel : null},
                ${mode === "openrouter" ? resolvedTier.resolvedModel : null},
                ${systemPrompt.version},
                ${JSON.stringify(effectiveParameters)}::jsonb,
                ${generationStatus},
                ${realReservation?.accountingStatus ?? null},
                ${realReservation?.estimatedInputTokens ?? null},
                ${realReservation?.maximumOutputTokens ?? null},
                ${realReservation?.reservedCostUsd ?? null},
                ${realReservation?.promptPriceCeilingPerToken ?? null},
                ${realReservation?.completionPriceCeilingPerToken ?? null},
                ${realReservation?.requestPriceCeilingUsd ?? null},
                ${realReservation?.reservationMarginBasisPoints ?? null},
                ${realReservation?.budgetPeriodStart ?? null},
                ${realReservation?.budgetPeriodEnd ?? null},
                ${realReservation?.reservationExpiresAt ?? null},
                ${startedAt},
                ${startedAt},
                ${startedAt}
              FROM assistant_message
              RETURNING id
            ),
            updated_conversation AS (
              UPDATE conversations AS conversation
              SET
                revision = ${conversation.revision + 1},
                selected_leaf_message_id = assistant_message.id,
                preferred_tier = ${input.modelTier},
                title = ${nextTitle},
                updated_at = ${committedAt}
              FROM assistant_message
              WHERE conversation.id = ${conversationId}::uuid
                AND conversation.workspace_id = ${actor.workspace.id}::uuid
                AND conversation.user_id = ${actor.employee.id}
                AND conversation.revision = ${input.observedRevision}
              RETURNING conversation.revision
            ),
            deleted_draft AS (
              DELETE FROM drafts AS draft
              USING updated_conversation
              WHERE draft.id = ${consumedDraftId ?? null}::uuid
                AND draft.revision = ${draftRevision ?? -1}
              RETURNING draft.id
            )
            SELECT
              ${consumedDraftId === undefined}
                OR EXISTS (SELECT 1 FROM deleted_draft) AS "draftDeleted",
              (SELECT id FROM user_message) AS "userMessageId",
              (SELECT id FROM assistant_message) AS "assistantMessageId",
              (SELECT id FROM inserted_generation) AS "generationId",
              (SELECT revision FROM updated_conversation) AS revision
            `,
          );
          const row = inserted.rows[0];
          if (row === undefined || row.revision === null) {
            return changed();
          }
          if (!row.draftDeleted) {
            return draftChanged();
          }
          userMessageId = row.userMessageId ?? undefined;
          assistantMessageId = row.assistantMessageId ?? undefined;
          generationId = row.generationId ?? undefined;
          updatedRevision = row.revision;
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
          if (assistantMessageId !== undefined) {
            const generationRows = await transaction
              .insert(generations)
              .values({
                assistantMessageId,
                conversationId,
                createdAt: startedAt,
                effectiveParameters,
                idempotencyKey,
                purpose: "chat",
                requestedTier: input.modelTier,
                ...(realReservation === null
                  ? {}
                  : {
                      accountingStatus: realReservation.accountingStatus,
                      budgetPeriodEnd: realReservation.budgetPeriodEnd,
                      budgetPeriodStart: realReservation.budgetPeriodStart,
                      completionPriceCeilingPerToken:
                        realReservation.completionPriceCeilingPerToken,
                      estimatedInputTokens: realReservation.estimatedInputTokens,
                      maximumOutputTokens: realReservation.maximumOutputTokens,
                      promptPriceCeilingPerToken: realReservation.promptPriceCeilingPerToken,
                      requestPriceCeilingUsd: realReservation.requestPriceCeilingUsd,
                      requestedModel: resolvedTier.resolvedModel,
                      reservationExpiresAt: realReservation.reservationExpiresAt,
                      reservationMarginBasisPoints: realReservation.reservationMarginBasisPoints,
                      reservedCostUsd: realReservation.reservedCostUsd,
                      resolvedModel: resolvedTier.resolvedModel,
                    }),
                startedAt,
                status: generationStatus,
                systemPromptVersion: systemPrompt.version,
                userId: actor.employee.id,
                updatedAt: startedAt,
                workspaceId: actor.workspace.id,
              })
              .returning({ id: generations.id });
            generationId = generationRows[0]?.id;
          }
        }
        if (
          userMessageId === undefined ||
          assistantMessageId === undefined ||
          generationId === undefined
        ) {
          throw new Error("Response workflow insertion returned no row");
        }

        if (updatedRevision === undefined) {
          const now = new Date();
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
          generationId,
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
        userId: generations.userId,
        workspaceId: generations.workspaceId,
      })
      .from(generations)
      .where(eq(generations.id, generationId))
      .limit(1);
    const location = locationRows[0];
    if (location === undefined) {
      throw new Error("Generation disappeared during terminalization");
    }
    // A completed initial answer may hand off to naming, which reserves Fast budget. That path
    // must take the workspace admission lock before the conversation row to keep the established
    // workspace → conversation order, so candidacy is read ahead of the transaction.
    const initialTitleCandidate = await titles.isTitleCandidate(database, generationId);
    const namingCandidate =
      input.status === "completed" &&
      (input.reason === "stop" || input.reason === "length") &&
      usefulText(input.content) &&
      initialTitleCandidate;

    let settledReservation = false;
    const result = await database.transaction(async (transaction) => {
      const namingAuthority =
        namingCandidate &&
        (await attemptOptionalNaming(transaction, async (savepoint) => {
          await budget.lockAdmissionAuthority(savepoint, location.workspaceId, location.userId);
          return true;
        })) === true;
      const conversationRows =
        location.conversationId === null
          ? []
          : await transaction
              .select({
                automaticTitlePending: conversations.automaticTitlePending,
                revision: conversations.revision,
              })
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
      let naming: NamingHandoff | null = null;
      if (namingAuthority && conversation.automaticTitlePending) {
        const conversationId = generation.conversationId;
        naming = await attemptOptionalNaming(transaction, async (savepoint) => {
          if (!(await titles.isTitleCandidate(savepoint, generationId))) {
            return null;
          }
          const promptRows = await savepoint.execute<{ readonly text: string }>(sql`
            SELECT prompt.content->0->>'text' AS "text"
            FROM messages AS answer
            INNER JOIN messages AS prompt ON prompt.id = answer.parent_message_id
              AND prompt.conversation_id = answer.conversation_id
            WHERE answer.id = ${generation.assistantMessageId}::uuid
              AND answer.conversation_id = ${generation.conversationId}::uuid
            LIMIT 1
          `);
          const promptText = promptRows.rows[0]?.text;
          if (promptText === undefined || !usefulText(promptText)) {
            return null;
          }
          // The parent leaves `active` before the title child is inserted so the one-active-row
          // index holds; a declined handoff falls through to the ordinary terminal update.
          await savepoint
            .update(generations)
            .set({
              completedAt: now,
              errorCode: null,
              firstTokenAt,
              status: "finalizing",
              terminalReason: input.reason,
              updatedAt: now,
            })
            .where(and(eq(generations.id, generationId), eq(generations.status, "active")));
          return titles.beginNaming(savepoint, {
            answer: messageContent,
            completedAt: now,
            conversationId,
            prompt: promptText,
            userId: location.userId,
            workspaceId: location.workspaceId,
          });
        });
      }
      if (naming !== null) {
        // Naming handoff: the answer, its accounting, reason, and completion time are durable;
        // the parent stays nonterminal as `finalizing` and the revision moves exactly once when
        // naming settles.
        return {
          assistantMessageId: generation.assistantMessageId,
          conversationId: generation.conversationId,
          errorCode: null,
          naming,
          reason: input.reason,
          revision: conversation.revision,
          status: "finalizing" as const,
          won: true,
        };
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
        .where(
          and(
            eq(generations.id, generationId),
            inArray(generations.status, ["active", "finalizing"]),
          ),
        );
      const updatedConversations = await transaction
        .update(conversations)
        .set({
          // The initial answer's one naming opportunity is consumed by any terminal outcome.
          ...(initialTitleCandidate ? { automaticTitlePending: false } : {}),
          revision: conversation.revision + 1,
          updatedAt: now,
        })
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
    const namingCandidate = await titles.isTitleCandidate(database, generationId);
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
      if (!isNonterminalGenerationStatus(generation.status)) {
        return false;
      }
      if (generation.status === "finalizing") {
        // Stop during naming stops only the naming: the title child is cancelled and the already
        // finished answer completes without a title change.
        const titleRows = await transaction
          .select({
            accountingStatus: generations.accountingStatus,
            createdAt: generations.createdAt,
            firstTokenAt: generations.firstTokenAt,
            id: generations.id,
            purpose: generations.purpose,
            startedAt: generations.startedAt,
            status: generations.status,
            updatedAt: generations.updatedAt,
          })
          .from(generations)
          .where(
            and(
              eq(generations.conversationId, conversationId),
              eq(generations.purpose, "title"),
              eq(generations.status, "active"),
            ),
          )
          .limit(1)
          .for("update");
        const stoppedAt = new Date();
        const titleRow = titleRows[0];
        if (titleRow !== undefined) {
          await settleNonterminalGeneration(transaction, budget, titleRow, stoppedAt);
        }
        await settleNonterminalGeneration(transaction, budget, generation, stoppedAt);
        const nextRevision = conversation.revision + 1;
        await transaction
          .update(conversations)
          .set({
            automaticTitlePending: false,
            automaticTitleSettledRevision: nextRevision,
            revision: nextRevision,
            updatedAt: atOrAfter(stoppedAt, generation.updatedAt),
          })
          .where(eq(conversations.id, conversationId));
        if (
          generation.requestedTier === "fast" ||
          generation.requestedTier === "balanced" ||
          generation.requestedTier === "pro"
        ) {
          cancelledTier = generation.requestedTier;
        }
        return true;
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
        .set({
          ...(namingCandidate ? { automaticTitlePending: false } : {}),
          revision: conversation.revision + 1,
          updatedAt: now,
        })
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
                  // A finalizing parent already stores its chat reason, but the public active
                  // state carries no reason or error until the response completes.
                  (isNonterminalGenerationStatus(row.status)
                    ? {
                        errorCode: null,
                        generationId: row.generationId,
                        messageId: row.messageId,
                        reason: null,
                        status: "active",
                      }
                    : {
                        errorCode: row.errorCode,
                        generationId: row.generationId,
                        messageId: row.messageId,
                        reason: row.reason,
                        status: row.status,
                      }) as ResponseState,
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
            inArray(generations.status, [...nonterminalGenerationStatuses]),
          ),
        )
        .orderBy(
          sql`CASE
            WHEN ${generations.assistantMessageId} IS NOT NULL
              AND (${generations.purpose} IS NULL OR ${generations.purpose} = 'chat') THEN 0
            ELSE 1
          END`,
          asc(generations.id),
        )
        .for("update");
      // Deletion aborts the whole workflow: the local stream is fenced through the parent chat
      // even while it is finalizing its title.
      const activeGenerationId =
        activeRows.find(({ purpose }) => purpose === null || purpose === "chat")?.id ?? null;
      const deletedAt = new Date();
      for (const activeGeneration of activeRows) {
        const settled = await settleNonterminalGeneration(
          transaction,
          budget,
          activeGeneration,
          deletedAt,
        );
        settledReservations += settled.releasedReservation ? 1 : 0;
      }
      await transaction
        .update(generations)
        .set({ conversationId: null })
        .where(
          and(
            eq(generations.conversationId, conversationId),
            inArray(generations.purpose, ["compaction", "title"]),
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
    finalizeNaming: titles.finalizeNaming,
    readState,
    reconcileStaleNaming: titles.reconcileStaleNaming,
    recordProviderMetadata,
    recordTitleObservation: titles.recordTitleObservation,
    removeConversation,
    responseStates,
    settleAccounting,
    settleDeterministicZero,
    settleLateTitleAccounting: titles.settleLateTitleAccounting,
    startResponse,
    terminalize,
  });
}

export type GenerationService = ReturnType<typeof createGenerationService>;

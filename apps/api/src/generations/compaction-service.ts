import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { hasUnsupportedControlCharacter } from "../conversations/content.js";
import { conversationCompactions } from "../database/compaction-schema.js";
import { conversations } from "../database/conversation-schema.js";
import type { AppDatabase } from "../database/database.js";
import { generations } from "../database/generation-schema.js";
import {
  type AuthoritativeGenerationUsage,
  type BudgetService,
  ContextBudgetExceededError,
  WorkspaceBudgetExceededError,
} from "../model-policy/budget-service.js";
import { unitPricePerMillion } from "../model-policy/money.js";
import type { ModelPolicyMode, ResolvedTierPolicy } from "../model-policy/service.js";
import {
  contextCompactionTuning,
  materializeCompactedChat,
  type PendingContextPlan,
  type PlannedChatContext,
} from "./context-planner.js";
import type {
  GatewayAccounting,
  GatewayCompletionReason,
  GatewayEvent,
  GatewayProviderMetadata,
  GatewayUsage,
  GenerationAccountingGateway,
  GenerationRequest,
  ModelGateway,
} from "./model-gateway.js";

export type CompactionExecutionResult =
  | { readonly chat: PlannedChatContext; readonly kind: "compacted" }
  | { readonly chat: PlannedChatContext; readonly kind: "fallback" }
  | { readonly kind: "cancelled" };

export interface CompactionExecutionInput {
  readonly chatGenerationId: string;
  readonly conversationId: string;
  readonly fastPolicy: ResolvedTierPolicy;
  readonly plan: PendingContextPlan;
  readonly userId: string;
  readonly workspaceId: string;
}

interface StartedCompaction {
  readonly generationId: string;
  readonly request: GenerationRequest;
}

interface TerminalCompactionInput {
  readonly accounting?: GatewayAccounting;
  readonly content: string;
  readonly errorCode:
    | "EMPTY_RESPONSE"
    | "GENERATION_FAILED"
    | "GENERATION_TIMEOUT"
    | "MODEL_UNAVAILABLE"
    | null;
  readonly firstTokenAt: Date | null;
  readonly reason: "cancelled" | GatewayCompletionReason | "error";
  readonly settleDeterministicZero?: boolean;
  readonly status: "cancelled" | "completed" | "failed" | "incomplete";
  readonly usage?: GatewayUsage;
}

interface TerminalAccounting {
  readonly accounting: GatewayAccounting;
  readonly usage: GatewayUsage;
}

interface TerminalizationResult {
  readonly reusable: boolean;
  readonly won: boolean;
}

function usefulText(value: string): boolean {
  return /\S/u.test(value);
}

function safeMetadataValue(value: string | undefined): string | undefined {
  if (
    value === undefined ||
    value.length === 0 ||
    value.length > 512 ||
    !value.isWellFormed() ||
    hasUnsupportedControlCharacter(value) ||
    value.includes("\t") ||
    value.includes("\n") ||
    !usefulText(value)
  ) {
    return undefined;
  }
  return value;
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

function validUsage(usage: GatewayUsage): boolean {
  return (
    Number.isSafeInteger(usage.inputTokens) &&
    usage.inputTokens >= 0 &&
    Number.isSafeInteger(usage.outputTokens) &&
    usage.outputTokens >= 0
  );
}

function normalizeTerminalAccounting(
  usage: GatewayUsage,
  accounting: GatewayAccounting,
  requireProviderIdentity: boolean,
): TerminalAccounting | null {
  if (!validUsage(usage)) {
    return null;
  }
  const provider = safeMetadataValue(accounting.metadata.provider);
  const providerGenerationId = safeMetadataValue(accounting.metadata.providerGenerationId);
  if (requireProviderIdentity && (provider === undefined || providerGenerationId === undefined)) {
    return null;
  }
  const resolvedModel = safeMetadataValue(accounting.metadata.resolvedModel);
  return {
    accounting: {
      ...accounting,
      metadata: {
        ...(provider === undefined ? {} : { provider }),
        ...(providerGenerationId === undefined ? {} : { providerGenerationId }),
        ...(resolvedModel === undefined ? {} : { resolvedModel }),
      },
    },
    usage,
  };
}

function isAbort(error: unknown, signal: AbortSignal): boolean {
  return (
    signal.aborted ||
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

export function createCompactionService(input: {
  readonly budget: BudgetService;
  readonly database: AppDatabase;
  readonly gateway: ModelGateway;
  readonly mode: ModelPolicyMode;
}) {
  const { budget, database, gateway, mode } = input;

  async function startCompaction(
    context: CompactionExecutionInput,
  ): Promise<StartedCompaction | null> {
    try {
      return await database.transaction(async (transaction) => {
        const startedAt = new Date();
        const admission = await budget.lockAdmission(
          transaction,
          context.workspaceId,
          context.userId,
          startedAt,
        );
        const conversationRows = await transaction
          .select({ id: conversations.id })
          .from(conversations)
          .where(
            and(
              eq(conversations.id, context.conversationId),
              eq(conversations.workspaceId, context.workspaceId),
              eq(conversations.userId, context.userId),
            ),
          )
          .limit(1)
          .for("update");
        if (conversationRows[0] === undefined) {
          return null;
        }
        const chatRows = await transaction
          .select({ id: generations.id, status: generations.status })
          .from(generations)
          .where(
            and(
              eq(generations.id, context.chatGenerationId),
              eq(generations.workspaceId, context.workspaceId),
              eq(generations.userId, context.userId),
              eq(generations.conversationId, context.conversationId),
              eq(generations.purpose, "chat"),
            ),
          )
          .limit(1)
          .for("update");
        if (chatRows[0]?.status !== "preparing") {
          return null;
        }
        const compactionPolicy: ResolvedTierPolicy = {
          ...context.fastPolicy,
          maximumOutputTokens: context.plan.compaction.maximumOutputTokens,
        };
        const reservation = budget.reserveResolvedTier(
          admission,
          compactionPolicy,
          context.plan.compaction.estimatedInputTokens,
          startedAt,
          false,
        );
        const generationRows = await transaction
          .insert(generations)
          .values({
            assistantMessageId: null,
            conversationId: context.conversationId,
            createdAt: startedAt,
            effectiveParameters: {
              context: {
                sourceTurnCount: context.plan.compaction.sourceTurnCount,
                strategy: context.plan.strategy,
                throughMessageId: context.plan.compaction.throughMessageId,
              },
              ...(mode === "openrouter"
                ? {
                    maximumOutputTokens: context.plan.compaction.maximumOutputTokens,
                    priceCeiling: {
                      completionUsdPerMillion: unitPricePerMillion(
                        context.fastPolicy.completionPriceCeilingPerToken,
                      ),
                      promptUsdPerMillion: unitPricePerMillion(
                        context.fastPolicy.promptPriceCeilingPerToken,
                      ),
                      requestUsd: context.fastPolicy.requestPriceCeilingUsd,
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
            idempotencyKey: randomUUID(),
            purpose: "compaction",
            requestedTier: "fast",
            ...(mode === "openrouter"
              ? {
                  accountingStatus: reservation.accountingStatus,
                  budgetPeriodEnd: reservation.budgetPeriodEnd,
                  budgetPeriodStart: reservation.budgetPeriodStart,
                  completionPriceCeilingPerToken: reservation.completionPriceCeilingPerToken,
                  estimatedInputTokens: reservation.estimatedInputTokens,
                  maximumOutputTokens: reservation.maximumOutputTokens,
                  promptPriceCeilingPerToken: reservation.promptPriceCeilingPerToken,
                  requestPriceCeilingUsd: reservation.requestPriceCeilingUsd,
                  requestedModel: context.fastPolicy.resolvedModel,
                  reservationExpiresAt: reservation.reservationExpiresAt,
                  reservationMarginBasisPoints: reservation.reservationMarginBasisPoints,
                  reservedCostUsd: reservation.reservedCostUsd,
                  resolvedModel: context.fastPolicy.resolvedModel,
                }
              : {}),
            startedAt,
            status: "active",
            systemPromptVersion: context.plan.compaction.request.systemPrompt.version,
            updatedAt: startedAt,
            userId: context.userId,
            workspaceId: context.workspaceId,
          })
          .returning({ id: generations.id });
        const generationId = generationRows[0]?.id;
        if (generationId === undefined) {
          throw new Error("Compaction generation insertion returned no row");
        }
        const compactionRows = await transaction
          .insert(conversationCompactions)
          .values({
            conversationId: context.conversationId,
            createdAt: startedAt,
            generationId,
            modelUsed: context.fastPolicy.resolvedModel,
            previousCompactionId: context.plan.compaction.previousCompactionId,
            promptVersion: context.plan.compaction.request.systemPrompt.version,
            status: "active",
            throughMessageId: context.plan.compaction.throughMessageId,
            updatedAt: startedAt,
            userId: context.userId,
            workspaceId: context.workspaceId,
          })
          .returning({ id: conversationCompactions.id });
        const compactionId = compactionRows[0]?.id;
        if (compactionId === undefined) {
          throw new Error("Compaction insertion returned no row");
        }
        return Object.freeze({
          generationId,
          request: {
            ...context.plan.compaction.request,
            ...(mode === "openrouter"
              ? {
                  route: {
                    completionPriceCeilingUsdPerToken:
                      context.fastPolicy.completionPriceCeilingPerToken,
                    maximumOutputTokens: context.plan.compaction.maximumOutputTokens,
                    promptPriceCeilingUsdPerToken: context.fastPolicy.promptPriceCeilingPerToken,
                    requestPriceCeilingUsd: context.fastPolicy.requestPriceCeilingUsd,
                    requestedModel: context.fastPolicy.resolvedModel,
                  },
                }
              : {}),
          },
        });
      });
    } catch (error: unknown) {
      if (
        error instanceof WorkspaceBudgetExceededError ||
        error instanceof ContextBudgetExceededError
      ) {
        return null;
      }
      throw error;
    }
  }

  async function recordMetadata(
    generationId: string,
    metadata: GatewayProviderMetadata,
  ): Promise<void> {
    const provider = safeMetadataValue(metadata.provider);
    const providerGenerationId = safeMetadataValue(metadata.providerGenerationId);
    const resolvedModel = safeMetadataValue(metadata.resolvedModel);
    if (
      provider === undefined &&
      providerGenerationId === undefined &&
      resolvedModel === undefined
    ) {
      return;
    }
    await database
      .update(generations)
      .set({
        ...(provider === undefined ? {} : { provider }),
        ...(providerGenerationId === undefined
          ? {}
          : { openRouterGenerationId: providerGenerationId }),
        ...(resolvedModel === undefined ? {} : { resolvedModel }),
        updatedAt: sql`GREATEST(${generations.updatedAt}, CURRENT_TIMESTAMP)`,
      })
      .where(and(eq(generations.id, generationId), eq(generations.accountingStatus, "reserved")));
  }

  async function lookupTerminalAccounting(
    providerGenerationId: string | null,
    alreadyAttempted: boolean,
  ): Promise<TerminalAccounting | null> {
    if (
      mode !== "openrouter" ||
      alreadyAttempted ||
      providerGenerationId === null ||
      !("lookupUsage" in gateway) ||
      typeof gateway.lookupUsage !== "function"
    ) {
      return null;
    }
    const accountingGateway = gateway as ModelGateway & GenerationAccountingGateway;
    const lookup = await accountingGateway
      .lookupUsage(providerGenerationId, new AbortController().signal)
      .catch(() => ({ status: "unavailable" as const }));
    return lookup.status === "found"
      ? normalizeTerminalAccounting(lookup.usage, lookup.accounting, true)
      : null;
  }

  async function terminalizeCompaction(
    context: CompactionExecutionInput,
    generationId: string,
    terminal: TerminalCompactionInput,
  ): Promise<TerminalizationResult> {
    return database.transaction(async (transaction) => {
      const conversationRows = await transaction
        .select({ id: conversations.id })
        .from(conversations)
        .where(
          and(
            eq(conversations.id, context.conversationId),
            eq(conversations.workspaceId, context.workspaceId),
            eq(conversations.userId, context.userId),
          ),
        )
        .limit(1)
        .for("update");
      if (conversationRows[0] === undefined) {
        return { reusable: false, won: false };
      }
      const generationRows = await transaction
        .select()
        .from(generations)
        .where(
          and(
            eq(generations.id, generationId),
            eq(generations.workspaceId, context.workspaceId),
            eq(generations.userId, context.userId),
            eq(generations.conversationId, context.conversationId),
            eq(generations.purpose, "compaction"),
          ),
        )
        .limit(1)
        .for("update");
      const generation = generationRows[0];
      if (generation === undefined || generation.status !== "active") {
        return { reusable: false, won: false };
      }
      const compactionRows = await transaction
        .select()
        .from(conversationCompactions)
        .where(
          and(
            eq(conversationCompactions.generationId, generationId),
            eq(conversationCompactions.workspaceId, context.workspaceId),
            eq(conversationCompactions.userId, context.userId),
            eq(conversationCompactions.conversationId, context.conversationId),
          ),
        )
        .limit(1)
        .for("update");
      const compaction = compactionRows[0];
      if (compaction === undefined || compaction.status !== "active") {
        return { reusable: false, won: false };
      }
      const firstTokenAt =
        generation.firstTokenAt ??
        (terminal.firstTokenAt === null
          ? null
          : new Date(
              Math.max(
                terminal.firstTokenAt.getTime(),
                generation.startedAt.getTime(),
                generation.createdAt.getTime(),
              ),
            ));
      const completedAt = new Date(
        Math.max(
          Date.now(),
          generation.startedAt.getTime(),
          generation.updatedAt.getTime(),
          firstTokenAt?.getTime() ?? 0,
        ),
      );
      if (terminal.accounting !== undefined && terminal.usage !== undefined) {
        const settled = await budget.settleAuthoritativeUsageInTransaction(
          transaction,
          generationId,
          authoritativeUsage(terminal.usage, terminal.accounting),
          completedAt,
        );
        if (generation.accountingStatus === "reserved" && !settled) {
          throw new Error("Compaction accounting could not be settled");
        }
      } else if (terminal.settleDeterministicZero && generation.accountingStatus === "reserved") {
        const settled = await budget.settleAuthoritativeUsageInTransaction(
          transaction,
          generationId,
          { completionTokens: 0, costUsd: "0", promptTokens: 0 },
          completedAt,
        );
        if (!settled) {
          throw new Error("Compaction zero-cost accounting could not be settled");
        }
      }

      const reusable =
        terminal.status === "completed" &&
        terminal.reason === "stop" &&
        terminal.usage !== undefined &&
        validUsage(terminal.usage) &&
        usefulText(terminal.content);
      const resolvedModel = safeMetadataValue(terminal.accounting?.metadata.resolvedModel);
      await transaction
        .update(generations)
        .set({
          completedAt,
          errorCode: terminal.errorCode,
          firstTokenAt,
          ...(resolvedModel === undefined ? {} : { resolvedModel }),
          status: terminal.status,
          terminalReason: terminal.reason,
          updatedAt: completedAt,
        })
        .where(and(eq(generations.id, generationId), eq(generations.status, "active")));
      await transaction
        .update(conversationCompactions)
        .set(
          reusable
            ? {
                completedAt,
                sourceTokenCount: BigInt(terminal.usage?.inputTokens ?? 0),
                status: "completed",
                summary: terminal.content,
                summaryTokenCount: BigInt(terminal.usage?.outputTokens ?? 0),
                updatedAt: completedAt,
              }
            : {
                completedAt,
                status:
                  terminal.status === "cancelled"
                    ? "cancelled"
                    : terminal.status === "failed"
                      ? "failed"
                      : "incomplete",
                updatedAt: completedAt,
              },
        )
        .where(
          and(
            eq(conversationCompactions.id, compaction.id),
            eq(conversationCompactions.status, "active"),
          ),
        );
      return { reusable, won: true };
    });
  }

  async function terminalizeWithLateAccounting(
    context: CompactionExecutionInput,
    generationId: string,
    terminal: TerminalCompactionInput,
  ): Promise<TerminalizationResult> {
    const result = await terminalizeCompaction(context, generationId, terminal);
    if (!result.won && terminal.accounting !== undefined && terminal.usage !== undefined) {
      await recordMetadata(generationId, terminal.accounting.metadata);
      await budget.settleAuthoritativeUsage(
        generationId,
        authoritativeUsage(terminal.usage, terminal.accounting),
      );
    }
    return result;
  }

  async function promoteChat(
    context: CompactionExecutionInput,
    modeValue: "compacted" | "fallback",
  ): Promise<boolean> {
    return database.transaction(async (transaction) => {
      const conversationRows = await transaction
        .select({ id: conversations.id })
        .from(conversations)
        .where(
          and(
            eq(conversations.id, context.conversationId),
            eq(conversations.workspaceId, context.workspaceId),
            eq(conversations.userId, context.userId),
          ),
        )
        .limit(1)
        .for("update");
      if (conversationRows[0] === undefined) {
        return false;
      }
      const updated = await transaction
        .update(generations)
        .set({
          effectiveParameters: sql`${generations.effectiveParameters} || ${JSON.stringify({
            context: {
              mode: modeValue,
              strategy: context.plan.strategy,
              throughMessageId: context.plan.compaction.throughMessageId,
            },
          })}::jsonb`,
          status: "active",
          updatedAt: sql`GREATEST(${generations.updatedAt}, CURRENT_TIMESTAMP)`,
        })
        .where(
          and(
            eq(generations.id, context.chatGenerationId),
            eq(generations.workspaceId, context.workspaceId),
            eq(generations.userId, context.userId),
            eq(generations.conversationId, context.conversationId),
            eq(generations.purpose, "chat"),
            eq(generations.status, "preparing"),
          ),
        )
        .returning({ id: generations.id });
      return updated.length === 1;
    });
  }

  async function cancelPreparingChat(context: CompactionExecutionInput): Promise<void> {
    await database.transaction(async (transaction) => {
      const conversationRows = await transaction
        .select({ revision: conversations.revision })
        .from(conversations)
        .where(
          and(
            eq(conversations.id, context.conversationId),
            eq(conversations.workspaceId, context.workspaceId),
            eq(conversations.userId, context.userId),
          ),
        )
        .limit(1)
        .for("update");
      const conversation = conversationRows[0];
      if (conversation === undefined) {
        return;
      }
      const generationRows = await transaction
        .select()
        .from(generations)
        .where(
          and(
            eq(generations.id, context.chatGenerationId),
            eq(generations.workspaceId, context.workspaceId),
            eq(generations.userId, context.userId),
            eq(generations.conversationId, context.conversationId),
            eq(generations.purpose, "chat"),
          ),
        )
        .limit(1)
        .for("update");
      const generation = generationRows[0];
      if (generation?.status !== "preparing") {
        return;
      }
      const completedAt = new Date(
        Math.max(Date.now(), generation.startedAt.getTime(), generation.updatedAt.getTime()),
      );
      if (generation.accountingStatus === "reserved") {
        const settled = await budget.settleAuthoritativeUsageInTransaction(
          transaction,
          generation.id,
          { completionTokens: 0, costUsd: "0", promptTokens: 0 },
          completedAt,
        );
        if (!settled) {
          throw new Error("Cancelled preparing chat accounting could not be settled");
        }
      }
      await transaction
        .update(generations)
        .set({
          completedAt,
          status: "cancelled",
          terminalReason: "cancelled",
          updatedAt: completedAt,
        })
        .where(
          and(
            eq(generations.id, generation.id),
            eq(generations.workspaceId, context.workspaceId),
            eq(generations.userId, context.userId),
            eq(generations.conversationId, context.conversationId),
            eq(generations.status, "preparing"),
          ),
        );
      await transaction
        .update(conversations)
        .set({ revision: conversation.revision + 1, updatedAt: completedAt })
        .where(
          and(
            eq(conversations.id, context.conversationId),
            eq(conversations.workspaceId, context.workspaceId),
            eq(conversations.userId, context.userId),
          ),
        );
    });
  }

  async function execute(
    context: CompactionExecutionInput,
    signal: AbortSignal,
  ): Promise<CompactionExecutionResult> {
    if (signal.aborted) {
      await cancelPreparingChat(context);
      return { kind: "cancelled" };
    }
    const started = await startCompaction(context);
    if (started === null) {
      if (!(await promoteChat(context, "fallback"))) {
        return { kind: "cancelled" };
      }
      return { chat: context.plan.fallback, kind: "fallback" };
    }

    let content = "";
    let contentBytes = 0;
    let firstTokenAt: Date | null = null;
    let providerGenerationId: string | null = null;
    let terminalEvent: GatewayEvent | null = null;
    let usageLookupAttempted = false;
    try {
      for await (const event of gateway.stream(started.request, signal)) {
        if (event.type === "generation.metadata") {
          providerGenerationId =
            safeMetadataValue(event.metadata.providerGenerationId) ?? providerGenerationId;
          await recordMetadata(started.generationId, event.metadata);
          continue;
        }
        if (event.type === "content.delta") {
          if (
            event.text.length === 0 ||
            !event.text.isWellFormed() ||
            hasUnsupportedControlCharacter(event.text)
          ) {
            throw new Error("Compaction output is invalid");
          }
          const deltaBytes = Buffer.byteLength(event.text, "utf8");
          if (contentBytes + deltaBytes > contextCompactionTuning.maximumSummaryBytes) {
            throw new Error("Compaction output exceeded its accumulator");
          }
          content += event.text;
          contentBytes += deltaBytes;
          firstTokenAt ??= new Date();
          continue;
        }
        terminalEvent = event;
        break;
      }
    } catch (error: unknown) {
      const lookup = await lookupTerminalAccounting(providerGenerationId, usageLookupAttempted);
      if (isAbort(error, signal)) {
        await terminalizeWithLateAccounting(context, started.generationId, {
          ...(lookup ?? {}),
          content,
          errorCode: null,
          firstTokenAt,
          reason: "cancelled",
          status: "cancelled",
        });
        await cancelPreparingChat(context);
        return { kind: "cancelled" };
      }
      await terminalizeWithLateAccounting(context, started.generationId, {
        ...(lookup ?? {}),
        content,
        errorCode: "GENERATION_FAILED",
        firstTokenAt,
        reason: "error",
        status: usefulText(content) ? "incomplete" : "failed",
      });
      if (!(await promoteChat(context, "fallback"))) {
        return { kind: "cancelled" };
      }
      return { chat: context.plan.fallback, kind: "fallback" };
    }

    if (terminalEvent?.type === "response.completed") {
      providerGenerationId =
        safeMetadataValue(terminalEvent.accounting?.metadata.providerGenerationId) ??
        providerGenerationId;
      if (!validUsage(terminalEvent.usage)) {
        terminalEvent = null;
      } else {
        const eventAccounting =
          terminalEvent.accounting === undefined
            ? null
            : normalizeTerminalAccounting(
                terminalEvent.usage,
                terminalEvent.accounting,
                mode === "openrouter",
              );
        const lookup =
          eventAccounting === null
            ? await lookupTerminalAccounting(providerGenerationId, usageLookupAttempted)
            : null;
        const terminalAccounting = lookup ?? eventAccounting;
        if (mode === "openrouter" && terminalAccounting === null) {
          await terminalizeWithLateAccounting(context, started.generationId, {
            content,
            errorCode: "GENERATION_FAILED",
            firstTokenAt,
            reason: "error",
            status: usefulText(content) ? "incomplete" : "failed",
          });
          if (!(await promoteChat(context, "fallback"))) {
            return { kind: "cancelled" };
          }
          return { chat: context.plan.fallback, kind: "fallback" };
        }
        const terminalized = await terminalizeWithLateAccounting(context, started.generationId, {
          ...(terminalAccounting ?? {}),
          content,
          errorCode:
            terminalEvent.reason === "stop" && !usefulText(content) ? "EMPTY_RESPONSE" : null,
          firstTokenAt,
          reason:
            terminalEvent.reason === "stop" && !usefulText(content)
              ? "error"
              : terminalEvent.reason,
          status: terminalEvent.reason === "stop" && !usefulText(content) ? "failed" : "completed",
          usage: terminalAccounting?.usage ?? terminalEvent.usage,
        });
        if (terminalized.reusable && context.plan.strategy === "normal") {
          const chat = materializeCompactedChat(context.plan, content);
          if (!(await promoteChat(context, "compacted"))) {
            return { kind: "cancelled" };
          }
          return { chat, kind: "compacted" };
        }
        if (!(await promoteChat(context, "fallback"))) {
          return { kind: "cancelled" };
        }
        return { chat: context.plan.fallback, kind: "fallback" };
      }
    }

    if (terminalEvent?.type === "response.failed") {
      usageLookupAttempted = terminalEvent.usageLookupAttempted === true;
      providerGenerationId =
        safeMetadataValue(terminalEvent.accounting?.metadata?.providerGenerationId) ??
        safeMetadataValue(terminalEvent.accounting?.actual?.metadata.providerGenerationId) ??
        providerGenerationId;
      const actual = terminalEvent.accounting?.actual;
      const completedOutcome = terminalEvent.providerOutcome;
      const eventAccountingCandidate =
        actual !== undefined && terminalEvent.usage !== undefined && validUsage(terminalEvent.usage)
          ? { accounting: actual, usage: terminalEvent.usage }
          : null;
      const eventAccounting =
        eventAccountingCandidate === null
          ? null
          : normalizeTerminalAccounting(
              eventAccountingCandidate.usage,
              eventAccountingCandidate.accounting,
              mode === "openrouter",
            );
      const lookup =
        eventAccounting === null || eventAccounting.accounting.metadata.provider === undefined
          ? await lookupTerminalAccounting(providerGenerationId, usageLookupAttempted)
          : null;
      const terminalAccounting = lookup ?? eventAccounting;
      const accountedOutcome = completedOutcome !== undefined && terminalAccounting !== null;
      await terminalizeWithLateAccounting(context, started.generationId, {
        ...(terminalAccounting ?? {}),
        content,
        errorCode: accountedOutcome ? null : terminalEvent.errorCode,
        firstTokenAt,
        reason: accountedOutcome ? completedOutcome : "error",
        settleDeterministicZero:
          terminalAccounting === null && terminalEvent.accounting?.spendRisk === "none",
        status: accountedOutcome ? "completed" : usefulText(content) ? "incomplete" : "failed",
      });
    } else {
      const lookup = await lookupTerminalAccounting(providerGenerationId, usageLookupAttempted);
      await terminalizeWithLateAccounting(context, started.generationId, {
        ...(lookup ?? {}),
        content,
        errorCode: "GENERATION_FAILED",
        firstTokenAt,
        reason: "error",
        status: usefulText(content) ? "incomplete" : "failed",
      });
    }

    if (!(await promoteChat(context, "fallback"))) {
      return { kind: "cancelled" };
    }
    return { chat: context.plan.fallback, kind: "fallback" };
  }

  return Object.freeze({ cancel: cancelPreparingChat, execute });
}

export type CompactionService = ReturnType<typeof createCompactionService>;

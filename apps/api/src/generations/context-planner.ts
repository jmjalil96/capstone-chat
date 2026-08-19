import type { GenerationModelTier } from "@capstone/protocol";
import { conservativeTokenEstimate } from "../model-policy/settings.js";
import { compactionPrompt, serializeCompactionInput } from "./compaction-prompt.js";
import {
  type ChatGenerationRequest,
  type CompactionGenerationRequest,
  type GenerationContextMessage,
  generationRequestEstimatorInputs,
} from "./model-gateway.js";
import { systemPrompt } from "./prompt.js";

export const contextCompactionTuning = Object.freeze({
  fallbackMinimumTurns: 6,
  maximumOutputTokens: 2_048,
  maximumSummaryBytes: 64 * 1_024,
  normalRecentTurns: 8,
  triggerPercent: 80,
});

export interface ContextTurnMessage {
  readonly id: string;
  readonly text: string;
}

export interface ContextTurn {
  readonly assistant: ContextTurnMessage;
  readonly user: ContextTurnMessage;
}

export interface ApplicableCompaction {
  readonly id: string;
  readonly summary: string;
  readonly throughMessageId: string;
}

export interface ContextRouteCapacity {
  readonly contextLength: number;
  readonly maximumOutputTokens: number;
}

export interface ContextPlannerInput {
  readonly chatRoute: ContextRouteCapacity;
  readonly fastRoute: ContextRouteCapacity | null;
  readonly latestMessage: string;
  readonly modelTier: GenerationModelTier;
  readonly previousCompaction: ApplicableCompaction | null;
  /** Chronological complete turns after the previous compaction and before recentTurns. */
  readonly sourceTurns: readonly ContextTurn[];
  /** True when another complete turn remains between sourceTurns and recentTurns. */
  readonly sourceOverflow: boolean;
  /** The newest chronological complete turns, bounded to normalRecentTurns. */
  readonly recentTurns: readonly ContextTurn[];
}

export interface PlannedChatContext {
  readonly estimatedInputTokens: bigint;
  readonly request: ChatGenerationRequest;
  readonly retainedTurnCount: number;
}

export interface FullContextPlan extends PlannedChatContext {
  readonly mode: "full";
}

export interface ReusedCompactionContextPlan extends PlannedChatContext {
  readonly compactionId: string;
  readonly mode: "compacted";
}

export type ContextFallbackReason =
  | "compaction-source-too-large"
  | "fast-unavailable"
  | "no-compactable-prefix"
  | "planned-summary-too-large";

export interface FallbackContextPlan extends PlannedChatContext {
  readonly mode: "fallback";
  readonly reason: ContextFallbackReason;
}

export interface PendingContextPlan {
  readonly compaction: {
    readonly estimatedInputTokens: bigint;
    readonly maximumOutputTokens: number;
    readonly previousCompactionId: string | null;
    readonly request: CompactionGenerationRequest;
    readonly sourceTurnCount: number;
    readonly throughMessageId: string;
  };
  readonly fallback: PlannedChatContext;
  readonly maximumChatInputTokens: bigint;
  readonly mode: "pending";
  readonly recentHistory: readonly GenerationContextMessage[];
  readonly strategy: "catch-up" | "normal";
}

export type ContextPlan =
  | FallbackContextPlan
  | FullContextPlan
  | PendingContextPlan
  | ReusedCompactionContextPlan;

export class ContextPlanTooLargeError extends Error {
  constructor() {
    super("The minimum complete-turn context does not fit the selected route");
    this.name = "ContextPlanTooLargeError";
  }
}

function validPositiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function safeInputBudget(
  route: ContextRouteCapacity,
  maximumOutputTokens = route.maximumOutputTokens,
): bigint {
  if (
    !validPositiveInteger(route.contextLength) ||
    !validPositiveInteger(route.maximumOutputTokens) ||
    !validPositiveInteger(maximumOutputTokens) ||
    route.maximumOutputTokens >= route.contextLength ||
    maximumOutputTokens > route.maximumOutputTokens ||
    maximumOutputTokens >= route.contextLength
  ) {
    throw new RangeError("Context route capacity is invalid");
  }
  return BigInt(route.contextLength - maximumOutputTokens);
}

function historyFromTurns(turns: readonly ContextTurn[]): readonly GenerationContextMessage[] {
  return turns.flatMap((turn) => [
    { role: "user" as const, text: turn.user.text },
    { role: "assistant" as const, text: turn.assistant.text },
  ]);
}

function chatRequest(input: {
  readonly derivedSummary?: string;
  readonly history: readonly GenerationContextMessage[];
  readonly latestMessage: string;
  readonly modelTier: GenerationModelTier;
}): ChatGenerationRequest {
  return {
    ...(input.derivedSummary === undefined
      ? {}
      : {
          derivedContext: {
            kind: "compaction-summary" as const,
            summary: input.derivedSummary,
          },
        }),
    history: input.history,
    message: { role: "user", text: input.latestMessage },
    modelTier: input.modelTier,
    purpose: "chat",
    systemPrompt,
  };
}

function estimate(request: ChatGenerationRequest | CompactionGenerationRequest): bigint {
  return conservativeTokenEstimate(generationRequestEstimatorInputs(request));
}

function assertSummaryBound(summary: string): void {
  if (Buffer.byteLength(summary, "utf8") > contextCompactionTuning.maximumSummaryBytes) {
    throw new RangeError("Compaction summary exceeds the bounded accumulator");
  }
}

function fallbackContext(input: ContextPlannerInput, chatSafeInput: bigint): PlannedChatContext {
  const maximumTurns = input.recentTurns.length;
  const minimumTurns = Math.min(contextCompactionTuning.fallbackMinimumTurns, maximumTurns);
  for (let turnCount = maximumTurns; turnCount >= minimumTurns; turnCount -= 1) {
    const retainedTurns = input.recentTurns.slice(maximumTurns - turnCount);
    const request = chatRequest({
      history: historyFromTurns(retainedTurns),
      latestMessage: input.latestMessage,
      modelTier: input.modelTier,
    });
    const estimatedInputTokens = estimate(request);
    if (estimatedInputTokens <= chatSafeInput) {
      return { estimatedInputTokens, request, retainedTurnCount: turnCount };
    }
  }
  throw new ContextPlanTooLargeError();
}

function compactionRequest(
  previousSummary: string | null,
  turns: readonly ContextTurn[],
): CompactionGenerationRequest {
  return {
    history: [],
    message: {
      role: "user",
      text: serializeCompactionInput({
        messages: historyFromTurns(turns),
        previousSummary,
      }),
    },
    modelTier: "fast",
    purpose: "compaction",
    systemPrompt: compactionPrompt,
  };
}

function thresholdReached(estimatedInputTokens: bigint, safeInputTokens: bigint): boolean {
  return (
    estimatedInputTokens * 100n >= safeInputTokens * BigInt(contextCompactionTuning.triggerPercent)
  );
}

function plannedMaximumChatInput(input: ContextPlannerInput): bigint {
  // Backslash is valid summary text and requires the largest JSON escaping among one-byte
  // characters accepted by the text boundary, so this covers every summary under the byte cap.
  const maximumSummary = "\\".repeat(contextCompactionTuning.maximumSummaryBytes);
  return estimate(
    chatRequest({
      derivedSummary: maximumSummary,
      history: historyFromTurns(input.recentTurns),
      latestMessage: input.latestMessage,
      modelTier: input.modelTier,
    }),
  );
}

function pendingPlan(
  input: ContextPlannerInput,
  fallback: PlannedChatContext,
  chatSafeInput: bigint,
  fastSafeInput: bigint,
  compactionMaximumOutputTokens: number,
): ContextPlan {
  if (input.sourceTurns.length === 0) {
    return { ...fallback, mode: "fallback", reason: "no-compactable-prefix" };
  }

  let selectedTurns: readonly ContextTurn[] = [];
  let selectedRequest: CompactionGenerationRequest | null = null;
  let selectedEstimate = 0n;
  let lowerBound = 1;
  let upperBound = input.sourceTurns.length;
  while (lowerBound <= upperBound) {
    const candidateCount = Math.floor((lowerBound + upperBound) / 2);
    const candidateTurns = input.sourceTurns.slice(0, candidateCount);
    const candidateRequest = compactionRequest(
      input.previousCompaction?.summary ?? null,
      candidateTurns,
    );
    const candidateEstimate = estimate(candidateRequest);
    if (candidateEstimate > fastSafeInput) {
      upperBound = candidateCount - 1;
      continue;
    }
    selectedTurns = candidateTurns;
    selectedRequest = candidateRequest;
    selectedEstimate = candidateEstimate;
    lowerBound = candidateCount + 1;
  }

  if (selectedRequest === null) {
    return { ...fallback, mode: "fallback", reason: "compaction-source-too-large" };
  }

  const strategy =
    input.sourceOverflow || selectedTurns.length < input.sourceTurns.length ? "catch-up" : "normal";
  const maximumChatInputTokens =
    strategy === "normal" ? plannedMaximumChatInput(input) : fallback.estimatedInputTokens;
  if (maximumChatInputTokens > chatSafeInput) {
    return { ...fallback, mode: "fallback", reason: "planned-summary-too-large" };
  }
  const throughMessageId = selectedTurns.at(-1)?.assistant.id;
  if (throughMessageId === undefined) {
    throw new Error("A compaction plan requires a complete source turn");
  }

  return {
    compaction: {
      estimatedInputTokens: selectedEstimate,
      maximumOutputTokens: compactionMaximumOutputTokens,
      previousCompactionId: input.previousCompaction?.id ?? null,
      request: selectedRequest,
      sourceTurnCount: selectedTurns.length,
      throughMessageId,
    },
    fallback,
    maximumChatInputTokens,
    mode: "pending",
    recentHistory: historyFromTurns(input.recentTurns),
    strategy,
  };
}

export function planContext(input: ContextPlannerInput): ContextPlan {
  if (input.recentTurns.length > contextCompactionTuning.normalRecentTurns) {
    throw new RangeError("Recent context exceeds the bounded complete-turn window");
  }
  if (input.previousCompaction !== null) {
    assertSummaryBound(input.previousCompaction.summary);
  }

  const chatSafeInput = safeInputBudget(input.chatRoute);
  const fallback = fallbackContext(input, chatSafeInput);
  let fastSafeInput: bigint | null = null;
  let compactionMaximumOutputTokens: number | null = null;
  if (input.fastRoute !== null) {
    compactionMaximumOutputTokens = Math.min(
      contextCompactionTuning.maximumOutputTokens,
      input.fastRoute.maximumOutputTokens,
    );
    fastSafeInput = safeInputBudget(input.fastRoute, compactionMaximumOutputTokens);
  }

  if (input.sourceOverflow) {
    if (fastSafeInput === null || compactionMaximumOutputTokens === null) {
      return { ...fallback, mode: "fallback", reason: "fast-unavailable" };
    }
    return pendingPlan(
      input,
      fallback,
      chatSafeInput,
      fastSafeInput,
      compactionMaximumOutputTokens,
    );
  }

  const request = chatRequest({
    ...(input.previousCompaction === null
      ? {}
      : { derivedSummary: input.previousCompaction.summary }),
    history: historyFromTurns([...input.sourceTurns, ...input.recentTurns]),
    latestMessage: input.latestMessage,
    modelTier: input.modelTier,
  });
  const estimatedInputTokens = estimate(request);
  const triggerSafeInput =
    fastSafeInput === null || fastSafeInput > chatSafeInput ? chatSafeInput : fastSafeInput;

  if (!thresholdReached(estimatedInputTokens, triggerSafeInput)) {
    if (input.previousCompaction === null) {
      return {
        estimatedInputTokens,
        mode: "full",
        request,
        retainedTurnCount: input.sourceTurns.length + input.recentTurns.length,
      };
    }
    return {
      compactionId: input.previousCompaction.id,
      estimatedInputTokens,
      mode: "compacted",
      request,
      retainedTurnCount: input.sourceTurns.length + input.recentTurns.length,
    };
  }

  if (fastSafeInput === null || compactionMaximumOutputTokens === null) {
    return { ...fallback, mode: "fallback", reason: "fast-unavailable" };
  }
  return pendingPlan(input, fallback, chatSafeInput, fastSafeInput, compactionMaximumOutputTokens);
}

export function materializeCompactedChat(
  plan: PendingContextPlan,
  summary: string,
): PlannedChatContext {
  if (plan.strategy !== "normal") {
    throw new Error("Catch-up compaction is not current-chat context");
  }
  assertSummaryBound(summary);
  const request = chatRequest({
    derivedSummary: summary,
    history: plan.recentHistory,
    latestMessage: plan.fallback.request.message.text,
    modelTier: plan.fallback.request.modelTier,
  });
  const estimatedInputTokens = estimate(request);
  if (estimatedInputTokens > plan.maximumChatInputTokens) {
    throw new Error("Compacted chat exceeds its planned input reservation");
  }
  return {
    estimatedInputTokens,
    request,
    retainedTurnCount: plan.recentHistory.length / 2,
  };
}

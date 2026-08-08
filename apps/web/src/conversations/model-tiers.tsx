import type { GenerationModelTier, ModelTierPolicyResponse } from "@capstone/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { copy } from "../copy";
import {
  ConversationApiError,
  conversationQueryKeys,
  fetchConversationPreferredTier,
  fetchModelTierPolicy,
  updateConversationPreferredTier,
} from "./api";
import { useDraftMemory } from "./draft-memory";
import { useConversationRequestLifetime } from "./request-lifetime";

export const MODEL_TIER_ORDER = ["fast", "balanced", "pro"] as const;

export function isModelTierAvailable(
  policy: ModelTierPolicyResponse | undefined,
  tier: GenerationModelTier | undefined,
): boolean {
  if (!policy || !tier) {
    return false;
  }
  const state = policy.tiers.find((candidate) => candidate.tier === tier);
  return Boolean(state?.enabled && state.available);
}

export function useModelTierPolicy() {
  const { queryScope } = useDraftMemory();
  return useQuery({
    queryKey: conversationQueryKeys.modelTierPolicy(queryScope),
    queryFn: ({ signal }) => fetchModelTierPolicy(signal),
    staleTime: 30_000,
  });
}

export function useConversationModelTier(conversationId: string) {
  const { queryScope } = useDraftMemory();
  const queryClient = useQueryClient();
  const policy = useModelTierPolicy();
  const preference = useQuery({
    queryKey: conversationQueryKeys.preferredTier(queryScope, conversationId),
    queryFn: ({ signal }) => fetchConversationPreferredTier(conversationId, signal),
    enabled: conversationId.length > 0,
    staleTime: 30_000,
  });
  const requestLifetime = useConversationRequestLifetime(`preferred-tier:${conversationId}`);
  const update = useMutation({
    mutationKey: conversationQueryKeys.preferredTier(queryScope, conversationId),
    mutationFn: async (modelTier: GenerationModelTier) => {
      const capture = requestLifetime.capture();
      try {
        const canonical = await updateConversationPreferredTier(
          conversationId,
          { modelTier },
          capture.signal,
        );
        if (capture.isCurrent()) {
          queryClient.setQueryData(
            conversationQueryKeys.preferredTier(queryScope, conversationId),
            canonical,
          );
        }
        return canonical;
      } catch (error) {
        if (capture.isCurrent()) {
          void queryClient.invalidateQueries({
            queryKey: conversationQueryKeys.modelTierPolicy(queryScope),
          });
        }
        throw error;
      } finally {
        capture.release();
      }
    },
  });

  const selectedTier = preference.data?.modelTier;

  return {
    available: isModelTierAvailable(policy.data, selectedTier),
    error: policy.isError || preference.isError,
    isPending: policy.isPending || preference.isPending,
    policy: policy.data,
    retry: () => {
      void policy.refetch();
      void preference.refetch();
    },
    selectedTier,
    updateError: update.error,
    updatePending: update.isPending,
    select: (tier: GenerationModelTier) => {
      if (tier !== selectedTier && !update.isPending && isModelTierAvailable(policy.data, tier)) {
        update.mutate(tier);
      }
    },
  } as const;
}

interface ModelTierPickerProps {
  readonly error: boolean;
  readonly id: string;
  readonly isPending: boolean;
  readonly onSelect: (tier: GenerationModelTier) => void;
  readonly onRetry?: () => void;
  readonly policy: ModelTierPolicyResponse | undefined;
  readonly selectedTier: GenerationModelTier | undefined;
  readonly updateError?: unknown;
  readonly updatePending?: boolean;
}

function pickerStatus({
  error,
  isPending,
  policy,
  selectedTier,
  updateError,
}: Pick<ModelTierPickerProps, "error" | "isPending" | "policy" | "selectedTier" | "updateError">):
  | { readonly alert: boolean; readonly text: string }
  | undefined {
  if (updateError) {
    return {
      alert: true,
      text:
        updateError instanceof ConversationApiError && updateError.code === "TIER_UNAVAILABLE"
          ? copy.conversations.modelTiers.unavailable
          : copy.conversations.modelTiers.saveError,
    };
  }
  if (error) {
    return { alert: true, text: copy.conversations.modelTiers.loadError };
  }
  if (isPending) {
    return { alert: false, text: copy.conversations.modelTiers.loading };
  }
  if (!policy?.tiers.some((tier) => tier.enabled && tier.available)) {
    return { alert: false, text: copy.conversations.modelTiers.noneAvailable };
  }
  if (selectedTier && !isModelTierAvailable(policy, selectedTier)) {
    return { alert: false, text: copy.conversations.modelTiers.unavailable };
  }
  return undefined;
}

export function ModelTierPicker(props: ModelTierPickerProps) {
  const status = pickerStatus(props);
  const descriptionId = `${props.id}-status`;
  const selectionReady = Boolean(props.policy && props.selectedTier && !props.error);

  return (
    <div className="model-tier-control">
      <fieldset
        className="model-tier-picker"
        aria-describedby={status ? descriptionId : undefined}
        aria-busy={props.isPending || props.updatePending}
      >
        <legend>{copy.conversations.modelTiers.label}</legend>
        <div className="model-tier-options">
          {MODEL_TIER_ORDER.map((tier) => {
            const state = props.policy?.tiers.find((candidate) => candidate.tier === tier);
            const available = Boolean(state?.enabled && state.available);
            return (
              <label className="model-tier-option" data-available={available} key={tier}>
                <input
                  type="radio"
                  name={`${props.id}-model-tier`}
                  value={tier}
                  checked={props.selectedTier === tier}
                  disabled={!selectionReady || !available || props.updatePending}
                  onChange={() => props.onSelect(tier)}
                />
                <span>
                  <strong>{copy.conversations.modelTiers.tiers[tier].name}</strong>
                  <small>{copy.conversations.modelTiers.tiers[tier].purpose}</small>
                  {!available && !props.isPending ? (
                    <small>{copy.conversations.modelTiers.optionUnavailable}</small>
                  ) : null}
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>
      {status ? (
        <div className="model-tier-feedback">
          <p
            className={status.alert ? "model-tier-status model-tier-error" : "model-tier-status"}
            id={descriptionId}
            role={status.alert ? "alert" : "status"}
          >
            {status.text}
          </p>
          {props.error && props.onRetry ? (
            <button className="text-button" type="button" onClick={props.onRetry}>
              {copy.conversations.common.retry}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

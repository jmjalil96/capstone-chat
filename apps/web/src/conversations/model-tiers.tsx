import type { GenerationModelTier, ModelTierPolicyResponse } from "@capstone/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { copy } from "../copy";
import {
  ConversationApiError,
  conversationQueryKeys,
  fetchConversationPreferredTier,
  fetchModelTierPolicy,
  updateConversationPreferredTier,
} from "./api";
import { useDraftMemory } from "./draft-memory";
import { Icon } from "./icons";
import { useConversationRequestLifetime } from "./request-lifetime";
import { useDisclosureDismissal } from "./use-disclosure-dismissal";

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
  const triggerId = `${props.id}-model-tier`;
  const popoverId = `${props.id}-model-tier-popover`;
  const selectionReady = Boolean(props.policy && props.selectedTier && !props.error);
  const hasAvailableTier = Boolean(
    props.policy?.tiers.some((tier) => tier.enabled && tier.available),
  );
  const displayTier = props.selectedTier ?? props.policy?.defaultTier ?? "balanced";
  // Until the selection is known, the trigger must not assert a tier name it is
  // only guessing at; announce a pending or unknown placeholder instead.
  const tierName = selectionReady
    ? copy.conversations.modelTiers.tiers[displayTier].name
    : props.isPending
      ? copy.conversations.modelTiers.tierPending
      : copy.conversations.modelTiers.tierUnknown;
  const triggerLocked = !selectionReady || !hasAvailableTier;
  const updatePending = Boolean(props.updatePending);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<"down" | "up">("up");
  const [panelMaxBlockSize, setPanelMaxBlockSize] = useState<number>();

  const restoreTriggerFocus = () => {
    const trigger = triggerRef.current;
    queueMicrotask(() => {
      if (trigger?.isConnected) {
        trigger.focus();
      }
    });
  };

  const toggleDisclosure = () => {
    if (updatePending) {
      return;
    }
    setOpen((current) => !current);
  };

  const chooseTier = (tier: GenerationModelTier) => {
    if (updatePending) {
      return;
    }
    props.onSelect(tier);
    setOpen(false);
    restoreTriggerFocus();
  };

  // Measure available space so the popover never collides with viewport edges or clip
  // roots. The bound is the visual viewport (which shrinks under mobile on-screen
  // keyboards) intersected with every overflow-clipping ancestor, and it is
  // re-measured while open because all of those move independently of the trigger.
  useLayoutEffect(() => {
    if (!open) {
      return;
    }
    const trigger = triggerRef.current;
    const panel = panelRef.current;
    if (!trigger || !panel) {
      return;
    }

    const clipAncestors: HTMLElement[] = [];
    for (
      let node = trigger.parentElement;
      node && node !== document.body;
      node = node.parentElement
    ) {
      const style = getComputedStyle(node);
      if (style.overflowY !== "visible" || style.overflowX !== "visible") {
        clipAncestors.push(node);
      }
    }

    const measure = () => {
      const viewport = window.visualViewport;
      let boundTop = viewport ? viewport.offsetTop : 0;
      let boundBottom = viewport
        ? viewport.offsetTop + viewport.height
        : document.documentElement.clientHeight;
      for (const ancestor of clipAncestors) {
        const rect = ancestor.getBoundingClientRect();
        boundTop = Math.max(boundTop, rect.top);
        boundBottom = Math.min(boundBottom, rect.bottom);
      }
      const margin = 8;
      const triggerBox = trigger.getBoundingClientRect();
      const spaceAbove = triggerBox.top - boundTop - margin;
      const spaceBelow = boundBottom - triggerBox.bottom - margin;
      const nextPlacement =
        panel.scrollHeight <= spaceAbove || spaceAbove >= spaceBelow ? "up" : "down";
      setPlacement(nextPlacement);
      setPanelMaxBlockSize(
        Math.max(0, Math.floor(nextPlacement === "up" ? spaceAbove : spaceBelow)),
      );
    };
    // Resize events can fire before the shell's svh/container-query layout has
    // settled, so measuring synchronously reads mid-layout geometry. Defer each
    // measurement to the next frame, and let a ResizeObserver on the clip roots,
    // trigger, and panel re-measure whenever their boxes settle late.
    let scheduledFrame: number | undefined;
    const scheduleMeasure = () => {
      if (scheduledFrame !== undefined) {
        cancelAnimationFrame(scheduledFrame);
      }
      scheduledFrame = requestAnimationFrame(() => {
        scheduledFrame = undefined;
        measure();
      });
    };
    measure();

    const viewport = window.visualViewport;
    window.addEventListener("resize", scheduleMeasure);
    viewport?.addEventListener("resize", scheduleMeasure);
    viewport?.addEventListener("scroll", scheduleMeasure);
    for (const ancestor of clipAncestors) {
      ancestor.addEventListener("scroll", scheduleMeasure);
    }
    const observer =
      typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(scheduleMeasure);
    observer?.observe(trigger);
    observer?.observe(panel);
    for (const ancestor of clipAncestors) {
      observer?.observe(ancestor);
    }
    return () => {
      if (scheduledFrame !== undefined) {
        cancelAnimationFrame(scheduledFrame);
      }
      window.removeEventListener("resize", scheduleMeasure);
      viewport?.removeEventListener("resize", scheduleMeasure);
      viewport?.removeEventListener("scroll", scheduleMeasure);
      for (const ancestor of clipAncestors) {
        ancestor.removeEventListener("scroll", scheduleMeasure);
      }
      observer?.disconnect();
    };
  }, [open]);

  useDisclosureDismissal({
    close: (options) => {
      setOpen(false);
      if (options.restoreFocus) {
        restoreTriggerFocus();
      }
    },
    containerRef,
    open,
    triggerRef,
  });

  useEffect(() => {
    if (open && triggerLocked) {
      setOpen(false);
    }
  }, [open, triggerLocked]);

  return (
    <div className="model-tier-control" aria-busy={props.isPending || updatePending}>
      <div className="model-tier-disclosure" ref={containerRef}>
        <button
          aria-controls={popoverId}
          aria-describedby={status ? descriptionId : undefined}
          aria-disabled={updatePending || undefined}
          aria-expanded={open}
          aria-label={`${copy.conversations.modelTiers.label}: ${tierName}`}
          className="model-tier-trigger"
          disabled={triggerLocked}
          id={triggerId}
          ref={triggerRef}
          type="button"
          onClick={toggleDisclosure}
        >
          <span className="model-tier-trigger-name">{tierName}</span>
          <Icon name="chevron-down" />
        </button>
        {open ? (
          <div
            className="model-tier-popover"
            data-placement={placement}
            id={popoverId}
            ref={panelRef}
            style={
              panelMaxBlockSize === undefined
                ? undefined
                : { maxBlockSize: `${panelMaxBlockSize}px` }
            }
          >
            {MODEL_TIER_ORDER.map((tier) => {
              const state = props.policy?.tiers.find((candidate) => candidate.tier === tier);
              const available = Boolean(state?.enabled && state.available);
              const tierCopy = copy.conversations.modelTiers.tiers[tier];
              return (
                <button
                  aria-pressed={tier === displayTier}
                  className="model-tier-option"
                  disabled={!available}
                  key={tier}
                  type="button"
                  onClick={() => chooseTier(tier)}
                >
                  <span className="model-tier-option-name">
                    {`${tierCopy.name}${
                      available || !props.policy
                        ? ""
                        : ` — ${copy.conversations.modelTiers.optionUnavailable}`
                    }`}
                  </span>
                  {tier === displayTier ? (
                    <span className="model-tier-option-check">
                      <Icon name="check" />
                    </span>
                  ) : null}
                  <span className="model-tier-option-purpose">{tierCopy.purpose}</span>
                </button>
              );
            })}
          </div>
        ) : null}
      </div>
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

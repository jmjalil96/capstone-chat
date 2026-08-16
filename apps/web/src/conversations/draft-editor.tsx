import type {
  ConversationPreferredTierResponse,
  DraftScope,
  GenerationModelTier,
} from "@capstone/protocol";
import { useQueryClient } from "@tanstack/react-query";
import {
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { copy } from "../copy";
import { ConversationApiError, conversationQueryKeys, createConversation } from "./api";
import {
  ChatRuntimeError,
  type ChatRuntimePhase,
  isActiveRuntimePhase,
  type RemoteGeneration,
} from "./chat-runtime";
import { useOptionalChatRuntime, useOptionalConversationRuntime } from "./chat-runtime-provider";
import type { ContentValidationIssue } from "./content-validation";
import { useDraftMemory, useServerDraft } from "./draft-memory";
import { useConversationRequestLifetime } from "./request-lifetime";
import { useMobileShell } from "./use-mobile-shell";

export type DraftEditorComposer =
  | {
      readonly kind: "new";
      readonly onConversationCreated: (conversationId: string) => void;
    }
  | {
      readonly kind: "conversation";
      readonly conversationId: string;
      readonly isCoherent: boolean;
      readonly isRefreshing: boolean;
      readonly isArchived: boolean;
      readonly observedRevision: number;
      readonly parentMessageId: string | null;
      readonly remoteGeneration?: RemoteGeneration;
      readonly remoteOutcome?: RemoteResponseOutcome;
    };

export type RemoteResponseOutcome =
  | "cancelled"
  | "completed"
  | "content-filter"
  | "failed"
  | "incomplete"
  | "length"
  | "refusal";

interface DraftEditorProps {
  readonly autoFocus?: boolean;
  readonly composer?: DraftEditorComposer;
  readonly focusRequest?: number;
  readonly modelTier?: GenerationModelTier | undefined;
  readonly scope: DraftScope;
  readonly tierAvailable?: boolean;
  readonly tierControl?: ReactNode;
  readonly tierSavePending?: boolean;
}

function isActivePhase(phase: ChatRuntimePhase | undefined): boolean {
  return isActiveRuntimePhase(phase) || phase === "stopping";
}

export function generationErrorCodeCopy(code: string | undefined): string {
  switch (code) {
    case "CONVERSATION_ARCHIVED":
      return copy.conversations.generation.errors.archived;
    case "CONVERSATION_CHANGED":
      return copy.conversations.generation.errors.conversationChanged;
    case "DRAFT_CHANGED":
      return copy.conversations.generation.errors.draftChanged;
    case "GENERATION_ACTIVE":
      return copy.conversations.generation.errors.active;
    case "MESSAGE_TOO_LARGE":
    case "PAYLOAD_TOO_LARGE":
      return copy.conversations.generation.errors.tooLarge;
    case "TIER_UNAVAILABLE":
      return copy.conversations.generation.errors.tierUnavailable;
    case "EMPLOYEE_GENERATION_LIMIT_REACHED":
      return copy.conversations.generation.errors.generationLimit;
    case "WORKSPACE_BUDGET_EXCEEDED":
      return copy.conversations.generation.errors.workspaceBudget;
    default:
      return copy.conversations.generation.errors.generic;
  }
}

function requestErrorCopy(error: unknown): string {
  if (error instanceof ConversationApiError) {
    return generationErrorCodeCopy(error.code);
  }
  if (error instanceof ChatRuntimeError) {
    return error.code === "GENERATION_ACTIVE"
      ? copy.conversations.generation.errors.active
      : copy.conversations.generation.errors.ambiguous;
  }
  return generationErrorCodeCopy(undefined);
}

function runtimeStatus(phase: ChatRuntimePhase | undefined): string | undefined {
  switch (phase) {
    case "starting":
      return copy.conversations.generation.status.starting;
    case "generating":
      return copy.conversations.generation.status.generating;
    case "compacting":
      return copy.conversations.generation.status.compacting;
    case "reattaching":
      return copy.conversations.generation.status.reattaching;
    case "naming":
      return copy.conversations.generation.status.naming;
    case "stopping":
      return copy.conversations.generation.status.stopping;
    case "completed":
      return copy.conversations.generation.status.completed;
    case "cancelled":
      return copy.conversations.generation.status.cancelled;
    case "interrupted":
      return copy.conversations.generation.status.interrupted;
    case "protocol-failure":
      return copy.conversations.generation.status.protocolFailure;
    case "failed":
      return copy.conversations.generation.status.failed;
    case "output-limit":
      return copy.conversations.generation.status.outputLimit;
    default:
      return undefined;
  }
}

function remoteOutcomeStatus(outcome: RemoteResponseOutcome | undefined): string | undefined {
  switch (outcome) {
    case "completed":
      return copy.conversations.generation.status.completed;
    case "cancelled":
      return copy.conversations.generation.status.cancelled;
    case "incomplete":
      return copy.conversations.generation.status.interrupted;
    case "failed":
      return copy.conversations.generation.status.failed;
    case "length":
      return copy.conversations.generation.status.outputLimit;
    case "refusal":
      return copy.conversations.generation.terminal.refusal;
    case "content-filter":
      return copy.conversations.generation.terminal.contentFilter;
    default:
      return undefined;
  }
}

function draftValidationCopy(issue: ContentValidationIssue): string {
  return issue === "too-large"
    ? copy.conversations.draft.tooLarge
    : copy.conversations.draft.invalidText;
}

export function DraftEditor({
  autoFocus = false,
  composer,
  focusRequest = 0,
  modelTier,
  scope,
  tierAvailable = false,
  tierControl,
  tierSavePending = false,
}: DraftEditorProps) {
  const draft = useServerDraft(scope);
  const memory = useDraftMemory();
  const queryClient = useQueryClient();
  const runtime = useOptionalChatRuntime();
  const conversationId = composer?.kind === "conversation" ? composer.conversationId : undefined;
  const runtimeSnapshot = useOptionalConversationRuntime(conversationId);
  const requestLifetime = useConversationRequestLifetime(`composer:${conversationId ?? "new"}`);
  const mobile = useMobileShell();
  const conflictRef = useRef<HTMLElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const sendLockRef = useRef(false);
  const sendConfirmedRef = useRef(false);
  const awaitingCanonicalRef = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  const [sendConfirmed, setSendConfirmed] = useState(false);
  const [sendError, setSendError] = useState<string>();

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea || textarea.value !== draft.content) {
      return;
    }
    textarea.style.height = "0px";
    textarea.style.height = `${textarea.scrollHeight}px`;
  }, [draft.content]);

  useEffect(() => {
    if (draft.conflict) {
      conflictRef.current?.focus();
    }
  }, [draft.conflict]);

  useEffect(() => {
    if (awaitingCanonicalRef.current && !runtimeSnapshot?.awaitingCanonical) {
      setSendError(undefined);
    }
    awaitingCanonicalRef.current = runtimeSnapshot?.awaitingCanonical ?? false;
  }, [runtimeSnapshot?.awaitingCanonical]);

  useEffect(() => {
    if ((autoFocus || focusRequest > 0) && !draft.isLoading && !draft.loadError) {
      textareaRef.current?.focus();
      textareaRef.current?.scrollIntoView?.({ block: "nearest" });
    }
  }, [autoFocus, draft.isLoading, draft.loadError, focusRequest]);

  const localActive = isActivePhase(runtimeSnapshot?.phase);
  const remoteGeneration =
    localActive || composer?.kind !== "conversation" ? undefined : composer.remoteGeneration;
  const stopping = runtimeSnapshot?.phase === "stopping";
  const activeGeneration =
    runtimeSnapshot?.generationId && runtimeSnapshot.messageId && localActive
      ? {
          generationId: runtimeSnapshot.generationId,
          messageId: runtimeSnapshot.messageId,
        }
      : remoteGeneration;
  const generationActive = localActive || Boolean(remoteGeneration);

  const submit = useCallback(async () => {
    if (
      !composer ||
      !runtime ||
      !modelTier ||
      !tierAvailable ||
      tierSavePending ||
      sendLockRef.current ||
      generationActive ||
      draft.isLoading ||
      draft.loadError ||
      draft.interactionLocked ||
      draft.validationIssue ||
      draft.content.trim().length === 0 ||
      (composer.kind === "conversation" && !composer.isCoherent) ||
      (composer.kind === "conversation" && composer.isArchived)
    ) {
      return;
    }
    sendLockRef.current = true;
    setSubmitting(true);
    setSendError(undefined);
    const capture = requestLifetime.capture();
    let createdConversationId: string | undefined;
    try {
      const confirmed = await draft.confirmForSend();
      if (!capture.isCurrent() || !confirmed) {
        if (capture.isCurrent()) {
          setSendError(copy.conversations.generation.errors.draftSave);
        }
        return;
      }
      sendConfirmedRef.current = true;
      setSendConfirmed(true);

      if (composer.kind === "new") {
        let conversation: Awaited<ReturnType<typeof createConversation>>;
        try {
          conversation = await createConversation(
            { adoptNewDraftRevision: confirmed.revision },
            capture.signal,
          );
        } catch (error) {
          if (!(error instanceof ConversationApiError)) {
            void queryClient.invalidateQueries({
              queryKey: conversationQueryKeys.histories(memory.queryScope),
            });
            setSendError(copy.conversations.generation.errors.conversationAmbiguous);
            return;
          }
          throw error;
        }
        if (!capture.isCurrent()) {
          return;
        }
        createdConversationId = conversation.id;
        // Initialize the new conversation cache from the tier already selected by its page.
        queryClient.setQueryData<ConversationPreferredTierResponse>(
          conversationQueryKeys.preferredTier(memory.queryScope, conversation.id),
          { conversationId: conversation.id, modelTier },
        );
        const movedScope = { kind: "conversation", conversationId: conversation.id } as const;
        memory.moveDraftToConversation(conversation.id);
        void queryClient.invalidateQueries({
          queryKey: conversationQueryKeys.histories(memory.queryScope),
        });
        composer.onConversationCreated(conversation.id);
        await runtime.startResponse(
          conversation.id,
          {
            source: "draft",
            parentMessageId: null,
            content: [{ type: "text", text: confirmed.content }],
            modelTier,
            observedRevision: conversation.revision,
            draftRevision: confirmed.revision,
          },
          {
            onStarted: () => {
              memory.consumeDraft(movedScope, confirmed);
              textareaRef.current?.focus();
            },
          },
        );
        return;
      }

      await runtime.startResponse(
        composer.conversationId,
        {
          source: "draft",
          parentMessageId: composer.parentMessageId,
          content: [{ type: "text", text: confirmed.content }],
          modelTier,
          observedRevision: composer.observedRevision,
          draftRevision: confirmed.revision,
        },
        {
          onStarted: () => {
            memory.consumeDraft(scope, confirmed);
            textareaRef.current?.focus();
          },
        },
      );
    } catch (error) {
      if (capture.isCurrent()) {
        if (createdConversationId) {
          void queryClient.invalidateQueries({
            queryKey: conversationQueryKeys.preferredTier(memory.queryScope, createdConversationId),
          });
        }
        if (error instanceof ConversationApiError && error.code === "TIER_UNAVAILABLE") {
          void queryClient.invalidateQueries({
            queryKey: conversationQueryKeys.modelTierPolicy(memory.queryScope),
          });
        }
        setSendError(requestErrorCopy(error));
      }
    } finally {
      if (capture.isCurrent()) {
        setSubmitting(false);
        setSendConfirmed(false);
      }
      capture.release();
      sendLockRef.current = false;
      sendConfirmedRef.current = false;
    }
  }, [
    composer,
    draft,
    generationActive,
    memory,
    modelTier,
    queryClient,
    requestLifetime,
    runtime,
    scope,
    tierAvailable,
    tierSavePending,
  ]);

  const stop = useCallback(() => {
    if (!runtime || !conversationId || stopping || !activeGeneration) {
      return;
    }
    void runtime.stopResponse(conversationId, activeGeneration).finally(() => {
      if (!draft.isLoading && !draft.loadError) {
        textareaRef.current?.focus();
      }
    });
  }, [activeGeneration, conversationId, draft.isLoading, draft.loadError, runtime, stopping]);

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      event.key !== "Enter" ||
      event.shiftKey ||
      mobile ||
      event.nativeEvent.isComposing ||
      event.keyCode === 229
    ) {
      return;
    }
    event.preventDefault();
    if (!event.repeat) {
      void submit();
    }
  };

  const generationStatus = runtimeStatus(runtimeSnapshot?.phase);
  const remoteStatus =
    composer?.kind === "conversation" ? remoteOutcomeStatus(composer.remoteOutcome) : undefined;
  const activeLifecycleStatus = localActive
    ? generationStatus
    : remoteGeneration
      ? copy.conversations.generation.status.generating
      : undefined;
  const saveStatus = draft.isLoading
    ? copy.conversations.draft.loading
    : draft.validationIssue
      ? draftValidationCopy(draft.validationIssue)
      : draft.status === "conflict"
        ? copy.conversations.draft.conflictTitle
        : copy.conversations.draft[draft.status];
  const lifecycleStatus =
    composer?.kind === "conversation" && composer.isArchived
      ? copy.conversations.generation.status.archived
      : activeLifecycleStatus
        ? activeLifecycleStatus
        : composer?.kind === "conversation" && !composer.isCoherent
          ? composer.isRefreshing
            ? copy.conversations.generation.status.refreshing
            : undefined
          : (generationStatus ?? remoteStatus);
  const draftStatusImportance =
    !draft.isLoading && !draft.validationIssue && draft.status === "saved"
      ? "routine"
      : "important";
  const lifecycleStatusImportance =
    lifecycleStatus === copy.conversations.generation.status.completed ? "routine" : "important";
  const sendDisabled =
    !runtime ||
    !modelTier ||
    !tierAvailable ||
    tierSavePending ||
    submitting ||
    draft.isLoading ||
    draft.loadError ||
    draft.interactionLocked ||
    Boolean(draft.validationIssue) ||
    draft.content.trim().length === 0 ||
    (composer?.kind === "conversation" && !composer.isCoherent) ||
    (composer?.kind === "conversation" && composer.isArchived);

  return (
    <section className="draft-editor" aria-busy={draft.isLoading || submitting}>
      {draft.loadError ? (
        <div className="draft-load-error" role="alert">
          <p>{copy.conversations.common.genericError}</p>
          <button
            className="secondary-button compact-button"
            type="button"
            onClick={draft.retryLoad}
          >
            {copy.conversations.common.retry}
          </button>
        </div>
      ) : null}
      <label
        className="visually-hidden"
        htmlFor={`draft-${scope.kind === "new" ? "new" : scope.conversationId}`}
      >
        {copy.conversations.draft.label}
      </label>
      <div className="composer-control">
        <div className="composer-input-clip">
          <textarea
            ref={textareaRef}
            id={`draft-${scope.kind === "new" ? "new" : scope.conversationId}`}
            value={draft.content}
            onChange={(event) => {
              if (sendConfirmedRef.current) {
                return;
              }
              setSendError(undefined);
              draft.setContent(event.currentTarget.value);
            }}
            onKeyDown={handleKeyDown}
            placeholder={copy.conversations.draft.placeholder}
            rows={1}
            disabled={draft.isLoading || draft.loadError || draft.interactionLocked}
            readOnly={
              sendConfirmed ||
              (runtimeSnapshot?.phase === "starting" && runtimeSnapshot.consumesDraft)
            }
            aria-describedby="draft-save-status"
          />
        </div>
        {tierControl || composer ? (
          <div className="composer-footer">
            <div className="composer-tier-control">{tierControl}</div>
            {composer ? (
              generationActive ? (
                <button
                  className="composer-action secondary-button"
                  type="button"
                  disabled={stopping || !activeGeneration}
                  onClick={stop}
                >
                  {stopping
                    ? copy.conversations.generation.actions.stopping
                    : copy.conversations.generation.actions.stop}
                </button>
              ) : (
                <button
                  className="composer-action primary-button"
                  type="button"
                  disabled={sendDisabled}
                  onClick={() => void submit()}
                >
                  {submitting
                    ? copy.conversations.generation.actions.sending
                    : copy.conversations.generation.actions.send}
                </button>
              )
            ) : null}
          </div>
        ) : null}
      </div>
      <div className="draft-status-row">
        <div>
          <p
            id="draft-save-status"
            className="draft-save-status"
            data-importance={draftStatusImportance}
            role="status"
            aria-live="polite"
          >
            {saveStatus}
          </p>
          {lifecycleStatus ? (
            <p
              className="generation-status"
              data-importance={lifecycleStatusImportance}
              role="status"
              aria-live="polite"
            >
              {lifecycleStatus}
            </p>
          ) : null}
          {runtimeSnapshot?.contextWarning ? (
            <p
              className="generation-warning"
              data-importance="important"
              role="status"
              aria-live="polite"
            >
              {copy.conversations.generation.status.contextFallback}
            </p>
          ) : null}
        </div>
        {draft.status === "unsaved" && !draft.validationIssue ? (
          <button
            className="text-button"
            type="button"
            disabled={draft.interactionLocked}
            onClick={draft.retrySave}
          >
            {copy.conversations.draft.retry}
          </button>
        ) : null}
      </div>
      {sendError ? (
        <p className="inline-alert composer-alert" role="alert">
          {sendError}
        </p>
      ) : null}
      {draft.status === "conflict" ? (
        <section
          className="draft-conflict"
          ref={conflictRef}
          role="alert"
          tabIndex={-1}
          aria-labelledby="draft-conflict-title"
        >
          <h2 id="draft-conflict-title">{copy.conversations.draft.conflictTitle}</h2>
          <p>
            {draft.conflict
              ? copy.conversations.draft.conflictDescription
              : copy.conversations.draft.conflictLoadError}
          </p>
          {draft.conflict ? (
            <div className="dialog-actions">
              <button
                className="secondary-button compact-button"
                type="button"
                disabled={draft.interactionLocked}
                onClick={draft.acceptServer}
              >
                {copy.conversations.draft.keepServer}
              </button>
              <button
                className="primary-button compact-button"
                type="button"
                disabled={draft.interactionLocked}
                onClick={draft.replaceServer}
              >
                {copy.conversations.draft.replaceServer}
              </button>
            </div>
          ) : (
            <button
              className="secondary-button compact-button"
              type="button"
              disabled={draft.interactionLocked}
              onClick={draft.retryConflict}
            >
              {copy.conversations.draft.loadServer}
            </button>
          )}
        </section>
      ) : null}
    </section>
  );
}

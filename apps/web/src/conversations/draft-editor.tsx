import type { DraftScope } from "@capstone/protocol";
import { useQueryClient } from "@tanstack/react-query";
import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { copy } from "../copy";
import { ConversationApiError, conversationQueryKeys, createConversation } from "./api";
import { ChatRuntimeError, type ChatRuntimePhase, type RemoteGeneration } from "./chat-runtime";
import { useOptionalChatRuntime, useOptionalConversationRuntime } from "./chat-runtime-provider";
import { MOBILE_SHELL_MEDIA_QUERY } from "./config";
import { useDraftMemory, useServerDraft } from "./draft-memory";
import { useConversationRequestLifetime } from "./request-lifetime";

export type DraftEditorComposer =
  | {
      readonly kind: "new";
      readonly onConversationCreated: (conversationId: string) => void;
    }
  | {
      readonly kind: "conversation";
      readonly conversationId: string;
      readonly isCoherent: boolean;
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
  readonly scope: DraftScope;
}

function isActivePhase(phase: ChatRuntimePhase | undefined): boolean {
  return (
    phase === "starting" || phase === "generating" || phase === "compacting" || phase === "stopping"
  );
}

function useMobileShell(): boolean {
  const [mobile, setMobile] = useState(
    () => globalThis.matchMedia?.(MOBILE_SHELL_MEDIA_QUERY).matches ?? false,
  );

  useEffect(() => {
    const media = globalThis.matchMedia?.(MOBILE_SHELL_MEDIA_QUERY);
    if (!media) {
      return;
    }
    const update = () => setMobile(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  return mobile;
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

export function DraftEditor({
  autoFocus = false,
  composer,
  focusRequest = 0,
  scope,
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
      sendLockRef.current ||
      generationActive ||
      draft.isLoading ||
      draft.loadError ||
      draft.interactionLocked ||
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
            modelTier: "balanced",
            observedRevision: conversation.revision,
            draftRevision: confirmed.revision,
          },
          {
            onStarted: () => {
              memory.consumeDraft(movedScope);
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
          modelTier: "balanced",
          observedRevision: composer.observedRevision,
          draftRevision: confirmed.revision,
        },
        {
          onStarted: () => {
            memory.consumeDraft(scope);
            textareaRef.current?.focus();
          },
        },
      );
    } catch (error) {
      if (capture.isCurrent()) {
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
  }, [composer, draft, generationActive, memory, queryClient, requestLifetime, runtime, scope]);

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
  const saveStatus = draft.isLoading
    ? copy.conversations.draft.loading
    : draft.status === "conflict"
      ? copy.conversations.draft.conflictTitle
      : copy.conversations.draft[draft.status];
  const lifecycleStatus =
    composer?.kind === "conversation" && composer.isArchived
      ? copy.conversations.generation.status.archived
      : composer?.kind === "conversation" && !composer.isCoherent
        ? copy.conversations.generation.status.refreshing
        : (generationStatus ??
          (remoteGeneration ? copy.conversations.generation.status.generating : remoteStatus));
  const sendDisabled =
    !runtime ||
    submitting ||
    draft.isLoading ||
    draft.loadError ||
    draft.interactionLocked ||
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
      <div className="draft-status-row">
        <div>
          <p id="draft-save-status" className="draft-save-status" role="status" aria-live="polite">
            {saveStatus}
          </p>
          {lifecycleStatus ? (
            <p className="generation-status" role="status" aria-live="polite">
              {lifecycleStatus}
            </p>
          ) : null}
        </div>
        {draft.status === "unsaved" ? (
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

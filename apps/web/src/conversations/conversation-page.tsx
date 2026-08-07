import {
  type ConversationDetailResponse,
  type ConversationSummary,
  ConversationTitleSchema,
  type OpaqueCursor,
  type ResponseState,
} from "@capstone/protocol";
import {
  type InfiniteData,
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router";
import Value from "typebox/value";

import { copy } from "../copy";
import {
  archiveConversation,
  ConversationApiError,
  conversationQueryKeys,
  deleteConversation,
  fetchConversation,
  renameConversation,
  unarchiveConversation,
} from "./api";
import { useOptionalChatRuntime, useOptionalConversationRuntime } from "./chat-runtime-provider";
import { orderedBranchMessages } from "./collection";
import { DraftEditor, generationErrorCodeCopy, type RemoteResponseOutcome } from "./draft-editor";
import { useDraftMemory } from "./draft-memory";
import { Icon } from "./icons";
import {
  type ConversationRequestCapture,
  useConversationRequestLifetime,
} from "./request-lifetime";
import { useConversationResponseStates } from "./response-state";
import { useRouteHeading } from "./route-heading";

function openDialog(dialog: HTMLDialogElement | null): void {
  if (!dialog) {
    return;
  }
  if (typeof dialog.showModal === "function") {
    dialog.showModal();
  } else {
    dialog.setAttribute("open", "");
  }
}

function closeDialog(dialog: HTMLDialogElement | null): void {
  if (!dialog) {
    return;
  }
  if (typeof dialog.close === "function") {
    dialog.close();
  } else {
    dialog.removeAttribute("open");
  }
}

function responseTerminalLabel(state: ResponseState | undefined): string | undefined {
  if (!state || state.status === "active") {
    return undefined;
  }
  if (state.status === "cancelled") {
    return copy.conversations.generation.terminal.cancelled;
  }
  if (state.status === "incomplete") {
    return copy.conversations.generation.terminal.incomplete;
  }
  if (state.status === "failed") {
    return copy.conversations.generation.terminal.failed;
  }
  if (state.reason === "length") {
    return copy.conversations.generation.terminal.length;
  }
  if (state.reason === "refusal") {
    return copy.conversations.generation.terminal.refusal;
  }
  if (state.reason === "content_filter") {
    return copy.conversations.generation.terminal.contentFilter;
  }
  return undefined;
}

function remoteResponseOutcome(
  state: ResponseState | undefined,
): RemoteResponseOutcome | undefined {
  if (!state || state.status === "active") {
    return undefined;
  }
  if (state.status === "cancelled") {
    return "cancelled";
  }
  if (state.status === "incomplete") {
    return "incomplete";
  }
  if (state.status === "failed") {
    return "failed";
  }
  if (state.reason === "length") {
    return "length";
  }
  if (state.reason === "refusal") {
    return "refusal";
  }
  if (state.reason === "content_filter") {
    return "content-filter";
  }
  return "completed";
}

interface PaginationScrollAnchor {
  readonly conversationId: string;
  readonly height: number;
  readonly pageCount: number;
  readonly top: number;
}

interface ComposerFocusIntent {
  readonly conversationId: string;
  readonly request: number;
}

export function ConversationPage() {
  const { conversationId = "" } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const focusComposerOnArrival =
    typeof location.state === "object" &&
    location.state !== null &&
    "focusComposer" in location.state &&
    location.state.focusComposer === true;
  const queryClient = useQueryClient();
  const draftMemory = useDraftMemory();
  const runtime = useOptionalChatRuntime();
  const runtimeSnapshot = useOptionalConversationRuntime(conversationId);
  const queryScope = draftMemory.queryScope;
  const requestLifetime = useConversationRequestLifetime(`conversation:${conversationId}`);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const alertRef = useRef<HTMLParagraphElement>(null);
  const messageScrollRef = useRef<HTMLDivElement>(null);
  const previousScrollRef = useRef<PaginationScrollAnchor | undefined>(undefined);
  const initializedScrollRef = useRef(false);
  const positionedCanonicalRequestRef = useRef(0);
  const scrollConversationIdRef = useRef(conversationId);
  const positionedSentUserIdRef = useRef<string | undefined>(undefined);
  const focusedConversationRef = useRef<string | undefined>(undefined);
  const [mutationError, setMutationError] = useState<string>();
  const [canonicalRecoveryFailed, setCanonicalRecoveryFailed] = useState(false);
  const [canonicalRecoveryPending, setCanonicalRecoveryPending] = useState(false);
  const [canonicalPositionRequest, setCanonicalPositionRequest] = useState(0);
  const [composerFocusIntent, setComposerFocusIntent] = useState<ComposerFocusIntent>({
    conversationId,
    request: 0,
  });
  const [lifecycleRefreshPending, setLifecycleRefreshPending] = useState(false);
  const detail = useInfiniteQuery({
    queryKey: conversationQueryKeys.detail(queryScope, conversationId),
    queryFn: ({ pageParam, signal }) => fetchConversation(conversationId, pageParam, signal),
    initialPageParam: undefined as OpaqueCursor | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: conversationId.length > 0,
  });
  const firstPage = detail.data?.pages[0];
  const conversation = firstPage?.conversation;
  const messages = orderedBranchMessages(detail.data?.pages ?? []);
  const pageCount = detail.data?.pages.length ?? 0;
  const canonicalMessageIds = new Set(messages.map((message) => message.id));
  const runtimeUserId = runtimeSnapshot?.userMessageId;
  const presentsRuntimeUser = Boolean(
    runtimeUserId &&
      runtimeSnapshot?.committedUserText !== undefined &&
      !canonicalMessageIds.has(runtimeUserId),
  );
  const presentsRuntimeAssistant = Boolean(
    runtimeSnapshot?.messageId &&
      !canonicalMessageIds.has(runtimeSnapshot.messageId) &&
      runtimeUserId &&
      (canonicalMessageIds.has(runtimeUserId) || presentsRuntimeUser),
  );
  const presentedRuntimeUserId =
    runtimeUserId && (canonicalMessageIds.has(runtimeUserId) || presentsRuntimeUser)
      ? runtimeUserId
      : undefined;
  const presentedMessageCount =
    messages.length + Number(presentsRuntimeUser) + Number(presentsRuntimeAssistant);
  const assistantMessageIdPages = useMemo(() => {
    const pages =
      detail.data?.pages
        .map((page) =>
          page.messages
            .filter((message) => message.role === "assistant")
            .map((message) => message.id),
        )
        .filter((messageIds) => messageIds.length > 0) ?? [];
    const runtimeMessageId = runtimeSnapshot?.messageId;
    if (runtimeMessageId && !pages.some((messageIds) => messageIds.includes(runtimeMessageId))) {
      pages.push([runtimeMessageId]);
    }
    return pages;
  }, [detail.data?.pages, runtimeSnapshot?.messageId]);
  const responseStates = useConversationResponseStates(conversationId, assistantMessageIdPages);
  const remoteActive = [...responseStates.byMessageId.values()].find(
    (state) => state.status === "active",
  );
  const runtimeActive =
    runtimeSnapshot?.phase === "starting" ||
    runtimeSnapshot?.phase === "generating" ||
    runtimeSnapshot?.phase === "compacting" ||
    runtimeSnapshot?.phase === "stopping";
  const runtimeNeedsReconciliation = Boolean(
    runtimeSnapshot?.awaitingCanonical || (runtimeSnapshot?.messageId && !runtimeActive),
  );
  const generationActive = runtimeActive || Boolean(remoteActive);
  const generationError =
    runtimeSnapshot?.phase === "interrupted"
      ? copy.conversations.generation.status.interrupted
      : runtimeSnapshot?.phase === "protocol-failure"
        ? copy.conversations.generation.status.protocolFailure
        : runtimeSnapshot?.phase === "failed"
          ? runtimeSnapshot.messageId
            ? copy.conversations.generation.errors.committed
            : generationErrorCodeCopy(runtimeSnapshot.errorCode)
          : responseStates.isError && !runtimeActive
            ? copy.conversations.generation.errors.responseState
            : undefined;
  const hasPresentedMessages = presentedMessageCount > 0;
  const responseRevisionMismatch =
    Boolean(conversation) &&
    responseStates.revisions.some((revision) => revision !== conversation?.revision);
  const composerIncoherent =
    responseRevisionMismatch ||
    responseStates.isPending ||
    responseStates.isError ||
    runtimeNeedsReconciliation;
  const selectedResponseState = firstPage?.selectedLeafId
    ? responseStates.byMessageId.get(firstPage.selectedLeafId)
    : undefined;
  const selectedRemoteOutcome = remoteResponseOutcome(selectedResponseState);
  const branchCursorChanged =
    detail.isFetchNextPageError &&
    detail.error instanceof ConversationApiError &&
    detail.error.code === "CONVERSATION_CHANGED";
  const fatalDetailError = detail.isError && !conversation;
  const missingConversation =
    fatalDetailError && detail.error instanceof ConversationApiError && detail.error.status === 404;
  const displayTitle = conversation?.title ?? copy.conversations.common.untitled;
  const documentTitle = fatalDetailError
    ? missingConversation
      ? copy.conversations.conversation.notFoundTitle
      : copy.identity.route.unavailableTitle
    : displayTitle;
  useRouteHeading(documentTitle, headingRef, false);

  const recoverCanonical = useCallback(async () => {
    const capture = requestLifetime.capture();
    setCanonicalRecoveryPending(true);
    try {
      const canonical = await fetchConversation(conversationId, undefined, capture.signal);
      if (!capture.isCurrent()) {
        return false;
      }
      queryClient.setQueryData<InfiniteData<ConversationDetailResponse>>(
        conversationQueryKeys.detail(queryScope, conversationId),
        { pages: [canonical], pageParams: [undefined] },
      );
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: conversationQueryKeys.histories(queryScope) }),
        queryClient.invalidateQueries({ queryKey: conversationQueryKeys.searches(queryScope) }),
      ]);
      if (!capture.isCurrent()) {
        return false;
      }
      setCanonicalRecoveryFailed(false);
      setCanonicalPositionRequest((current) => current + 1);
      setMutationError(copy.conversations.common.changed);
      return true;
    } catch {
      if (!capture.isCurrent()) {
        return false;
      }
      setCanonicalRecoveryFailed(true);
      setMutationError(copy.conversations.common.genericError);
      return false;
    } finally {
      if (capture.isCurrent()) {
        setCanonicalRecoveryPending(false);
      }
      capture.release();
    }
  }, [conversationId, queryClient, queryScope, requestLifetime]);

  const refreshGenerationState = useCallback(async () => {
    const capture = requestLifetime.capture();
    setLifecycleRefreshPending(true);
    try {
      if (runtime && runtimeNeedsReconciliation) {
        await runtime.recoverConversation(conversationId);
      } else {
        await Promise.allSettled([
          detail.refetch(),
          queryClient.invalidateQueries({
            queryKey: conversationQueryKeys.responseStates(queryScope),
          }),
        ]);
      }
    } finally {
      if (capture.isCurrent()) {
        setLifecycleRefreshPending(false);
      }
      capture.release();
    }
  }, [
    conversationId,
    detail.refetch,
    queryClient,
    queryScope,
    requestLifetime,
    runtime,
    runtimeNeedsReconciliation,
  ]);

  useLayoutEffect(() => {
    if (scrollConversationIdRef.current !== conversationId) {
      scrollConversationIdRef.current = conversationId;
      initializedScrollRef.current = false;
      previousScrollRef.current = undefined;
      positionedSentUserIdRef.current = undefined;
      setCanonicalRecoveryFailed(false);
      setCanonicalRecoveryPending(false);
      setComposerFocusIntent({ conversationId, request: 0 });
      setLifecycleRefreshPending(false);
      setMutationError(undefined);
    }
  }, [conversationId]);

  useLayoutEffect(() => {
    const container = messageScrollRef.current;
    if (!container || presentedMessageCount === 0) {
      return;
    }
    const canonicalPositionRequested =
      positionedCanonicalRequestRef.current !== canonicalPositionRequest;
    if (canonicalPositionRequested) {
      positionedCanonicalRequestRef.current = canonicalPositionRequest;
    }

    if (presentedRuntimeUserId && positionedSentUserIdRef.current !== presentedRuntimeUserId) {
      const sentUser = [...container.querySelectorAll<HTMLElement>("[data-message-id]")].find(
        (element) => element.dataset.messageId === presentedRuntimeUserId,
      );
      if (sentUser) {
        previousScrollRef.current = undefined;
        sentUser.scrollIntoView?.({ behavior: "auto", block: "start" });
        positionedSentUserIdRef.current = presentedRuntimeUserId;
        initializedScrollRef.current = true;
        return;
      }
    }

    if (canonicalPositionRequested) {
      previousScrollRef.current = undefined;
      container.scrollTop = container.scrollHeight;
      initializedScrollRef.current = true;
      return;
    }

    const previous = previousScrollRef.current;
    if (previous && previous.conversationId !== conversationId) {
      previousScrollRef.current = undefined;
    } else if (previous && pageCount > previous.pageCount) {
      container.scrollTop = container.scrollHeight - previous.height + previous.top;
      previousScrollRef.current = undefined;
      initializedScrollRef.current = true;
    } else if (previous && !detail.isFetchingNextPage) {
      previousScrollRef.current = undefined;
    } else if (!initializedScrollRef.current) {
      container.scrollTop = container.scrollHeight;
      initializedScrollRef.current = true;
    }
  }, [
    conversationId,
    canonicalPositionRequest,
    detail.isFetchingNextPage,
    pageCount,
    presentedMessageCount,
    presentedRuntimeUserId,
  ]);

  useEffect(() => {
    if (conversation && focusedConversationRef.current !== conversation.id) {
      focusedConversationRef.current = conversation.id;
      if (!focusComposerOnArrival) {
        headingRef.current?.focus();
      }
    }
  }, [conversation, focusComposerOnArrival]);

  useEffect(() => {
    if (!conversation || !focusComposerOnArrival) {
      return;
    }
    navigate(location.pathname, { replace: true, state: null });
  }, [conversation, focusComposerOnArrival, location.pathname, navigate]);

  useEffect(() => {
    if (
      !conversation ||
      !responseRevisionMismatch ||
      runtimeNeedsReconciliation ||
      runtimeSnapshot?.messageId
    ) {
      return;
    }
    void Promise.all([
      detail.refetch(),
      queryClient.invalidateQueries({
        queryKey: conversationQueryKeys.responseStates(queryScope),
      }),
    ]);
  }, [
    conversation,
    detail.refetch,
    queryClient,
    queryScope,
    responseRevisionMismatch,
    runtimeNeedsReconciliation,
    runtimeSnapshot?.messageId,
  ]);

  useEffect(() => {
    if (!runtime || !runtimeSnapshot?.messageId || !runtimeNeedsReconciliation) {
      return;
    }
    const canonicalState = responseStates.byMessageId.get(runtimeSnapshot.messageId);
    const detailReachedRuntimeRevision =
      runtimeSnapshot.revision !== undefined &&
      conversation?.revision !== undefined &&
      conversation.revision >= runtimeSnapshot.revision;
    if ((canonicalState && canonicalState.status !== "active") || detailReachedRuntimeRevision) {
      void runtime.recoverConversation(conversationId);
    }
  }, [
    conversation?.revision,
    conversationId,
    responseStates.byMessageId,
    runtime,
    runtimeNeedsReconciliation,
    runtimeSnapshot,
  ]);

  useEffect(() => {
    if (fatalDetailError) {
      headingRef.current?.focus();
    }
  }, [fatalDetailError]);

  useEffect(() => {
    if (mutationError) {
      alertRef.current?.focus();
    }
  }, [mutationError]);

  useEffect(() => {
    if (!branchCursorChanged) {
      return;
    }

    previousScrollRef.current = undefined;
    initializedScrollRef.current = false;
    void recoverCanonical();
  }, [branchCursorChanged, recoverCanonical]);

  function adoptCanonical(summary: ConversationSummary) {
    queryClient.setQueryData<InfiniteData<ConversationDetailResponse>>(
      conversationQueryKeys.detail(queryScope, summary.id),
      (current) =>
        current
          ? {
              ...current,
              pages: current.pages.map((page) => ({ ...page, conversation: summary })),
            }
          : current,
    );
    void Promise.all([
      queryClient.invalidateQueries({ queryKey: conversationQueryKeys.histories(queryScope) }),
      queryClient.invalidateQueries({ queryKey: conversationQueryKeys.searches(queryScope) }),
      queryClient.invalidateQueries({ queryKey: conversationQueryKeys.responseStates(queryScope) }),
    ]);
    setCanonicalRecoveryFailed(false);
    setMutationError(undefined);
  }

  async function handleStale() {
    await recoverCanonical();
  }

  function continueResponse(messageId: string): void {
    if (
      !runtime ||
      !conversation ||
      generationActive ||
      conversation.isArchived ||
      composerIncoherent
    ) {
      return;
    }
    void runtime
      .startResponse(
        conversation.id,
        {
          source: "continue",
          parentMessageId: messageId,
          modelTier: "balanced",
          observedRevision: conversation.revision,
        },
        {
          onStarted: () => {
            if (scrollConversationIdRef.current !== conversation.id) {
              return;
            }
            setComposerFocusIntent((current) => ({
              conversationId: conversation.id,
              request: current.conversationId === conversation.id ? current.request + 1 : 1,
            }));
          },
        },
      )
      .catch(() => undefined);
  }

  if (detail.isPending) {
    return (
      <div className="route-loading" role="status">
        {copy.conversations.conversation.loading}
      </div>
    );
  }

  if (!conversation) {
    return (
      <div className="route-error">
        <h1 tabIndex={-1} ref={headingRef}>
          {missingConversation
            ? copy.conversations.conversation.notFoundTitle
            : copy.identity.route.unavailableTitle}
        </h1>
        <p>
          {missingConversation
            ? copy.conversations.conversation.notFound
            : copy.conversations.common.genericError}
        </p>
        <button className="primary-button" type="button" onClick={() => void detail.refetch()}>
          {copy.conversations.common.retry}
        </button>
      </div>
    );
  }

  return (
    <article className="conversation-page">
      <header className="conversation-header">
        <div>
          <p className="conversation-kicker">
            {conversation.isArchived ? copy.conversations.search.archived : copy.brand.productName}
          </p>
          <h1 ref={headingRef} tabIndex={-1}>
            {displayTitle}
          </h1>
        </div>
        <ConversationActions
          conversation={conversation}
          onCanonical={adoptCanonical}
          onError={setMutationError}
          onStale={handleStale}
        />
      </header>
      {mutationError || generationError || runtimeNeedsReconciliation ? (
        <div className="conversation-alert">
          {mutationError ? (
            <p className="inline-alert" ref={alertRef} role="alert" tabIndex={-1}>
              <span>{mutationError}</span>
              {canonicalRecoveryFailed ? (
                <button
                  className="text-button"
                  type="button"
                  disabled={canonicalRecoveryPending}
                  onClick={() => void recoverCanonical()}
                >
                  {copy.conversations.common.retry}
                </button>
              ) : null}
            </p>
          ) : null}
          {generationError ? (
            <p className="inline-alert" role="alert">
              <span>{generationError}</span>
              {runtimeNeedsReconciliation || responseStates.isError ? (
                <button
                  className="text-button"
                  type="button"
                  disabled={lifecycleRefreshPending}
                  onClick={() => void refreshGenerationState()}
                >
                  {copy.conversations.common.retry}
                </button>
              ) : null}
            </p>
          ) : null}
          {!generationError && runtimeNeedsReconciliation ? (
            <p className="inline-alert" role="status">
              <span>{copy.conversations.generation.status.refreshing}</span>
              <button
                className="text-button"
                type="button"
                disabled={lifecycleRefreshPending}
                onClick={() => void refreshGenerationState()}
              >
                {copy.conversations.common.retry}
              </button>
            </p>
          ) : null}
        </div>
      ) : null}
      {!hasPresentedMessages ? (
        <div className="empty-conversation">
          <h2>{copy.conversations.newChat.title}</h2>
          <p>{copy.conversations.conversation.empty}</p>
        </div>
      ) : (
        <div
          className="message-scroll"
          ref={messageScrollRef}
          onScroll={(event) => {
            if (
              event.currentTarget.scrollTop < 80 &&
              detail.hasNextPage &&
              !detail.isFetchingNextPage &&
              !detail.isFetchNextPageError
            ) {
              previousScrollRef.current = {
                conversationId,
                height: event.currentTarget.scrollHeight,
                pageCount,
                top: event.currentTarget.scrollTop,
              };
              void detail.fetchNextPage();
            }
          }}
        >
          {detail.isFetchNextPageError && !branchCursorChanged ? (
            <p className="inline-alert" role="alert">
              {copy.conversations.common.genericError}
            </p>
          ) : null}
          {detail.hasNextPage ? (
            <button
              className="message-more text-button"
              type="button"
              disabled={detail.isFetchingNextPage}
              onClick={() => {
                const container = messageScrollRef.current;
                if (container) {
                  previousScrollRef.current = {
                    conversationId,
                    height: container.scrollHeight,
                    pageCount,
                    top: container.scrollTop,
                  };
                }
                void detail.fetchNextPage();
              }}
            >
              {detail.isFetchingNextPage
                ? copy.conversations.common.loadingMore
                : copy.conversations.conversation.older}
            </button>
          ) : null}
          <ol className="message-list">
            {messages.map((message) => {
              const state = responseStates.byMessageId.get(message.id);
              const runtimeMatches = runtimeSnapshot?.messageId === message.id;
              const terminalLabel =
                responseTerminalLabel(state) ??
                (runtimeMatches && runtimeSnapshot.phase === "output-limit"
                  ? copy.conversations.generation.terminal.length
                  : runtimeMatches && runtimeSnapshot.phase === "cancelled"
                    ? copy.conversations.generation.terminal.cancelled
                    : runtimeMatches && runtimeSnapshot.phase === "interrupted"
                      ? copy.conversations.generation.terminal.incomplete
                      : undefined);
              const canContinue =
                message.id === firstPage?.selectedLeafId &&
                state?.status === "completed" &&
                state.reason === "length";
              return (
                <li
                  className={`message message-${message.role}`}
                  data-message-id={message.id}
                  key={message.id}
                >
                  <p className="message-role">
                    {message.role === "user"
                      ? copy.conversations.conversation.userLabel
                      : copy.conversations.conversation.assistantLabel}
                  </p>
                  <div className="message-content">
                    {runtimeMatches && runtimeSnapshot.text.length > 0
                      ? runtimeSnapshot.text
                      : message.content[0]?.text}
                  </div>
                  {terminalLabel ? <p className="response-outcome">{terminalLabel}</p> : null}
                  {canContinue ? (
                    <button
                      className="secondary-button compact-button response-continue"
                      type="button"
                      disabled={generationActive || conversation.isArchived || composerIncoherent}
                      onClick={() => continueResponse(message.id)}
                    >
                      {copy.conversations.generation.actions.continue}
                    </button>
                  ) : null}
                  {message.siblingCount > 0 ? (
                    <p className="message-alternatives">
                      {copy.conversations.conversation.alternatives(message.siblingCount)}
                    </p>
                  ) : null}
                </li>
              );
            })}
            {presentsRuntimeUser && runtimeUserId ? (
              <li
                className="message message-user"
                data-message-id={runtimeUserId}
                key={runtimeUserId}
              >
                <p className="message-role">{copy.conversations.conversation.userLabel}</p>
                <div className="message-content">{runtimeSnapshot?.committedUserText}</div>
              </li>
            ) : null}
            {presentsRuntimeAssistant && runtimeSnapshot?.messageId ? (
              <li
                className="message message-assistant"
                data-message-id={runtimeSnapshot.messageId}
                key={runtimeSnapshot.messageId}
              >
                <p className="message-role">{copy.conversations.conversation.assistantLabel}</p>
                <div className="message-content">{runtimeSnapshot.text}</div>
              </li>
            ) : null}
          </ol>
        </div>
      )}
      <div className="conversation-draft-dock" data-empty={!hasPresentedMessages}>
        <DraftEditor
          scope={{ kind: "conversation", conversationId }}
          composer={{
            kind: "conversation",
            conversationId,
            isCoherent: !composerIncoherent,
            isArchived: conversation.isArchived,
            observedRevision: conversation.revision,
            parentMessageId: firstPage?.selectedLeafId ?? null,
            ...(selectedRemoteOutcome ? { remoteOutcome: selectedRemoteOutcome } : {}),
            ...(remoteActive
              ? {
                  remoteGeneration: {
                    generationId: remoteActive.generationId,
                    messageId: remoteActive.messageId,
                  },
                }
              : {}),
          }}
          autoFocus={focusComposerOnArrival || !hasPresentedMessages}
          focusRequest={
            composerFocusIntent.conversationId === conversationId ? composerFocusIntent.request : 0
          }
        />
      </div>
    </article>
  );
}

interface ConversationActionsProps {
  readonly conversation: ConversationSummary;
  readonly onCanonical: (conversation: ConversationSummary) => void;
  readonly onError: (message: string) => void;
  readonly onStale: () => Promise<void>;
}

function ConversationActions({
  conversation,
  onCanonical,
  onError,
  onStale,
}: ConversationActionsProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const chatRuntime = useOptionalChatRuntime();
  const draftMemory = useDraftMemory();
  const captureGeneration = draftMemory.capture;
  const isGenerationCurrent = draftMemory.isCurrent;
  const queryScope = draftMemory.queryScope;
  const requestLifetime = useConversationRequestLifetime(`actions:${conversation.id}`);
  const renameDialogRef = useRef<HTMLDialogElement>(null);
  const deleteDialogRef = useRef<HTMLDialogElement>(null);
  const renameButtonRef = useRef<HTMLButtonElement>(null);
  const deleteButtonRef = useRef<HTMLButtonElement>(null);
  const renameCaptureRef = useRef<ConversationRequestCapture | undefined>(undefined);
  const archiveCaptureRef = useRef<ConversationRequestCapture | undefined>(undefined);
  const removeCaptureRef = useRef<AbortSignal | undefined>(undefined);
  const [title, setTitle] = useState(conversation.title ?? "");
  const [dialogError, setDialogError] = useState<string>();
  const titleValid = Value.Check(ConversationTitleSchema, title);

  useEffect(() => setTitle(conversation.title ?? ""), [conversation.title]);

  async function mutationFailure(error: unknown, inDialog: boolean, isCurrent: () => boolean) {
    if (!isCurrent()) {
      return;
    }
    if (error instanceof ConversationApiError && error.code === "CONVERSATION_CHANGED") {
      closeDialog(renameDialogRef.current);
      closeDialog(deleteDialogRef.current);
      await onStale();
      return;
    }
    if (inDialog) {
      setDialogError(copy.conversations.common.genericError);
    } else {
      onError(copy.conversations.common.genericError);
    }
  }

  const rename = useMutation({
    mutationFn: () => {
      if (!titleValid) {
        throw new Error("The conversation title is invalid.");
      }
      const capture = requestLifetime.capture();
      renameCaptureRef.current = capture;
      return renameConversation(
        conversation.id,
        {
          title,
          observedRevision: conversation.revision,
        },
        capture.signal,
      );
    },
    onSuccess: (canonical) => {
      const capture = renameCaptureRef.current;
      try {
        if (!capture?.isCurrent()) {
          return;
        }
        onCanonical(canonical);
        closeDialog(renameDialogRef.current);
      } finally {
        capture?.release();
        if (renameCaptureRef.current === capture) {
          renameCaptureRef.current = undefined;
        }
      }
    },
    onError: async (error) => {
      const capture = renameCaptureRef.current;
      try {
        if (capture) {
          await mutationFailure(error, true, capture.isCurrent);
        }
      } finally {
        capture?.release();
        if (renameCaptureRef.current === capture) {
          renameCaptureRef.current = undefined;
        }
      }
    },
  });
  const archive = useMutation({
    mutationFn: () => {
      const capture = requestLifetime.capture();
      archiveCaptureRef.current = capture;
      return conversation.isArchived
        ? unarchiveConversation(
            conversation.id,
            { observedRevision: conversation.revision },
            capture.signal,
          )
        : archiveConversation(
            conversation.id,
            { observedRevision: conversation.revision },
            capture.signal,
          );
    },
    onSuccess: (canonical) => {
      const capture = archiveCaptureRef.current;
      try {
        if (capture?.isCurrent()) {
          onCanonical(canonical);
        }
      } finally {
        capture?.release();
        if (archiveCaptureRef.current === capture) {
          archiveCaptureRef.current = undefined;
        }
      }
    },
    onError: async (error) => {
      const capture = archiveCaptureRef.current;
      try {
        if (capture) {
          await mutationFailure(error, false, capture.isCurrent);
        }
      } finally {
        capture?.release();
        if (archiveCaptureRef.current === capture) {
          archiveCaptureRef.current = undefined;
        }
      }
    },
  });
  const remove = useMutation({
    mutationFn: async () => {
      const capture = captureGeneration();
      removeCaptureRef.current = capture;
      // Deletion intentionally removes this draft, but no earlier save may finish after discard.
      await draftMemory.flushActiveDraft();
      if (!isGenerationCurrent(capture)) {
        throw new Error("session-changed");
      }
      return deleteConversation(
        conversation.id,
        { observedRevision: conversation.revision },
        capture,
      );
    },
    onSuccess: async () => {
      const capture = removeCaptureRef.current;
      if (!capture || !isGenerationCurrent(capture)) {
        return;
      }
      chatRuntime?.discardConversation(conversation.id);
      queryClient.removeQueries({
        queryKey: conversationQueryKeys.detail(queryScope, conversation.id),
      });
      queryClient.removeQueries({
        queryKey: conversationQueryKeys.draft(queryScope, {
          kind: "conversation",
          conversationId: conversation.id,
        }),
      });
      draftMemory.discardDraft({
        kind: "conversation",
        conversationId: conversation.id,
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: conversationQueryKeys.histories(queryScope) }),
        queryClient.invalidateQueries({ queryKey: conversationQueryKeys.searches(queryScope) }),
      ]);
      if (!isGenerationCurrent(capture)) {
        return;
      }
      draftMemory.unlockEditing();
      navigate("/", { replace: true });
    },
    onError: async (error) => {
      const capture = removeCaptureRef.current;
      if (!capture || !isGenerationCurrent(capture)) {
        return;
      }
      draftMemory.unlockEditing();
      await mutationFailure(error, true, () => isGenerationCurrent(capture));
    },
  });
  return (
    <fieldset className="conversation-actions">
      <legend className="visually-hidden">{copy.conversations.conversation.actions}</legend>
      <button
        className="secondary-button compact-button"
        ref={renameButtonRef}
        type="button"
        onClick={() => {
          setDialogError(undefined);
          setTitle(conversation.title ?? "");
          openDialog(renameDialogRef.current);
        }}
      >
        {copy.conversations.conversation.rename}
      </button>
      <button
        className="secondary-button compact-button"
        type="button"
        disabled={archive.isPending}
        onClick={() => archive.mutate()}
      >
        {conversation.isArchived
          ? copy.conversations.conversation.unarchive
          : copy.conversations.conversation.archive}
      </button>
      <button
        className="danger-button compact-button"
        ref={deleteButtonRef}
        type="button"
        onClick={() => {
          setDialogError(undefined);
          openDialog(deleteDialogRef.current);
        }}
      >
        <Icon name="trash" />
        {copy.conversations.conversation.delete}
      </button>

      <dialog
        className="action-dialog"
        ref={renameDialogRef}
        aria-labelledby="rename-dialog-title"
        onClose={() => renameButtonRef.current?.focus()}
      >
        <form
          method="dialog"
          onSubmit={(event) => {
            event.preventDefault();
            if (titleValid) {
              setDialogError(undefined);
              rename.mutate();
            }
          }}
        >
          <h2 id="rename-dialog-title">{copy.conversations.conversation.renameTitle}</h2>
          <label htmlFor="conversation-title">{copy.conversations.conversation.titleLabel}</label>
          <input
            id="conversation-title"
            value={title}
            onChange={(event) => setTitle(event.currentTarget.value)}
            aria-invalid={!titleValid}
            aria-describedby="conversation-title-help"
          />
          <p className="field-help" id="conversation-title-help">
            {copy.conversations.conversation.titleHelp}
          </p>
          {dialogError ? <p role="alert">{dialogError}</p> : null}
          <div className="dialog-actions">
            <button
              className="secondary-button compact-button"
              type="button"
              onClick={() => closeDialog(renameDialogRef.current)}
            >
              {copy.conversations.conversation.cancel}
            </button>
            <button
              className="primary-button compact-button"
              type="submit"
              disabled={!titleValid || rename.isPending}
            >
              {copy.conversations.conversation.saveTitle}
            </button>
          </div>
        </form>
      </dialog>

      <dialog
        className="action-dialog"
        ref={deleteDialogRef}
        aria-labelledby="delete-dialog-title"
        onCancel={(event) => {
          if (remove.isPending) {
            event.preventDefault();
          }
        }}
        onClose={() => deleteButtonRef.current?.focus()}
      >
        <h2 id="delete-dialog-title">{copy.conversations.conversation.deleteTitle}</h2>
        <p>{copy.conversations.conversation.deleteNotice}</p>
        {dialogError ? <p role="alert">{dialogError}</p> : null}
        <div className="dialog-actions">
          <button
            className="secondary-button compact-button"
            type="button"
            disabled={remove.isPending}
            onClick={() => closeDialog(deleteDialogRef.current)}
          >
            {copy.conversations.conversation.cancel}
          </button>
          <button
            className="danger-button compact-button"
            type="button"
            disabled={remove.isPending}
            onClick={() => {
              draftMemory.lockEditing();
              remove.mutate();
            }}
          >
            {remove.isPending
              ? copy.conversations.conversation.deleting
              : copy.conversations.conversation.confirmDelete}
          </button>
        </div>
      </dialog>
    </fieldset>
  );
}

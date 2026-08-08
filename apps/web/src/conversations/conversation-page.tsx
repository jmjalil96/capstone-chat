import {
  type ConversationDetailResponse,
  type ConversationMessage,
  type ConversationSelectionResponse,
  type ConversationSummary,
  ConversationTitleSchema,
  MessageIdSchema,
  type OpaqueCursor,
  type ResponseState,
} from "@capstone/protocol";
import {
  type InfiniteData,
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useLocation, useNavigate, useParams } from "react-router";
import Value from "typebox/value";

import { copy } from "../copy";
import { useConversationAlternativeContexts } from "./alternative-contexts";
import {
  archiveConversation,
  ConversationApiError,
  conversationQueryKeys,
  deleteConversation,
  fetchConversation,
  renameConversation,
  selectConversationLeaf,
  unarchiveConversation,
  undoConversation,
} from "./api";
import { useOptionalChatRuntime, useOptionalConversationRuntime } from "./chat-runtime-provider";
import { orderedBranchMessages } from "./collection";
import { SEARCH_MATCH_FADE_MS, SEARCH_MATCH_HOLD_MS } from "./config";
import { useConversationScroll } from "./conversation-scroll";
import { ConversationSelectionFence } from "./conversation-selection";
import { DraftEditor, generationErrorCodeCopy, type RemoteResponseOutcome } from "./draft-editor";
import { useDraftMemory } from "./draft-memory";
import { Icon } from "./icons";
import { CodeCopyAction, MessageActions } from "./message-actions";
import type { MessageContentProps } from "./message-content";
import {
  type ConversationRequestCapture,
  useConversationRequestLifetime,
} from "./request-lifetime";
import { useConversationResponseStates } from "./response-state";
import { useRouteHeading } from "./route-heading";

const MessageContent = lazy(() =>
  import("./message-content").then(({ MessageContent: component }) => ({ default: component })),
);

interface DeferredMessageContentProps extends MessageContentProps {
  readonly onReady: () => void;
}

function DeferredMessageContent({ onReady, ...props }: DeferredMessageContentProps) {
  useLayoutEffect(onReady, [onReady]);
  return <MessageContent {...props} />;
}

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

interface ComposerFocusIntent {
  readonly conversationId: string;
  readonly request: number;
}

interface SearchPositionIntent {
  readonly attempt: number;
  readonly conversationId: string;
  readonly messageId: string;
}

type SearchHighlightPhase = "hold" | "fade";

function matchedMessageIdFromRouteState(state: unknown): string | undefined {
  if (
    typeof state !== "object" ||
    state === null ||
    !("matchedMessageId" in state) ||
    !Value.Check(MessageIdSchema, state.matchedMessageId)
  ) {
    return undefined;
  }
  return state.matchedMessageId;
}

function renderCodeCopyAction(source: string) {
  return <CodeCopyAction source={source} />;
}

export function branchPresentationMessages(
  canonicalMessages: readonly ConversationMessage[],
  runtimeSnapshot: ReturnType<typeof useOptionalConversationRuntime>,
): ConversationMessage[] {
  if (
    !runtimeSnapshot?.messageId ||
    (runtimeSnapshot.requestSource !== "edit" && runtimeSnapshot.requestSource !== "retry") ||
    canonicalMessages.some((message) => message.id === runtimeSnapshot.messageId)
  ) {
    return [...canonicalMessages];
  }

  const anchor = runtimeSnapshot.branchAnchorMessageId;
  if (anchor === null) {
    return [];
  }
  const anchorIndex = canonicalMessages.findIndex((message) => message.id === anchor);
  return anchorIndex < 0 ? [] : canonicalMessages.slice(0, anchorIndex + 1);
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
  const matchedRouteMessageId = matchedMessageIdFromRouteState(location.state);
  const queryClient = useQueryClient();
  const draftMemory = useDraftMemory();
  const runtime = useOptionalChatRuntime();
  const runtimeSnapshot = useOptionalConversationRuntime(conversationId);
  const queryScope = draftMemory.queryScope;
  const requestLifetime = useConversationRequestLifetime(`conversation:${conversationId}`);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const alertRef = useRef<HTMLParagraphElement>(null);
  const mutationErrorFocusRef = useRef(true);
  const structuralFocusRestoreRef = useRef<HTMLButtonElement | undefined>(undefined);
  const currentConversationIdRef = useRef(conversationId);
  const consumedSearchLocationRef = useRef<string | undefined>(undefined);
  const handledSearchAttemptRef = useRef<string | undefined>(undefined);
  const focusedConversationRef = useRef<string | undefined>(undefined);
  const [mutationError, setMutationError] = useState<string>();
  const [mutationStatus, setMutationStatus] = useState<string>();
  const [renderedConversationId, setRenderedConversationId] = useState<string>();
  const [structuralPendingMessageId, setStructuralPendingMessageId] = useState<string>();
  const [canonicalRecoveryFailed, setCanonicalRecoveryFailed] = useState(false);
  const [canonicalRecoveryPending, setCanonicalRecoveryPending] = useState(false);
  const [canonicalPositionRequest, setCanonicalPositionRequest] = useState(0);
  const [searchHighlight, setSearchHighlight] = useState<{
    readonly messageId: string;
    readonly phase: SearchHighlightPhase;
  }>();
  const [searchPositionError, setSearchPositionError] = useState(false);
  const [searchPositionPending, setSearchPositionPending] = useState(false);
  const [searchPositionStatus, setSearchPositionStatus] = useState<string>();
  const [searchPositionIntent, setSearchPositionIntent] = useState<SearchPositionIntent>();
  const [composerFocusIntent, setComposerFocusIntent] = useState<ComposerFocusIntent>({
    conversationId,
    request: 0,
  });
  const [lifecycleRefreshPending, setLifecycleRefreshPending] = useState(false);
  const reportMutationError = useCallback((message: string, moveFocus = true) => {
    mutationErrorFocusRef.current = moveFocus;
    setMutationError(message);
  }, []);
  const detail = useInfiniteQuery({
    queryKey: conversationQueryKeys.detail(queryScope, conversationId),
    queryFn: ({ pageParam, signal }) => fetchConversation(conversationId, pageParam, signal),
    initialPageParam: undefined as OpaqueCursor | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: conversationId.length > 0,
  });
  const firstPage = detail.data?.pages[0];
  const conversation = firstPage?.conversation;
  const canonicalMessages = orderedBranchMessages(detail.data?.pages ?? []);
  const messages = branchPresentationMessages(canonicalMessages, runtimeSnapshot);
  const pageCount = detail.data?.pages.length ?? 0;
  const canonicalMessageIds = new Set(canonicalMessages.map((message) => message.id));
  const presentedCanonicalIds = new Set(messages.map((message) => message.id));
  const runtimeUserId = runtimeSnapshot?.userMessageId;
  const presentsRuntimeUser = Boolean(
    runtimeUserId &&
      runtimeSnapshot?.committedUserText !== undefined &&
      !presentedCanonicalIds.has(runtimeUserId),
  );
  const presentsRuntimeAssistant = Boolean(
    runtimeSnapshot?.messageId &&
      !canonicalMessageIds.has(runtimeSnapshot.messageId) &&
      runtimeUserId &&
      (presentedCanonicalIds.has(runtimeUserId) || presentsRuntimeUser),
  );
  const presentedRuntimeUserId =
    runtimeUserId && (presentedCanonicalIds.has(runtimeUserId) || presentsRuntimeUser)
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
  const alternativeContexts = useConversationAlternativeContexts(
    conversationId,
    conversation?.revision,
    detail.data?.pages ?? [],
  );
  const remoteActive = [...responseStates.byMessageId.values()].find(
    (state) => state.status === "active",
  );
  const runtimeResponseState = runtimeSnapshot?.messageId
    ? responseStates.byMessageId.get(runtimeSnapshot.messageId)
    : undefined;
  const runtimeActive =
    runtimeSnapshot?.phase === "starting" ||
    runtimeSnapshot?.phase === "generating" ||
    runtimeSnapshot?.phase === "compacting" ||
    runtimeSnapshot?.phase === "stopping";
  const runtimeNeedsReconciliation = Boolean(
    runtimeSnapshot?.awaitingCanonical ||
      (runtimeSnapshot?.messageId && !runtimeActive) ||
      (!runtimeSnapshot?.locallyOwned &&
        runtimeResponseState &&
        runtimeResponseState.status !== "active"),
  );
  const runtimeRecoveryActionRequired = Boolean(
    runtimeSnapshot?.awaitingCanonical || runtimeSnapshot?.recoveryRequired,
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
  const messageContentReady = !hasPresentedMessages || renderedConversationId === conversationId;
  const markMessageContentReady = useCallback(
    () => setRenderedConversationId(conversationId),
    [conversationId],
  );
  const responseRevisionMismatch =
    Boolean(conversation) &&
    responseStates.revisions.some((revision) => revision !== conversation?.revision);
  const composerIncoherent =
    responseRevisionMismatch ||
    responseStates.isPending ||
    responseStates.isError ||
    runtimeNeedsReconciliation;
  const composerRefreshing =
    !runtimeRecoveryActionRequired &&
    !responseStates.isError &&
    (responseRevisionMismatch || responseStates.isPending || runtimeNeedsReconciliation);
  const selectedResponseState = firstPage?.selectedLeafId
    ? responseStates.byMessageId.get(firstPage.selectedLeafId)
    : undefined;
  const selectedRemoteOutcome = remoteResponseOutcome(selectedResponseState);
  const searchRequestLifetime = useConversationRequestLifetime(
    `search-position:${conversationId}:${conversation?.revision ?? "loading"}:${searchPositionIntent?.attempt ?? 0}`,
  );
  const streamPublication = useMemo(
    () =>
      runtimeSnapshot?.messageId
        ? { messageId: runtimeSnapshot.messageId, text: runtimeSnapshot.text }
        : undefined,
    [runtimeSnapshot?.messageId, runtimeSnapshot?.text],
  );
  const conversationScroll = useConversationScroll({
    contentReady: messageContentReady,
    conversationId,
    isFetchingNextPage: detail.isFetchingNextPage || searchPositionPending,
    pageCount,
    positionRequest: canonicalPositionRequest,
    presentedMessageCount,
    sentUserMessageId: presentedRuntimeUserId,
    streamActive: runtimeActive,
    streamPublication,
  });
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

  const recoverCanonical = useCallback(
    async (moveErrorFocus = true) => {
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
          queryClient.invalidateQueries({
            queryKey: conversationQueryKeys.alternativeContexts(queryScope),
          }),
          queryClient.invalidateQueries({
            queryKey: conversationQueryKeys.responseStates(queryScope),
          }),
        ]);
        if (!capture.isCurrent()) {
          return false;
        }
        setCanonicalRecoveryFailed(false);
        setCanonicalPositionRequest((current) => current + 1);
        reportMutationError(copy.conversations.common.changed, moveErrorFocus);
        return true;
      } catch {
        if (!capture.isCurrent()) {
          return false;
        }
        setCanonicalRecoveryFailed(true);
        reportMutationError(copy.conversations.common.genericError, moveErrorFocus);
        return false;
      } finally {
        if (capture.isCurrent()) {
          setCanonicalRecoveryPending(false);
        }
        capture.release();
      }
    },
    [conversationId, queryClient, queryScope, reportMutationError, requestLifetime],
  );

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
    if (currentConversationIdRef.current !== conversationId) {
      currentConversationIdRef.current = conversationId;
      setCanonicalRecoveryFailed(false);
      setCanonicalRecoveryPending(false);
      setComposerFocusIntent({ conversationId, request: 0 });
      setLifecycleRefreshPending(false);
      setMutationError(undefined);
      setMutationStatus(undefined);
      setSearchHighlight(undefined);
      setSearchPositionError(false);
      setSearchPositionPending(false);
      setSearchPositionStatus(undefined);
      setStructuralPendingMessageId(undefined);
      if (searchPositionIntent?.conversationId !== conversationId) {
        setSearchPositionIntent(undefined);
      }
    }
  }, [conversationId, searchPositionIntent?.conversationId]);

  useLayoutEffect(() => {
    if (!matchedRouteMessageId || consumedSearchLocationRef.current === location.key) {
      return;
    }
    consumedSearchLocationRef.current = location.key;
    handledSearchAttemptRef.current = undefined;
    setSearchPositionIntent({ attempt: 0, conversationId, messageId: matchedRouteMessageId });
    setSearchPositionError(false);
    setSearchPositionStatus(undefined);
    navigate(location.pathname, { replace: true, state: null });
  }, [conversationId, location.key, location.pathname, matchedRouteMessageId, navigate]);

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
    if (
      !runtime ||
      !runtimeSnapshot?.messageId ||
      !runtimeNeedsReconciliation ||
      runtimeSnapshot.recoveryRequired
    ) {
      return;
    }
    const detailReachedRuntimeRevision =
      runtimeSnapshot.revision !== undefined &&
      conversation?.revision !== undefined &&
      conversation.revision >= runtimeSnapshot.revision;
    if (
      (runtimeResponseState && runtimeResponseState.status !== "active") ||
      detailReachedRuntimeRevision
    ) {
      void runtime.recoverConversation(conversationId);
    }
  }, [
    conversation?.revision,
    conversationId,
    runtime,
    runtimeNeedsReconciliation,
    runtimeResponseState,
    runtimeSnapshot,
  ]);

  useEffect(() => {
    if (fatalDetailError) {
      headingRef.current?.focus();
    }
  }, [fatalDetailError]);

  useEffect(() => {
    if (mutationError && mutationErrorFocusRef.current) {
      alertRef.current?.focus();
    }
  }, [mutationError]);

  useLayoutEffect(() => {
    if (structuralPendingMessageId || !structuralFocusRestoreRef.current) {
      return;
    }
    const trigger = structuralFocusRestoreRef.current;
    const focusKey = trigger.dataset.structuralFocusKey;
    const currentTrigger = focusKey
      ? [...document.querySelectorAll<HTMLButtonElement>("[data-structural-focus-key]")].find(
          (candidate) => candidate.dataset.structuralFocusKey === focusKey,
        )
      : undefined;
    if (trigger.isConnected && !trigger.disabled) {
      structuralFocusRestoreRef.current = undefined;
      trigger.focus();
    } else if (currentTrigger && !currentTrigger.disabled) {
      structuralFocusRestoreRef.current = undefined;
      currentTrigger.focus();
    } else if (alternativeContexts.isPending || composerRefreshing) {
      return;
    } else {
      structuralFocusRestoreRef.current = undefined;
      headingRef.current?.focus();
    }
  }, [alternativeContexts.isPending, composerRefreshing, structuralPendingMessageId]);

  useEffect(() => {
    if (!branchCursorChanged) {
      return;
    }
    void recoverCanonical();
  }, [branchCursorChanged, recoverCanonical]);

  useEffect(() => {
    if (!alternativeContexts.revisionMismatch || canonicalRecoveryPending) {
      return;
    }
    void recoverCanonical();
  }, [alternativeContexts.revisionMismatch, canonicalRecoveryPending, recoverCanonical]);

  useEffect(() => {
    const intent = searchPositionIntent;
    if (!intent || intent.conversationId !== conversationId || !conversation || !firstPage) {
      return;
    }
    const attemptKey = `${intent.conversationId}:${intent.messageId}:${intent.attempt}:${conversation.revision}`;
    if (handledSearchAttemptRef.current === attemptKey) {
      return;
    }
    handledSearchAttemptRef.current = attemptKey;
    const capture = searchRequestLifetime.capture();
    setSearchPositionPending(true);
    setSearchPositionError(false);
    setSearchPositionStatus(undefined);

    void (async () => {
      try {
        const detailKey = conversationQueryKeys.detail(queryScope, conversationId);
        const canonical =
          queryClient.getQueryData<InfiniteData<ConversationDetailResponse>>(detailKey);
        let targetPresent = canonical?.pages.some((page) =>
          page.messages.some((message) => message.id === intent.messageId),
        );
        let cursor = canonical?.pages.at(-1)?.nextCursor ?? firstPage.nextCursor;

        while (!targetPresent && cursor) {
          const page = await fetchConversation(conversationId, cursor, capture.signal);
          if (!capture.isCurrent() || page.conversation.revision !== conversation.revision) {
            return;
          }
          queryClient.setQueryData<InfiniteData<ConversationDetailResponse>>(
            detailKey,
            (current) => {
              if (
                !current ||
                current.pages[0]?.conversation.revision !== conversation.revision ||
                current.pageParams.includes(cursor)
              ) {
                return current;
              }
              return {
                pages: [...current.pages, page],
                pageParams: [...current.pageParams, cursor],
              };
            },
          );
          targetPresent = page.messages.some((message) => message.id === intent.messageId);
          cursor = page.nextCursor;
        }

        if (!capture.isCurrent()) {
          return;
        }
        if (!targetPresent) {
          setSearchPositionError(true);
          return;
        }
        setSearchHighlight({ messageId: intent.messageId, phase: "hold" });
        setSearchPositionStatus(copy.conversations.search.located);
        setSearchPositionIntent(undefined);
      } catch (error) {
        if (!capture.isCurrent()) {
          return;
        }
        if (error instanceof ConversationApiError && error.code === "CONVERSATION_CHANGED") {
          if (!(await recoverCanonical(false)) && capture.isCurrent()) {
            setSearchPositionError(true);
          }
        } else {
          setSearchPositionError(true);
        }
      } finally {
        if (capture.isCurrent()) {
          setSearchPositionPending(false);
        }
        capture.release();
      }
    })();
  }, [
    conversation,
    conversationId,
    firstPage,
    queryClient,
    queryScope,
    recoverCanonical,
    searchPositionIntent,
    searchRequestLifetime,
  ]);

  useLayoutEffect(() => {
    if (messageContentReady && searchHighlight?.phase === "hold") {
      conversationScroll.positionMessage(searchHighlight.messageId);
    }
  }, [conversationScroll.positionMessage, messageContentReady, searchHighlight]);

  useEffect(() => {
    if (!searchHighlight) {
      return;
    }
    if (searchHighlight.phase === "hold") {
      const timeout = window.setTimeout(
        () =>
          setSearchHighlight((current) =>
            current?.messageId === searchHighlight.messageId
              ? conversationScroll.reducedMotion
                ? undefined
                : { ...current, phase: "fade" }
              : current,
          ),
        SEARCH_MATCH_HOLD_MS,
      );
      return () => window.clearTimeout(timeout);
    }
    const timeout = window.setTimeout(() => setSearchHighlight(undefined), SEARCH_MATCH_FADE_MS);
    return () => window.clearTimeout(timeout);
  }, [conversationScroll.reducedMotion, searchHighlight]);

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

  function focusComposerAfterGeneration(): void {
    if (!conversation || currentConversationIdRef.current !== conversation.id) {
      return;
    }
    setComposerFocusIntent((current) => ({
      conversationId: conversation.id,
      request: current.conversationId === conversation.id ? current.request + 1 : 1,
    }));
  }

  async function adoptSelection(
    selection: ConversationSelectionResponse,
    capture: ConversationRequestCapture,
    status: string,
  ): Promise<void> {
    const canonical = await fetchConversation(selection.conversation.id, undefined, capture.signal);
    if (!capture.isCurrent()) {
      return;
    }
    queryClient.setQueryData<InfiniteData<ConversationDetailResponse>>(
      conversationQueryKeys.detail(queryScope, selection.conversation.id),
      { pages: [canonical], pageParams: [undefined] },
    );
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: conversationQueryKeys.histories(queryScope) }),
      queryClient.invalidateQueries({ queryKey: conversationQueryKeys.searches(queryScope) }),
      queryClient.invalidateQueries({
        queryKey: conversationQueryKeys.alternativeContexts(queryScope),
      }),
      queryClient.invalidateQueries({ queryKey: conversationQueryKeys.responseStates(queryScope) }),
    ]);
    if (!capture.isCurrent()) {
      return;
    }
    setCanonicalPositionRequest((current) => current + 1);
    setMutationError(undefined);
    setMutationStatus(status);
    headingRef.current?.focus();
  }

  async function selectAlternative(
    messageId: string,
    selectionTargetMessageId: string,
    trigger: HTMLButtonElement,
  ): Promise<void> {
    if (
      !conversation ||
      generationActive ||
      composerIncoherent ||
      alternativeContexts.revisionMismatch ||
      structuralPendingMessageId
    ) {
      return;
    }
    const capture = requestLifetime.capture();
    setStructuralPendingMessageId(messageId);
    setMutationError(undefined);
    setMutationStatus(undefined);
    try {
      const selection = await selectConversationLeaf(
        conversation.id,
        {
          leafMessageId: selectionTargetMessageId,
          observedRevision: conversation.revision,
        },
        capture.signal,
      );
      await adoptSelection(selection, capture, copy.conversations.messages.branchSelected);
    } catch (error) {
      if (capture.isCurrent()) {
        if (error instanceof ConversationApiError && error.code === "CONVERSATION_CHANGED") {
          structuralFocusRestoreRef.current = trigger;
          await recoverCanonical(false);
        } else {
          structuralFocusRestoreRef.current = trigger;
          reportMutationError(copy.conversations.messages.actionFailed, false);
        }
      }
    } finally {
      if (capture.isCurrent()) {
        setStructuralPendingMessageId(undefined);
      }
      capture.release();
    }
  }

  async function undoSelectedTurn(messageId: string, trigger: HTMLButtonElement): Promise<void> {
    if (!conversation || generationActive || composerIncoherent || structuralPendingMessageId) {
      return;
    }
    const capture = requestLifetime.capture();
    setStructuralPendingMessageId(messageId);
    setMutationError(undefined);
    setMutationStatus(undefined);
    try {
      const selection = await undoConversation(
        conversation.id,
        { observedRevision: conversation.revision },
        capture.signal,
      );
      await adoptSelection(selection, capture, copy.conversations.messages.turnUndone);
    } catch (error) {
      if (capture.isCurrent()) {
        if (error instanceof ConversationApiError && error.code === "CONVERSATION_CHANGED") {
          structuralFocusRestoreRef.current = trigger;
          await recoverCanonical(false);
        } else {
          structuralFocusRestoreRef.current = trigger;
          reportMutationError(copy.conversations.messages.actionFailed, false);
        }
      }
    } finally {
      if (capture.isCurrent()) {
        setStructuralPendingMessageId(undefined);
      }
      capture.release();
    }
  }

  async function editMessage(
    message: ConversationMessage,
    content: string,
    onCommitted: () => void,
  ): Promise<void> {
    if (
      !runtime ||
      !conversation ||
      message.role !== "user" ||
      generationActive ||
      conversation.isArchived ||
      composerIncoherent
    ) {
      throw new Error("The edit action is not currently available.");
    }
    try {
      await runtime.startResponse(
        conversation.id,
        {
          source: "edit",
          targetMessageId: message.id,
          parentMessageId: message.parentMessageId,
          content: [{ type: "text", text: content }],
          modelTier: "balanced",
          observedRevision: conversation.revision,
        },
        {
          onStarted: () => {
            if (currentConversationIdRef.current === conversation.id) {
              onCommitted();
              focusComposerAfterGeneration();
            }
          },
        },
      );
    } catch (error) {
      if (error instanceof ConversationApiError && error.code === "CONVERSATION_CHANGED") {
        await recoverCanonical();
      }
      throw error;
    }
  }

  function retryResponse(message: ConversationMessage): void {
    if (
      !runtime ||
      !conversation ||
      message.role !== "assistant" ||
      !message.parentMessageId ||
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
          source: "retry",
          targetMessageId: message.id,
          parentMessageId: message.parentMessageId,
          modelTier: "balanced",
          observedRevision: conversation.revision,
        },
        { onStarted: focusComposerAfterGeneration },
      )
      .catch((error: unknown) => {
        if (error instanceof ConversationApiError && error.code === "CONVERSATION_CHANGED") {
          void recoverCanonical();
        }
      });
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
        { onStarted: focusComposerAfterGeneration },
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
          onError={reportMutationError}
          onStale={handleStale}
        />
      </header>
      {mutationError ||
      generationError ||
      runtimeRecoveryActionRequired ||
      alternativeContexts.isError ||
      searchPositionError ||
      mutationStatus ? (
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
              {runtimeRecoveryActionRequired || responseStates.isError ? (
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
          {!generationError && runtimeRecoveryActionRequired ? (
            <p className="inline-alert" role="alert">
              <span>{copy.conversations.generation.errors.recovery}</span>
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
          {alternativeContexts.isError ? (
            <p className="inline-alert" role="alert">
              <span>{copy.conversations.messages.actionFailed}</span>
              <button
                className="text-button"
                type="button"
                onClick={() =>
                  void queryClient.invalidateQueries({
                    queryKey: conversationQueryKeys.alternativeContexts(queryScope),
                  })
                }
              >
                {copy.conversations.common.retry}
              </button>
            </p>
          ) : null}
          {searchPositionError ? (
            <p className="inline-alert" role="alert">
              <span>{copy.conversations.search.targetNotFound}</span>
              <button
                className="text-button"
                type="button"
                onClick={() => {
                  handledSearchAttemptRef.current = undefined;
                  setSearchPositionError(false);
                  setSearchPositionIntent((current) =>
                    current ? { ...current, attempt: current.attempt + 1 } : current,
                  );
                }}
              >
                {copy.conversations.search.retryTarget}
              </button>
            </p>
          ) : null}
          {mutationStatus ? (
            <p className="conversation-status" role="status">
              {mutationStatus}
            </p>
          ) : null}
        </div>
      ) : null}
      {searchPositionPending ? (
        <p className="visually-hidden" role="status">
          {copy.conversations.common.loadingMore}
        </p>
      ) : null}
      {searchPositionStatus ? (
        <p className="visually-hidden" role="status">
          {searchPositionStatus}
        </p>
      ) : null}
      {!hasPresentedMessages ? (
        <div className="empty-conversation">
          <h2>{copy.conversations.newChat.title}</h2>
          <p>{copy.conversations.conversation.empty}</p>
        </div>
      ) : (
        <div
          className="message-scroll"
          ref={conversationScroll.containerRef}
          onScroll={(event) => {
            conversationScroll.onScroll(event);
            if (
              event.currentTarget.scrollTop < 80 &&
              detail.hasNextPage &&
              !detail.isFetchingNextPage &&
              !detail.isFetchNextPageError &&
              !searchPositionPending
            ) {
              conversationScroll.captureOlderPageAnchor();
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
              disabled={detail.isFetchingNextPage || searchPositionPending}
              onClick={() => {
                conversationScroll.captureOlderPageAnchor();
                void detail.fetchNextPage();
              }}
            >
              {detail.isFetchingNextPage
                ? copy.conversations.common.loadingMore
                : copy.conversations.conversation.older}
            </button>
          ) : null}
          <ConversationSelectionFence
            containerRef={conversationScroll.containerRef}
            onSelectionSnapshot={conversationScroll.onSelectionSnapshot}
          />
          <ol className="message-list">
            {messages.map((message, messageIndex) => {
              const state = responseStates.byMessageId.get(message.id);
              const runtimeMatches = runtimeSnapshot?.messageId === message.id;
              const source =
                runtimeMatches && runtimeSnapshot.text.length > 0
                  ? runtimeSnapshot.text
                  : (message.content[0]?.text ?? "");
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
              const canUndo =
                message.id === firstPage?.selectedLeafId &&
                message.role === "assistant" &&
                messages.slice(0, messageIndex).some((candidate) => candidate.role === "assistant");
              const alternative = alternativeContexts.byMessageId.get(message.id);
              const highlighted = searchHighlight?.messageId === message.id;
              const contentStable =
                !(runtimeMatches && runtimeSnapshot !== undefined) &&
                (message.role === "user" || (!composerIncoherent && state?.status !== "active"));
              const structuralBlocked = Boolean(
                generationActive ||
                  composerIncoherent ||
                  alternativeContexts.revisionMismatch ||
                  structuralPendingMessageId,
              );
              return (
                <li
                  className={`message message-${message.role}${highlighted ? ` search-match search-match-${searchHighlight.phase}` : ""}`}
                  data-message-id={message.id}
                  key={message.id}
                >
                  <p className="message-role">
                    {message.role === "user"
                      ? copy.conversations.conversation.userLabel
                      : copy.conversations.conversation.assistantLabel}
                  </p>
                  <MessageActions
                    alternative={alternative}
                    canContinue={
                      canContinue &&
                      !generationActive &&
                      !conversation.isArchived &&
                      !composerIncoherent
                    }
                    canCopy={contentStable}
                    canEdit={
                      message.role === "user" &&
                      !generationActive &&
                      !conversation.isArchived &&
                      !composerIncoherent
                    }
                    canRetry={
                      message.role === "assistant" &&
                      message.parentMessageId !== null &&
                      !generationActive &&
                      !conversation.isArchived &&
                      !composerIncoherent
                    }
                    canUndo={canUndo}
                    message={message}
                    pending={structuralBlocked}
                    onContinue={() => continueResponse(message.id)}
                    onEdit={(content, onCommitted) => editMessage(message, content, onCommitted)}
                    onRetry={() => retryResponse(message)}
                    onSelectAlternative={(selectionTargetMessageId, trigger) =>
                      void selectAlternative(message.id, selectionTargetMessageId, trigger)
                    }
                    onUndo={(trigger) => void undoSelectedTurn(message.id, trigger)}
                  >
                    <Suspense fallback={null}>
                      <DeferredMessageContent
                        source={source}
                        fallback={copy.conversations.messages.markdownFallback}
                        onReady={markMessageContentReady}
                        overflowLabel={copy.conversations.messages.overflowLabel}
                        {...(contentStable ? { renderCodeAction: renderCodeCopyAction } : {})}
                      />
                    </Suspense>
                  </MessageActions>
                  {terminalLabel ? <p className="response-outcome">{terminalLabel}</p> : null}
                  {message.siblingCount > 0 && !alternative ? (
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
                <Suspense fallback={null}>
                  <DeferredMessageContent
                    source={runtimeSnapshot?.committedUserText ?? ""}
                    fallback={copy.conversations.messages.markdownFallback}
                    onReady={markMessageContentReady}
                    overflowLabel={copy.conversations.messages.overflowLabel}
                  />
                </Suspense>
              </li>
            ) : null}
            {presentsRuntimeAssistant && runtimeSnapshot?.messageId ? (
              <li
                className="message message-assistant"
                data-message-id={runtimeSnapshot.messageId}
                key={runtimeSnapshot.messageId}
              >
                <p className="message-role">{copy.conversations.conversation.assistantLabel}</p>
                <Suspense fallback={null}>
                  <DeferredMessageContent
                    source={runtimeSnapshot.text}
                    fallback={copy.conversations.messages.markdownFallback}
                    onReady={markMessageContentReady}
                    overflowLabel={copy.conversations.messages.overflowLabel}
                  />
                </Suspense>
              </li>
            ) : null}
          </ol>
        </div>
      )}
      {conversationScroll.unseen ? (
        <button
          className="secondary-button jump-to-latest"
          type="button"
          onClick={conversationScroll.jumpToLatest}
        >
          {copy.conversations.scroll.jumpToLatest}
          <span className="visually-hidden" role="status">
            {copy.conversations.scroll.newContent}
          </span>
        </button>
      ) : null}
      <div className="conversation-draft-dock" data-empty={!hasPresentedMessages}>
        <DraftEditor
          scope={{ kind: "conversation", conversationId }}
          composer={{
            kind: "conversation",
            conversationId,
            isCoherent: !composerIncoherent,
            isRefreshing: composerRefreshing,
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

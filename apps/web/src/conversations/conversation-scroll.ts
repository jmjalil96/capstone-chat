import { type UIEvent, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { CONVERSATION_FOLLOW_THRESHOLD_PX, PREFERS_REDUCED_MOTION_MEDIA_QUERY } from "./config";

function requestFrame(callback: FrameRequestCallback): number {
  if (typeof globalThis.requestAnimationFrame === "function") {
    return globalThis.requestAnimationFrame(callback);
  }
  return window.setTimeout(() => callback(globalThis.performance?.now() ?? Date.now()), 0);
}

function cancelFrame(frame: number): void {
  if (typeof globalThis.cancelAnimationFrame === "function") {
    globalThis.cancelAnimationFrame(frame);
    return;
  }
  window.clearTimeout(frame);
}

interface PaginationAnchor {
  readonly conversationId: string;
  readonly height: number;
  readonly pageCount: number;
  readonly top: number;
}

interface StreamPublication {
  readonly messageId: string;
  readonly text: string;
}

interface UseConversationScrollOptions {
  readonly contentReady: boolean;
  readonly conversationId: string;
  readonly isFetchingNextPage: boolean;
  readonly pageCount: number;
  readonly positionRequest: number;
  readonly presentedMessageCount: number;
  readonly sentUserMessageId: string | undefined;
  readonly streamActive: boolean;
  readonly streamPublication: StreamPublication | undefined;
}

export function distanceFromBottom(
  scrollHeight: number,
  scrollTop: number,
  clientHeight: number,
): number {
  return Math.max(0, scrollHeight - scrollTop - clientHeight);
}

export function wasNearBottomBeforeGrowth(
  previousScrollHeight: number,
  scrollTop: number,
  clientHeight: number,
): boolean {
  return (
    distanceFromBottom(previousScrollHeight, scrollTop, clientHeight) <=
    CONVERSATION_FOLLOW_THRESHOLD_PX
  );
}

function selectionIsInside(container: HTMLElement, selection: Selection): boolean {
  return Boolean(
    !selection.isCollapsed &&
      ((selection.anchorNode && container.contains(selection.anchorNode)) ||
        (selection.focusNode && container.contains(selection.focusNode))),
  );
}

function messageElement(container: HTMLElement, messageId: string): HTMLElement | undefined {
  return [...container.querySelectorAll<HTMLElement>("[data-message-id]")].find(
    (element) => element.dataset.messageId === messageId,
  );
}

export function useConversationScroll({
  contentReady,
  conversationId,
  isFetchingNextPage,
  pageCount,
  positionRequest,
  presentedMessageCount,
  sentUserMessageId,
  streamActive,
  streamPublication,
}: UseConversationScrollOptions) {
  const containerRef = useRef<HTMLDivElement>(null);
  const awaitingFirstPublicationRef = useRef(false);
  const conversationIdRef = useRef(conversationId);
  const followingRef = useRef(true);
  const initializedRef = useRef(false);
  const observedHeightRef = useRef(0);
  const paginationAnchorRef = useRef<PaginationAnchor | undefined>(undefined);
  const positionedRequestRef = useRef(positionRequest);
  const positionedSentUserRef = useRef<string | undefined>(undefined);
  const programmaticRef = useRef(false);
  const programmaticFrameRef = useRef<number | undefined>(undefined);
  const streamPublicationRef = useRef<StreamPublication | undefined>(undefined);
  const streamActiveRef = useRef(streamActive);
  streamActiveRef.current = streamActive;
  const [unseen, setUnseen] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(
    () => globalThis.matchMedia?.(PREFERS_REDUCED_MOTION_MEDIA_QUERY).matches ?? false,
  );

  const markProgrammatic = useCallback(() => {
    programmaticRef.current = true;
    if (programmaticFrameRef.current !== undefined) {
      cancelFrame(programmaticFrameRef.current);
    }
    programmaticFrameRef.current = requestFrame(() => {
      programmaticRef.current = false;
      programmaticFrameRef.current = undefined;
    });
  }, []);

  const engageFollowing = useCallback(() => {
    followingRef.current = true;
    setUnseen(false);
  }, []);

  useEffect(() => {
    const media = globalThis.matchMedia?.(PREFERS_REDUCED_MOTION_MEDIA_QUERY);
    if (!media) {
      return;
    }
    const update = () => setReducedMotion(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    const handleSelection = () => {
      const container = containerRef.current;
      const selection = document.getSelection();
      if (container && selection && selectionIsInside(container, selection)) {
        followingRef.current = false;
      }
    };
    document.addEventListener("selectionchange", handleSelection);
    return () => document.removeEventListener("selectionchange", handleSelection);
  }, []);

  useEffect(
    () => () => {
      if (programmaticFrameRef.current !== undefined) {
        cancelFrame(programmaticFrameRef.current);
      }
    },
    [],
  );

  // The message-list node can mount or be replaced while readiness remains true.
  // biome-ignore lint/correctness/useExhaustiveDependencies: Reattach to that concrete DOM lifecycle.
  useEffect(() => {
    const container = containerRef.current;
    const content = container?.querySelector<HTMLElement>(".message-list");
    if (!container || !content || !contentReady || typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(() => {
      const previousHeight = observedHeightRef.current;
      const nextHeight = container.scrollHeight;
      if (
        nextHeight > previousHeight &&
        streamActiveRef.current &&
        followingRef.current &&
        wasNearBottomBeforeGrowth(previousHeight, container.scrollTop, container.clientHeight)
      ) {
        markProgrammatic();
        container.scrollTop = nextHeight;
      }
      observedHeightRef.current = nextHeight;
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [contentReady, conversationId, markProgrammatic, presentedMessageCount]);

  useLayoutEffect(() => {
    if (conversationIdRef.current !== conversationId) {
      conversationIdRef.current = conversationId;
      followingRef.current = true;
      initializedRef.current = false;
      observedHeightRef.current = 0;
      paginationAnchorRef.current = undefined;
      positionedRequestRef.current = positionRequest;
      positionedSentUserRef.current = undefined;
      awaitingFirstPublicationRef.current = false;
      streamPublicationRef.current = undefined;
      setUnseen(false);
    }

    const container = containerRef.current;
    if (!container || presentedMessageCount === 0 || !contentReady) {
      return;
    }

    if (sentUserMessageId && positionedSentUserRef.current !== sentUserMessageId) {
      const sentUser = messageElement(container, sentUserMessageId);
      if (sentUser) {
        markProgrammatic();
        sentUser.scrollIntoView?.({ behavior: "auto", block: "start" });
        const minimumFollowTop = Math.max(
          0,
          container.scrollHeight - container.clientHeight - CONVERSATION_FOLLOW_THRESHOLD_PX,
        );
        if (container.scrollTop < minimumFollowTop) {
          container.scrollTop = minimumFollowTop;
        }
        positionedSentUserRef.current = sentUserMessageId;
        awaitingFirstPublicationRef.current = !streamPublication?.text;
        paginationAnchorRef.current = undefined;
        initializedRef.current = true;
        engageFollowing();
        observedHeightRef.current = container.scrollHeight;
        streamPublicationRef.current = streamPublication;
        return;
      }
    }

    if (positionedRequestRef.current !== positionRequest) {
      positionedRequestRef.current = positionRequest;
      markProgrammatic();
      container.scrollTop = container.scrollHeight;
      paginationAnchorRef.current = undefined;
      initializedRef.current = true;
      engageFollowing();
      observedHeightRef.current = container.scrollHeight;
      streamPublicationRef.current = streamPublication;
      return;
    }

    const anchor = paginationAnchorRef.current;
    if (anchor && anchor.conversationId !== conversationId) {
      paginationAnchorRef.current = undefined;
    } else if (anchor && pageCount > anchor.pageCount) {
      markProgrammatic();
      container.scrollTop = container.scrollHeight - anchor.height + anchor.top;
      paginationAnchorRef.current = undefined;
      initializedRef.current = true;
      observedHeightRef.current = container.scrollHeight;
      streamPublicationRef.current = streamPublication;
      return;
    } else if (anchor && !isFetchingNextPage) {
      paginationAnchorRef.current = undefined;
    }

    if (!initializedRef.current) {
      markProgrammatic();
      container.scrollTop = container.scrollHeight;
      initializedRef.current = true;
      engageFollowing();
      observedHeightRef.current = container.scrollHeight;
      streamPublicationRef.current = streamPublication;
      return;
    }

    const previousPublication = streamPublicationRef.current;
    const firstVisiblePublication = Boolean(
      awaitingFirstPublicationRef.current && streamPublication?.text,
    );
    const sourceGrew = Boolean(
      streamPublication &&
        ((previousPublication?.messageId === streamPublication.messageId &&
          previousPublication.text !== streamPublication.text) ||
          firstVisiblePublication),
    );
    if (sourceGrew) {
      if (firstVisiblePublication) {
        awaitingFirstPublicationRef.current = false;
      }
      const priorHeight = observedHeightRef.current;
      if (
        followingRef.current &&
        (firstVisiblePublication ||
          wasNearBottomBeforeGrowth(priorHeight, container.scrollTop, container.clientHeight))
      ) {
        markProgrammatic();
        container.scrollTop = container.scrollHeight;
      } else {
        followingRef.current = false;
        setUnseen(true);
      }
    }
    observedHeightRef.current = container.scrollHeight;
    streamPublicationRef.current = streamPublication;
  }, [
    contentReady,
    conversationId,
    engageFollowing,
    isFetchingNextPage,
    markProgrammatic,
    pageCount,
    positionRequest,
    presentedMessageCount,
    sentUserMessageId,
    streamPublication,
  ]);

  const captureOlderPageAnchor = useCallback(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    paginationAnchorRef.current = {
      conversationId: conversationIdRef.current,
      height: container.scrollHeight,
      pageCount,
      top: container.scrollTop,
    };
  }, [pageCount]);

  const onScroll = useCallback(
    (event: UIEvent<HTMLDivElement>) => {
      const container = event.currentTarget;
      observedHeightRef.current = container.scrollHeight;
      if (programmaticRef.current) {
        return;
      }
      const nearBottom =
        distanceFromBottom(container.scrollHeight, container.scrollTop, container.clientHeight) <=
        CONVERSATION_FOLLOW_THRESHOLD_PX;
      if (nearBottom) {
        engageFollowing();
      } else if (event.nativeEvent.isTrusted) {
        followingRef.current = false;
      }
    },
    [engageFollowing],
  );

  const positionMessage = useCallback(
    (messageId: string, block: ScrollLogicalPosition = "center"): boolean => {
      const container = containerRef.current;
      const message = container ? messageElement(container, messageId) : undefined;
      if (!container || !message) {
        return false;
      }
      markProgrammatic();
      message.scrollIntoView?.({ behavior: "auto", block });
      observedHeightRef.current = container.scrollHeight;
      return true;
    },
    [markProgrammatic],
  );

  const jumpToLatest = useCallback(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    markProgrammatic();
    if (typeof container.scrollTo === "function") {
      container.scrollTo({
        behavior: reducedMotion ? "auto" : "smooth",
        top: container.scrollHeight,
      });
    } else {
      container.scrollTop = container.scrollHeight;
    }
    observedHeightRef.current = container.scrollHeight;
    engageFollowing();
  }, [engageFollowing, markProgrammatic, reducedMotion]);

  return {
    captureOlderPageAnchor,
    containerRef,
    jumpToLatest,
    onScroll,
    positionMessage,
    reducedMotion,
    unseen,
  };
}

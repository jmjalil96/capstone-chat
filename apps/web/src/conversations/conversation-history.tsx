import type { ConversationView, OpaqueCursor } from "@capstone/protocol";
import { useInfiniteQuery } from "@tanstack/react-query";
import { NavLink } from "react-router";

import { copy } from "../copy";
import { conversationQueryKeys, fetchConversationHistory } from "./api";
import { uniqueConversations } from "./collection";
import { useDraftMemory } from "./draft-memory";

interface ConversationHistoryProps {
  readonly onNavigate?: () => void;
  readonly view: ConversationView;
}

export function ConversationHistory({ onNavigate, view }: ConversationHistoryProps) {
  const { queryScope } = useDraftMemory();
  const history = useInfiniteQuery({
    queryKey: conversationQueryKeys.history(queryScope, view),
    queryFn: ({ pageParam, signal }) => fetchConversationHistory(view, pageParam, signal),
    initialPageParam: undefined as OpaqueCursor | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const conversations = uniqueConversations(history.data?.pages ?? []);

  if (history.isPending) {
    return (
      <p className="history-status" role="status">
        {copy.conversations.common.loading}
      </p>
    );
  }

  if (history.isError && conversations.length === 0) {
    return (
      <div className="history-status" role="alert">
        <p>{copy.conversations.common.genericError}</p>
        <button className="text-button" type="button" onClick={() => void history.refetch()}>
          {copy.conversations.common.retry}
        </button>
      </div>
    );
  }

  if (conversations.length === 0) {
    return (
      <p className="history-status">
        {view === "archived" ? copy.conversations.archived.empty : copy.conversations.common.empty}
      </p>
    );
  }

  return (
    <div
      className="history-scroll"
      onScroll={(event) => {
        const element = event.currentTarget;
        if (
          history.hasNextPage &&
          !history.isFetchingNextPage &&
          !history.isFetchNextPageError &&
          element.scrollHeight - element.scrollTop - element.clientHeight < 48
        ) {
          void history.fetchNextPage();
        }
      }}
    >
      <ol className="conversation-history-list">
        {conversations.map((conversation) => (
          <li key={conversation.id}>
            <NavLink
              className={({ isActive }) => `history-link${isActive ? " is-active" : ""}`}
              to={`/c/${conversation.id}`}
              onClick={onNavigate}
              title={conversation.title ?? copy.conversations.common.untitled}
            >
              <span>{conversation.title ?? copy.conversations.common.untitled}</span>
            </NavLink>
          </li>
        ))}
      </ol>
      {history.isFetchNextPageError ? (
        <p className="history-status" role="alert">
          {copy.conversations.common.genericError}
        </p>
      ) : null}
      {history.hasNextPage ? (
        <button
          className="history-more text-button"
          type="button"
          disabled={history.isFetchingNextPage}
          onClick={() => void history.fetchNextPage()}
        >
          {history.isFetchingNextPage
            ? copy.conversations.common.loadingMore
            : copy.conversations.common.loadMore}
        </button>
      ) : null}
    </div>
  );
}

import type {
  ConversationDetailResponse,
  ConversationSearchResponse,
  ConversationSearchResult,
  OpaqueCursor,
} from "@capstone/protocol";
import {
  type InfiniteData,
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";

import { copy } from "../copy";
import {
  ConversationApiError,
  conversationQueryKeys,
  fetchConversation,
  searchConversations,
  selectConversationLeaf,
} from "./api";
import { SEARCH_DEBOUNCE_DELAY_MS } from "./config";
import { type ContentValidationIssue, searchContentValidationIssue } from "./content-validation";
import { useDraftMemory } from "./draft-memory";
import {
  type ConversationRequestCapture,
  useConversationRequestLifetime,
} from "./request-lifetime";
import { useRouteHeading } from "./route-heading";

function uniqueSearchResults(pages: readonly ConversationSearchResponse[]) {
  const keys = new Set<string>();
  return pages.flatMap((page) =>
    page.results.filter((result) => {
      const key = `${result.conversation.id}:${result.leafMessageId}:${result.matchedMessageId ?? "title"}`;
      if (keys.has(key)) {
        return false;
      }
      keys.add(key);
      return true;
    }),
  );
}

function snippetContent(result: ConversationSearchResult) {
  let offset = 0;
  return result.snippet.map((segment) => {
    const key = `${offset}:${segment.text}`;
    offset += Array.from(segment.text).length;
    return segment.highlighted ? (
      <mark key={key}>{segment.text}</mark>
    ) : (
      <span key={key}>{segment.text}</span>
    );
  });
}

interface OpenSearchResult {
  readonly capture: ConversationRequestCapture;
  readonly result: ConversationSearchResult;
}

function searchValidationCopy(issue: ContentValidationIssue): string {
  return issue === "too-large"
    ? copy.conversations.search.tooLarge
    : copy.conversations.search.invalidText;
}

export function SearchPage() {
  const [input, setInput] = useState("");
  const [query, setQuery] = useState("");
  const [openingError, setOpeningError] = useState<string>();
  const validationIssue = useMemo(() => searchContentValidationIssue(input), [input]);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const draftMemory = useDraftMemory();
  const queryScope = draftMemory.queryScope;
  const requestLifetime = useConversationRequestLifetime("search");
  useRouteHeading(copy.conversations.search.documentTitle, headingRef);

  useEffect(() => {
    if (validationIssue) {
      setQuery("");
      return;
    }
    const timeout = window.setTimeout(() => setQuery(input.trim()), SEARCH_DEBOUNCE_DELAY_MS);
    return () => window.clearTimeout(timeout);
  }, [input, validationIssue]);

  const search = useInfiniteQuery({
    queryKey: conversationQueryKeys.search(queryScope, query),
    queryFn: ({ pageParam, signal }) =>
      searchConversations({ query, ...(pageParam ? { cursor: pageParam } : {}) }, signal),
    initialPageParam: undefined as OpaqueCursor | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: query.length > 0,
  });
  const results = useMemo(() => uniqueSearchResults(search.data?.pages ?? []), [search.data]);
  const opening = useMutation({
    mutationFn: async ({ capture, result }: OpenSearchResult) => {
      if (!(await draftMemory.flushActiveDraft())) {
        throw new Error("draft-not-saved");
      }
      if (!capture.isCurrent()) {
        throw new Error("session-changed");
      }
      const selection = await selectConversationLeaf(
        result.conversation.id,
        {
          leafMessageId: result.leafMessageId,
          observedRevision: result.conversation.revision,
        },
        capture.signal,
      );
      if (!capture.isCurrent()) {
        throw new Error("session-changed");
      }
      const detailKey = conversationQueryKeys.detail(queryScope, selection.conversation.id);
      queryClient.removeQueries({ queryKey: detailKey, exact: true });
      const canonical = await fetchConversation(
        selection.conversation.id,
        undefined,
        capture.signal,
      );
      if (!capture.isCurrent()) {
        throw new Error("session-changed");
      }
      queryClient.setQueryData<InfiniteData<ConversationDetailResponse>>(detailKey, {
        pages: [canonical],
        pageParams: [undefined],
      });
      return selection;
    },
    onMutate: () => setOpeningError(undefined),
    onSuccess: async (selection, { capture, result }) => {
      if (!capture.isCurrent()) {
        return;
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: conversationQueryKeys.histories(queryScope) }),
        queryClient.invalidateQueries({ queryKey: conversationQueryKeys.searches(queryScope) }),
      ]);
      if (!capture.isCurrent()) {
        return;
      }
      navigate(`/c/${selection.conversation.id}`, {
        state:
          result.matchedMessageId === null ? null : { matchedMessageId: result.matchedMessageId },
      });
    },
    onError: async (error, { capture, result }) => {
      if (!capture.isCurrent()) {
        return;
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: conversationQueryKeys.histories(queryScope) }),
        queryClient.invalidateQueries({
          queryKey: conversationQueryKeys.detail(queryScope, result.conversation.id),
        }),
        queryClient.invalidateQueries({ queryKey: conversationQueryKeys.searches(queryScope) }),
      ]);
      if (!capture.isCurrent()) {
        return;
      }
      setOpeningError(
        error instanceof ConversationApiError && error.code === "CONVERSATION_CHANGED"
          ? copy.conversations.common.changed
          : copy.conversations.common.genericError,
      );
    },
    onSettled: (_selection, _error, { capture }) => capture.release(),
  });

  useEffect(() => {
    if (openingError) {
      errorRef.current?.focus();
    }
  }, [openingError]);

  return (
    <div className="collection-page search-page">
      <header className="collection-header">
        <h1 ref={headingRef} tabIndex={-1}>
          {copy.conversations.search.title}
        </h1>
        <p>{copy.conversations.search.description}</p>
      </header>
      <label className="search-label" htmlFor="conversation-search">
        {copy.conversations.search.label}
      </label>
      <input
        className="search-input"
        id="conversation-search"
        type="search"
        value={input}
        onChange={(event) => setInput(event.currentTarget.value)}
        placeholder={copy.conversations.search.placeholder}
        autoComplete="off"
        aria-describedby={validationIssue ? "conversation-search-validation" : undefined}
        aria-invalid={validationIssue ? true : undefined}
      />
      {validationIssue ? (
        <p id="conversation-search-validation" className="inline-alert" role="alert">
          {searchValidationCopy(validationIssue)}
        </p>
      ) : null}
      {openingError ? (
        <p className="inline-alert" ref={errorRef} role="alert" tabIndex={-1}>
          {openingError}
        </p>
      ) : null}
      <SearchResults
        query={query}
        results={results}
        isOpening={opening.isPending}
        search={search}
        openingId={opening.isPending ? opening.variables?.result.conversation.id : undefined}
        onOpen={(result) => opening.mutate({ capture: requestLifetime.capture(), result })}
      />
    </div>
  );
}

interface SearchResultsProps {
  readonly isOpening: boolean;
  readonly query: string;
  readonly results: readonly ConversationSearchResult[];
  readonly search: ReturnType<typeof useInfiniteQuery<ConversationSearchResponse, Error>>;
  readonly openingId: string | undefined;
  readonly onOpen: (result: ConversationSearchResult) => void;
}

function SearchResults({
  isOpening,
  openingId,
  onOpen,
  query,
  results,
  search,
}: SearchResultsProps) {
  if (!query) {
    return <p className="collection-empty">{copy.conversations.search.prompt}</p>;
  }
  if (search.isPending) {
    return (
      <p className="collection-empty" role="status">
        {copy.conversations.search.loading}
      </p>
    );
  }
  if (search.isError && results.length === 0) {
    return (
      <div className="collection-empty" role="alert">
        <p>{copy.conversations.common.genericError}</p>
        <button
          className="secondary-button compact-button"
          type="button"
          onClick={() => void search.refetch()}
        >
          {copy.conversations.common.retry}
        </button>
      </div>
    );
  }
  if (results.length === 0) {
    return <p className="collection-empty">{copy.conversations.search.empty}</p>;
  }

  return (
    <>
      <ol className="search-results">
        {results.map((result) => {
          const pending = openingId === result.conversation.id;
          return (
            <li
              key={`${result.conversation.id}:${result.leafMessageId}:${result.matchedMessageId ?? "title"}`}
            >
              <button type="button" disabled={isOpening} onClick={() => onOpen(result)}>
                <span className="search-result-header">
                  <strong>{result.conversation.title ?? copy.conversations.common.untitled}</strong>
                  {result.conversation.isArchived ? (
                    <span className="archive-badge">{copy.conversations.search.archived}</span>
                  ) : null}
                </span>
                <span className="search-match-kind">
                  {result.matchKind === "title"
                    ? copy.conversations.search.titleMatch
                    : copy.conversations.search.messageMatch}
                </span>
                <span className="search-snippet">{snippetContent(result)}</span>
                <span className="search-open-label">
                  {pending ? copy.conversations.search.opening : copy.conversations.search.open}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
      {search.isFetchNextPageError ? (
        <p className="inline-alert" role="alert">
          {copy.conversations.common.genericError}
        </p>
      ) : null}
      {search.hasNextPage ? (
        <button
          className="secondary-button compact-button collection-more"
          type="button"
          disabled={search.isFetchingNextPage}
          onClick={() => void search.fetchNextPage()}
        >
          {search.isFetchingNextPage
            ? copy.conversations.common.loadingMore
            : copy.conversations.common.loadMore}
        </button>
      ) : null}
    </>
  );
}

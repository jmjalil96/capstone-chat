import {
  ALTERNATIVE_CONTEXT_MAX_MESSAGE_IDS,
  type AlternativeContext,
  type ConversationDetailResponse,
} from "@capstone/protocol";
import { useQueries } from "@tanstack/react-query";
import { useMemo } from "react";

import { conversationQueryKeys, fetchAlternativeContexts } from "./api";
import { useDraftMemory } from "./draft-memory";

export interface ConversationAlternativeContexts {
  readonly byMessageId: ReadonlyMap<string, AlternativeContext>;
  readonly isError: boolean;
  readonly isPending: boolean;
  readonly revisionMismatch: boolean;
}

export function alternativeContextChunks(
  pages: readonly ConversationDetailResponse[],
): readonly (readonly string[])[] {
  const seen = new Set<string>();
  const chunks: string[][] = [];

  for (const page of pages) {
    const ids = page.messages
      .filter((message) => message.siblingCount > 0 && !seen.has(message.id))
      .map((message) => {
        seen.add(message.id);
        return message.id;
      })
      .sort();

    for (let offset = 0; offset < ids.length; offset += ALTERNATIVE_CONTEXT_MAX_MESSAGE_IDS) {
      chunks.push(ids.slice(offset, offset + ALTERNATIVE_CONTEXT_MAX_MESSAGE_IDS));
    }
  }

  return chunks;
}

export function useConversationAlternativeContexts(
  conversationId: string,
  revision: number | undefined,
  pages: readonly ConversationDetailResponse[],
): ConversationAlternativeContexts {
  const { queryScope } = useDraftMemory();
  const chunks = useMemo(() => alternativeContextChunks(pages), [pages]);
  const queries = useQueries({
    queries: chunks.map((messageIds) => ({
      queryKey: conversationQueryKeys.alternativeContext(
        queryScope,
        conversationId,
        revision ?? 0,
        messageIds,
      ),
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        fetchAlternativeContexts(conversationId, { messageIds: [...messageIds] }, signal),
      enabled: conversationId.length > 0 && revision !== undefined,
      retry: false,
    })),
  });
  const revisionMismatch = queries.some(
    ({ data }) => data !== undefined && data.revision !== revision,
  );
  const byMessageId = useMemo(
    () =>
      new Map(
        queries.flatMap(({ data }) =>
          data !== undefined && data.revision === revision
            ? data.contexts.map((context) => [context.messageId, context] as const)
            : [],
        ),
      ),
    [queries, revision],
  );

  return {
    byMessageId,
    isError: queries.some((query) => query.isError),
    isPending: chunks.length > 0 && queries.some((query) => query.isPending),
    revisionMismatch,
  };
}

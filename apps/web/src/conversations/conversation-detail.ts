import type { ConversationDetailResponse, OpaqueCursor } from "@capstone/protocol";
import { type InfiniteData, type QueryClient, useInfiniteQuery } from "@tanstack/react-query";

import { type ConversationQueryScope, conversationQueryKeys, fetchConversation } from "./api";
import { useDraftMemory } from "./draft-memory";

// Concurrent recoveries (page and shell) fetch canonical detail independently, so
// an older response can arrive last. Adoption must never move the cache backward:
// a canonical write whose revision is lower than the cached one is rejected, and
// the caller must skip its adoption side effects (re-anchor, notifications).
export function adoptCanonicalConversationDetail(
  queryClient: QueryClient,
  queryScope: ConversationQueryScope,
  canonical: ConversationDetailResponse,
): boolean {
  let adopted = false;
  queryClient.setQueryData<InfiniteData<ConversationDetailResponse>>(
    conversationQueryKeys.detail(queryScope, canonical.conversation.id),
    (current) => {
      const currentRevision = current?.pages[0]?.conversation.revision;
      if (currentRevision !== undefined && currentRevision > canonical.conversation.revision) {
        return current;
      }
      adopted = true;
      return { pages: [canonical], pageParams: [undefined] };
    },
  );
  return adopted;
}

export function useConversationDetail(conversationId: string | undefined) {
  const { queryScope } = useDraftMemory();
  const resolvedConversationId = conversationId ?? "";

  return useInfiniteQuery({
    queryKey: conversationQueryKeys.detail(queryScope, resolvedConversationId),
    queryFn: ({ pageParam, signal }) =>
      fetchConversation(resolvedConversationId, pageParam, signal),
    initialPageParam: undefined as OpaqueCursor | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: resolvedConversationId.length > 0,
  });
}

import type { ResponseState, ResponseStateResponse } from "@capstone/protocol";
import { type Query, useQueries, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";

import { ConversationApiError, conversationQueryKeys, fetchResponseStates } from "./api";
import { useOptionalConversationRuntime } from "./chat-runtime-provider";
import { RESPONSE_STATE_POLL_INTERVAL_MS } from "./config";
import { useDraftMemory } from "./draft-memory";

export interface ConversationResponseStates {
  readonly byMessageId: ReadonlyMap<string, ResponseState>;
  readonly isError: boolean;
  readonly isPending: boolean;
  readonly revisions: readonly number[];
}

export function useConversationResponseStates(
  conversationId: string,
  messageIdPages: readonly (readonly string[])[],
): ConversationResponseStates {
  const { queryScope } = useDraftMemory();
  const queryClient = useQueryClient();
  const localRuntime = useOptionalConversationRuntime(conversationId);
  const localGenerationActive =
    localRuntime?.locallyOwned === true &&
    (localRuntime.phase === "starting" ||
      localRuntime.phase === "generating" ||
      localRuntime.phase === "compacting" ||
      localRuntime.phase === "stopping");
  const requests = useMemo(
    () =>
      messageIdPages
        .map((messageIds) => [...new Set(messageIds)].sort())
        .filter((messageIds) => messageIds.length > 0),
    [messageIdPages],
  );
  const queries = useQueries({
    queries: requests.map((messageIds) => ({
      queryKey: conversationQueryKeys.responseState(queryScope, conversationId, messageIds),
      queryFn: async ({ signal }) => {
        try {
          return await fetchResponseStates(conversationId, { messageIds }, signal);
        } catch (error) {
          if (error instanceof ConversationApiError && error.status === 404) {
            return null;
          }
          throw error;
        }
      },
      enabled: conversationId.length > 0,
      refetchInterval: (current: Query<ResponseStateResponse | null>) =>
        !localGenerationActive &&
        document.visibilityState === "visible" &&
        current.state.data?.responses.some((state) => state.status === "active")
          ? RESPONSE_STATE_POLL_INTERVAL_MS
          : false,
      refetchOnWindowFocus: true,
      retry: false,
    })),
  });

  useEffect(() => {
    const refetchWhenVisible = () => {
      if (
        !localGenerationActive &&
        document.visibilityState === "visible" &&
        queries.some((query) => query.data?.responses.some((state) => state.status === "active"))
      ) {
        void queryClient.invalidateQueries({
          queryKey: conversationQueryKeys.responseStates(queryScope),
        });
      }
    };
    document.addEventListener("visibilitychange", refetchWhenVisible);
    return () => document.removeEventListener("visibilitychange", refetchWhenVisible);
  }, [localGenerationActive, queries, queryClient, queryScope]);

  const byMessageId = useMemo(
    () =>
      new Map(
        queries.flatMap(
          (query) => query.data?.responses.map((state) => [state.messageId, state] as const) ?? [],
        ),
      ),
    [queries],
  );
  const revisions = [...new Set(queries.flatMap((query) => query.data?.revision ?? []))];

  return {
    byMessageId,
    isError: queries.some((query) => query.isError),
    isPending: requests.length > 0 && queries.some((query) => query.isPending),
    revisions,
  };
}

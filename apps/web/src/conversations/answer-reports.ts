import {
  ANSWER_REPORT_STATE_MAX_MESSAGE_IDS,
  type AnswerReportStateResponse,
  type CreateAnswerReportRequest,
  type CreateAnswerReportResponse,
} from "@capstone/protocol";
import { type UseQueryResult, useQueries, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";

import {
  ConversationApiError,
  conversationQueryKeys,
  createAnswerReport,
  fetchAnswerReportStates,
} from "./api";
import { useDraftMemory } from "./draft-memory";

const noConfirmedMessageIds: ReadonlySet<string> = new Set();

interface AnswerReportQuerySnapshot {
  readonly data: readonly (AnswerReportStateResponse | null | undefined)[];
  readonly isError: boolean;
  readonly isFetching: boolean;
  readonly isPending: boolean;
  readonly succeeded: readonly boolean[];
}

function combineAnswerReportQueries(
  results: readonly UseQueryResult<AnswerReportStateResponse | null>[],
): AnswerReportQuerySnapshot {
  return {
    data: results.map((result) => result.data),
    isError: results.some((result) => result.isError),
    isFetching: results.some((result) => result.isFetching),
    isPending: results.some((result) => result.isPending),
    succeeded: results.map((result) => result.isSuccess),
  };
}

export interface ConversationAnswerReports {
  readonly isError: boolean;
  readonly isFetching: boolean;
  readonly isPending: boolean;
  readonly knownMessageIds: ReadonlySet<string>;
  readonly reportedMessageIds: ReadonlySet<string>;
  readonly report: (
    messageId: string,
    input: CreateAnswerReportRequest,
    signal?: AbortSignal,
  ) => Promise<CreateAnswerReportResponse>;
}

/**
 * Loads reported state for each bounded assistant-message page and records a new report in the
 * same cache so `Reportado` survives reloads and stays independent of generation state.
 */
export function useConversationAnswerReports(
  conversationId: string,
  messageIdPages: readonly (readonly string[])[],
): ConversationAnswerReports {
  const { queryScope } = useDraftMemory();
  const queryClient = useQueryClient();
  const confirmationScope = JSON.stringify([...queryScope, conversationId]);
  const [confirmation, setConfirmation] = useState<{
    readonly messageIds: ReadonlySet<string>;
    readonly scope: string;
  }>(() => ({ messageIds: new Set(), scope: confirmationScope }));
  const confirmedMessageIds =
    confirmation.scope === confirmationScope ? confirmation.messageIds : noConfirmedMessageIds;
  const requests = useMemo(
    () =>
      messageIdPages
        .map((messageIds) => [...new Set(messageIds)].sort())
        .filter((messageIds) => messageIds.length > 0)
        .flatMap((messageIds) => {
          const chunks: string[][] = [];
          for (
            let offset = 0;
            offset < messageIds.length;
            offset += ANSWER_REPORT_STATE_MAX_MESSAGE_IDS
          ) {
            chunks.push(messageIds.slice(offset, offset + ANSWER_REPORT_STATE_MAX_MESSAGE_IDS));
          }
          return chunks;
        }),
    [messageIdPages],
  );
  const querySnapshot = useQueries({
    queries: requests.map((messageIds) => ({
      queryKey: conversationQueryKeys.answerReportState(queryScope, conversationId, messageIds),
      queryFn: async ({ signal }: { signal: AbortSignal }) => {
        try {
          return await fetchAnswerReportStates(conversationId, { messageIds }, signal);
        } catch (error) {
          if (error instanceof ConversationApiError && error.status === 404) {
            return null;
          }
          throw error;
        }
      },
      enabled: conversationId.length > 0,
      refetchOnWindowFocus: true,
      retry: false,
    })),
    combine: combineAnswerReportQueries,
  });

  const knownMessageIds = useMemo(
    () =>
      new Set(
        querySnapshot.succeeded.flatMap((succeeded, index) =>
          succeeded && querySnapshot.data[index] !== null ? (requests[index] ?? []) : [],
        ),
      ),
    [querySnapshot.data, querySnapshot.succeeded, requests],
  );
  const reportedMessageIds = useMemo(
    () =>
      new Set([
        ...querySnapshot.data.flatMap((data) => data?.reportedMessageIds ?? []),
        ...confirmedMessageIds,
      ]),
    [confirmedMessageIds, querySnapshot.data],
  );

  const report = useCallback(
    async (messageId: string, input: CreateAnswerReportRequest, signal?: AbortSignal) => {
      const created = await createAnswerReport(conversationId, messageId, input, signal);
      setConfirmation((current) => ({
        messageIds: new Set(
          current.scope === confirmationScope ? current.messageIds : noConfirmedMessageIds,
        ).add(messageId),
        scope: confirmationScope,
      }));
      for (const requestedMessageIds of requests.filter((messageIds) =>
        messageIds.includes(messageId),
      )) {
        queryClient.setQueryData<AnswerReportStateResponse>(
          conversationQueryKeys.answerReportState(queryScope, conversationId, requestedMessageIds),
          (current) => ({
            conversationId,
            reportedMessageIds:
              current?.conversationId === conversationId &&
              current.reportedMessageIds.includes(messageId)
                ? current.reportedMessageIds
                : [
                    ...(current?.conversationId === conversationId
                      ? current.reportedMessageIds
                      : []),
                    messageId,
                  ],
          }),
        );
      }
      void queryClient.invalidateQueries({
        queryKey: conversationQueryKeys.answerReportStatesForConversation(
          queryScope,
          conversationId,
        ),
      });
      return created;
    },
    [confirmationScope, conversationId, queryClient, queryScope, requests],
  );

  return {
    isError: querySnapshot.isError,
    isFetching: querySnapshot.isFetching,
    isPending: requests.length > 0 && querySnapshot.isPending,
    knownMessageIds,
    report,
    reportedMessageIds,
  };
}

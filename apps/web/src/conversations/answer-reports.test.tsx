import { randomUUID } from "node:crypto";
import { ANSWER_REPORT_STATE_MAX_MESSAGE_IDS } from "@capstone/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useConversationAnswerReports } from "./answer-reports";
import { conversationQueryKeys } from "./api";
import { DraftMemoryProvider } from "./draft-memory";

const conversationId = "11111111-1111-4111-8111-111111111111";
const queryScope = ["workspace-1", "employee-1", "2026-08-15T12:00:00.000Z"] as const;

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    headers: { "content-type": "application/json" },
    status,
  });
}

function testContext() {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  function Wrapper({ children }: PropsWithChildren) {
    return (
      <QueryClientProvider client={queryClient}>
        <DraftMemoryProvider queryScope={queryScope}>{children}</DraftMemoryProvider>
      </QueryClientProvider>
    );
  }
  return { queryClient, Wrapper };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("conversation answer-report state", () => {
  it("chunks bounded state reads and confirms a submitted report immediately", async () => {
    const messageIds = Array.from({ length: ANSWER_REPORT_STATE_MAX_MESSAGE_IDS + 1 }, () =>
      randomUUID(),
    );
    const submittedMessageId = messageIds.at(-1);
    if (submittedMessageId === undefined) {
      throw new Error("Expected a report target");
    }
    const stateRequests: string[][] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith(`/api/conversations/${conversationId}/answer-report-states`)) {
        const body = JSON.parse(String(init?.body)) as { messageIds: string[] };
        stateRequests.push(body.messageIds);
        return json({
          conversationId,
          reportedMessageIds: body.messageIds.includes(messageIds[0] ?? "") ? [messageIds[0]] : [],
        });
      }
      if (
        url.endsWith(`/api/conversations/${conversationId}/messages/${submittedMessageId}/report`)
      ) {
        return json({
          createdAt: "2026-08-15T12:00:00.000Z",
          id: randomUUID(),
          messageId: submittedMessageId,
          repeated: false,
        });
      }
      throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const { Wrapper } = testContext();
    const pages = [messageIds] as const;
    const { rerender, result } = renderHook(
      () => useConversationAnswerReports(conversationId, pages),
      { wrapper: Wrapper },
    );

    expect(result.current.knownMessageIds.size).toBe(0);
    await waitFor(() => expect(result.current.isPending).toBe(false));
    expect(stateRequests.map((ids) => ids.length).sort((left, right) => left - right)).toEqual([
      1,
      ANSWER_REPORT_STATE_MAX_MESSAGE_IDS,
    ]);
    expect(result.current.knownMessageIds.size).toBe(messageIds.length);
    expect(result.current.reportedMessageIds.has(messageIds[0] ?? "")).toBe(true);
    const knownMessageIds = result.current.knownMessageIds;
    const reportedMessageIds = result.current.reportedMessageIds;
    rerender();
    expect(result.current.knownMessageIds).toBe(knownMessageIds);
    expect(result.current.reportedMessageIds).toBe(reportedMessageIds);

    await act(async () => {
      await result.current.report(submittedMessageId, {
        reason: "other",
        sharePromptAndAnswer: true,
      });
    });
    expect(result.current.reportedMessageIds.has(submittedMessageId)).toBe(true);
  });

  it("keeps report controls gated until failed state reads are explicitly retried", async () => {
    const messageId = randomUUID();
    let unavailable = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (!url.endsWith(`/api/conversations/${conversationId}/answer-report-states`)) {
          throw new Error(`Unexpected request: ${url}`);
        }
        return unavailable
          ? json({ code: "INTERNAL_ERROR", message: "unavailable", requestId: "request" }, 500)
          : json({ conversationId, reportedMessageIds: [] });
      }),
    );
    const { queryClient, Wrapper } = testContext();
    const { result } = renderHook(
      () => useConversationAnswerReports(conversationId, [[messageId]]),
      { wrapper: Wrapper },
    );

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.knownMessageIds.has(messageId)).toBe(false);

    unavailable = false;
    await act(async () => {
      await queryClient.invalidateQueries({
        queryKey: conversationQueryKeys.answerReportStatesForConversation(
          queryScope,
          conversationId,
        ),
      });
    });
    await waitFor(() => expect(result.current.knownMessageIds.has(messageId)).toBe(true));
    expect(result.current.isError).toBe(false);
  });

  it("seeds the exact state cache when report creation follows an errored state read", async () => {
    const messageId = randomUUID();
    const stateKey = conversationQueryKeys.answerReportState(queryScope, conversationId, [
      messageId,
    ]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith(`/api/conversations/${conversationId}/answer-report-states`)) {
          return json(
            { code: "INTERNAL_ERROR", message: "unavailable", requestId: "request-state" },
            500,
          );
        }
        if (url.endsWith(`/api/conversations/${conversationId}/messages/${messageId}/report`)) {
          return json({
            createdAt: "2026-08-15T12:00:00.000Z",
            id: randomUUID(),
            messageId,
            repeated: false,
          });
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    const { queryClient, Wrapper } = testContext();
    const { result } = renderHook(
      () => useConversationAnswerReports(conversationId, [[messageId]]),
      { wrapper: Wrapper },
    );

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(queryClient.getQueryData(stateKey)).toBeUndefined();

    await act(async () => {
      await result.current.report(messageId, {
        reason: "incorrect",
        sharePromptAndAnswer: true,
      });
    });

    expect(queryClient.getQueryData(stateKey)).toEqual({
      conversationId,
      reportedMessageIds: [messageId],
    });
    expect(result.current.reportedMessageIds.has(messageId)).toBe(true);
  });

  it("refetches only the reported conversation after submission", async () => {
    const otherConversationId = "22222222-2222-4222-8222-222222222222";
    const messageId = randomUUID();
    const otherMessageId = randomUUID();
    const stateReads = new Map<string, number>();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/answer-report-states")) {
          const id = url.includes(conversationId) ? conversationId : otherConversationId;
          stateReads.set(id, (stateReads.get(id) ?? 0) + 1);
          return json({ conversationId: id, reportedMessageIds: [] });
        }
        if (url.endsWith(`/api/conversations/${conversationId}/messages/${messageId}/report`)) {
          return json({
            createdAt: "2026-08-15T12:00:00.000Z",
            id: randomUUID(),
            messageId,
            repeated: false,
          });
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    const { Wrapper } = testContext();
    const { result } = renderHook(
      () => ({
        other: useConversationAnswerReports(otherConversationId, [[otherMessageId]]),
        target: useConversationAnswerReports(conversationId, [[messageId]]),
      }),
      { wrapper: Wrapper },
    );

    await waitFor(() => {
      expect(result.current.target.isPending).toBe(false);
      expect(result.current.other.isPending).toBe(false);
    });
    expect(stateReads).toEqual(
      new Map([
        [conversationId, 1],
        [otherConversationId, 1],
      ]),
    );

    await act(async () => {
      await result.current.target.report(messageId, {
        reason: "incorrect",
        sharePromptAndAnswer: true,
      });
    });
    await waitFor(() => expect(stateReads.get(conversationId)).toBe(2));
    expect(stateReads.get(otherConversationId)).toBe(1);
  });
});

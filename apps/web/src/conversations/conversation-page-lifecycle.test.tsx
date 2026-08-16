import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, Outlet } from "react-router";
import { RouterProvider } from "react-router/dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { copy } from "../copy";
import { seedModelTierQueries } from "../test/model-tier-fixture";
import { ConversationPage } from "./conversation-page";
import { DraftMemoryProvider } from "./draft-memory";

const queryScope = ["workspace-1", "employee-1", "2026-08-07T12:00:00.000Z"] as const;
const firstConversationId = "11111111-1111-4111-8111-111111111111";
const secondConversationId = "22222222-2222-4222-8222-222222222222";

const chatMocks = vi.hoisted(() => ({
  recoverConversation: vi.fn(),
  snapshots: new Map<string, object>(),
}));

vi.mock("./chat-runtime-provider", () => ({
  useOptionalChatRuntime: () => ({ recoverConversation: chatMocks.recoverConversation }),
  useOptionalConversationRuntime: (conversationId: string | undefined) =>
    conversationId ? chatMocks.snapshots.get(conversationId) : undefined,
}));

function json(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function TestLayout() {
  return (
    <DraftMemoryProvider queryScope={queryScope}>
      <Outlet />
    </DraftMemoryProvider>
  );
}

afterEach(() => {
  cleanup();
  chatMocks.recoverConversation.mockReset();
  chatMocks.snapshots.clear();
  vi.unstubAllGlobals();
});

describe("conversation recovery lifecycle", () => {
  it("closes an answer report dialog when the conversation route changes", async () => {
    const firstUserMessageId = "33333333-3333-4333-8333-333333333333";
    const firstAssistantMessageId = "44444444-4444-4444-8444-444444444444";
    const secondUserMessageId = "55555555-5555-4555-8555-555555555555";
    const secondAssistantMessageId = "66666666-6666-4666-8666-666666666666";
    const messageIdsByConversation = {
      [firstConversationId]: {
        assistant: firstAssistantMessageId,
        user: firstUserMessageId,
      },
      [secondConversationId]: {
        assistant: secondAssistantMessageId,
        user: secondUserMessageId,
      },
    } as const;
    let finishReport!: (response: Response) => void;
    let reportSignal: AbortSignal | null | undefined;
    const reportResponse = new Promise<Response>((resolve) => {
      finishReport = resolve;
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        const conversationId = url.includes(firstConversationId)
          ? firstConversationId
          : secondConversationId;
        const messageIds = messageIdsByConversation[conversationId];
        if (url.endsWith(`/messages/${firstAssistantMessageId}/report`)) {
          reportSignal = init?.signal;
          return reportResponse;
        }
        if (url.endsWith("/answer-report-states")) {
          return json({ conversationId, reportedMessageIds: [] });
        }
        if (url.endsWith("/response-states")) {
          return json({
            conversationId,
            revision: 1,
            responses: [
              {
                generationId: `${conversationId.slice(0, 8)}-7777-4777-8777-777777777777`,
                messageId: messageIds.assistant,
                status: "completed",
                reason: "stop",
                errorCode: null,
              },
            ],
          });
        }
        if (url.endsWith("/draft")) {
          return json({
            scope: { kind: "conversation", conversationId },
            content: "",
            revision: 0,
            updatedAt: null,
          });
        }
        if (url.endsWith(`/api/conversations/${conversationId}`)) {
          return json({
            conversation: {
              id: conversationId,
              title:
                conversationId === firstConversationId
                  ? "Primera conversación"
                  : "Segunda conversación",
              isArchived: false,
              revision: 1,
              createdAt: "2026-08-07T12:00:00.000Z",
              updatedAt: "2026-08-07T12:00:01.000Z",
            },
            selectedLeafId: messageIds.assistant,
            messages: [
              {
                id: messageIds.user,
                parentMessageId: null,
                role: "user",
                content: [{ type: "text", text: "Pregunta" }],
                createdAt: "2026-08-07T12:00:00.000Z",
                siblingCount: 0,
              },
              {
                id: messageIds.assistant,
                parentMessageId: messageIds.user,
                role: "assistant",
                content: [{ type: "text", text: "Respuesta" }],
                createdAt: "2026-08-07T12:00:01.000Z",
                siblingCount: 0,
              },
            ],
            nextCursor: null,
          });
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    seedModelTierQueries(queryClient, queryScope, [firstConversationId, secondConversationId]);
    const router = createMemoryRouter(
      [
        {
          Component: TestLayout,
          children: [{ path: "/c/:conversationId", Component: ConversationPage }],
        },
      ],
      { initialEntries: [`/c/${firstConversationId}`] },
    );
    const user = userEvent.setup();
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    await user.click(
      await screen.findByRole("button", { name: copy.conversations.messages.report }),
    );
    expect(screen.getByRole("dialog", { name: copy.conversations.report.title })).toBeVisible();
    await user.click(
      screen.getByRole("radio", { name: copy.conversations.report.reasons.incorrect }),
    );
    await user.click(screen.getByRole("button", { name: copy.conversations.report.submit }));
    await waitFor(() => expect(reportSignal).toBeInstanceOf(AbortSignal));

    await act(async () => {
      await router.navigate(`/c/${secondConversationId}`);
    });

    await screen.findByRole("heading", { level: 1, name: "Segunda conversación" });
    expect(
      screen.queryByRole("dialog", { name: copy.conversations.report.title }),
    ).not.toBeInTheDocument();
    expect(reportSignal?.aborted).toBe(true);

    await act(async () => {
      finishReport(
        json({
          createdAt: "2026-08-07T12:00:02.000Z",
          id: "88888888-8888-4888-8888-888888888888",
          messageId: firstAssistantMessageId,
          repeated: false,
        }),
      );
      await reportResponse;
      await Promise.resolve();
    });
    expect(screen.queryByText(copy.conversations.report.success)).not.toBeInTheDocument();
  });

  it("does not let a previous route clear the current route's pending recovery", async () => {
    const firstRecovery = deferred();
    const secondRecovery = deferred();
    const interruptedSnapshot = (conversationId: string) => ({
      awaitingCanonical: true,
      committedUserText: undefined,
      conversationId,
      consumesDraft: false,
      errorCode: "STREAM_INTERRUPTED",
      generationId: undefined,
      locallyOwned: true,
      messageId: undefined,
      phase: "interrupted",
      reason: undefined,
      recoveryRequired: false,
      revision: undefined,
      text: "",
      userMessageId: undefined,
    });
    chatMocks.snapshots.set(firstConversationId, interruptedSnapshot(firstConversationId));
    chatMocks.snapshots.set(secondConversationId, interruptedSnapshot(secondConversationId));
    chatMocks.recoverConversation.mockImplementation((conversationId: string) =>
      conversationId === firstConversationId ? firstRecovery.promise : secondRecovery.promise,
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input.toString();
        const conversationId = url.includes(firstConversationId)
          ? firstConversationId
          : secondConversationId;
        if (url.endsWith("/answer-report-states")) {
          return json({ conversationId, reportedMessageIds: [] });
        }
        if (url.endsWith("/draft")) {
          return json({
            scope: { kind: "conversation", conversationId },
            content: "",
            revision: 0,
            updatedAt: null,
          });
        }
        if (url.endsWith(`/api/conversations/${conversationId}`)) {
          return json({
            conversation: {
              id: conversationId,
              title:
                conversationId === firstConversationId
                  ? "Primera conversación"
                  : "Segunda conversación",
              isArchived: false,
              revision: 0,
              createdAt: "2026-08-07T12:00:00.000Z",
              updatedAt: "2026-08-07T12:00:00.000Z",
            },
            selectedLeafId: `${conversationId.slice(0, 8)}-3333-4333-8333-333333333333`,
            messages: [
              {
                id: `${conversationId.slice(0, 8)}-3333-4333-8333-333333333333`,
                parentMessageId: null,
                role: "user",
                content: [{ type: "text", text: "Mensaje" }],
                createdAt: "2026-08-07T12:00:00.000Z",
                siblingCount: 0,
              },
            ],
            nextCursor: null,
          });
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    seedModelTierQueries(queryClient, queryScope, [firstConversationId, secondConversationId]);
    const router = createMemoryRouter(
      [
        {
          Component: TestLayout,
          children: [{ path: "/c/:conversationId", Component: ConversationPage }],
        },
      ],
      { initialEntries: [`/c/${firstConversationId}`] },
    );
    const user = userEvent.setup();
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    await screen.findByRole("heading", { level: 1, name: "Primera conversación" });
    let retry = screen.getByRole("button", { name: copy.conversations.common.retry });
    await user.click(retry);
    expect(retry).toBeDisabled();

    await act(async () => {
      await router.navigate(`/c/${secondConversationId}`);
    });
    await screen.findByRole("heading", { level: 1, name: "Segunda conversación" });
    retry = screen.getByRole("button", { name: copy.conversations.common.retry });
    await user.click(retry);
    expect(retry).toBeDisabled();

    await act(async () => {
      firstRecovery.resolve();
      await firstRecovery.promise;
    });
    expect(retry).toBeDisabled();

    await act(async () => {
      secondRecovery.resolve();
      await secondRecovery.promise;
    });
    await waitFor(() => expect(retry).toBeEnabled());
  });

  it("shows recovery only after terminal reconciliation fails", async () => {
    const assistantMessageId = "33333333-3333-4333-8333-333333333333";
    const userMessageId = "44444444-4444-4444-8444-444444444444";
    const terminalSnapshot = {
      awaitingCanonical: false,
      committedUserText: undefined,
      conversationId: firstConversationId,
      consumesDraft: false,
      errorCode: undefined,
      generationId: "55555555-5555-4555-8555-555555555555",
      locallyOwned: true,
      messageId: assistantMessageId,
      phase: "completed",
      reason: "stop",
      recoveryRequired: false,
      revision: 2,
      text: "Respuesta final",
      userMessageId,
    };
    chatMocks.snapshots.set(firstConversationId, terminalSnapshot);
    chatMocks.recoverConversation.mockResolvedValue(undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.endsWith("/answer-report-states")) {
          return json({ conversationId: firstConversationId, reportedMessageIds: [] });
        }
        if (url.endsWith("/draft")) {
          return json({
            scope: { kind: "conversation", conversationId: firstConversationId },
            content: "",
            revision: 0,
            updatedAt: null,
          });
        }
        if (url.endsWith(`/api/conversations/${firstConversationId}`)) {
          return json({
            conversation: {
              id: firstConversationId,
              title: "Conversación terminada",
              isArchived: false,
              revision: 2,
              createdAt: "2026-08-07T12:00:00.000Z",
              updatedAt: "2026-08-07T12:00:01.000Z",
            },
            selectedLeafId: assistantMessageId,
            messages: [
              {
                id: userMessageId,
                parentMessageId: null,
                role: "user",
                content: [{ type: "text", text: "Pregunta" }],
                createdAt: "2026-08-07T12:00:00.000Z",
                siblingCount: 0,
              },
              {
                id: assistantMessageId,
                parentMessageId: userMessageId,
                role: "assistant",
                content: [{ type: "text", text: "Respuesta final" }],
                createdAt: "2026-08-07T12:00:01.000Z",
                siblingCount: 0,
              },
            ],
            nextCursor: null,
          });
        }
        if (url.endsWith(`/api/conversations/${firstConversationId}/response-states`)) {
          return json({
            conversationId: firstConversationId,
            revision: 2,
            responses: [
              {
                generationId: terminalSnapshot.generationId,
                messageId: assistantMessageId,
                status: "completed",
                reason: "stop",
                errorCode: null,
              },
            ],
          });
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    seedModelTierQueries(queryClient, queryScope, [firstConversationId, secondConversationId]);
    const router = createMemoryRouter(
      [
        {
          Component: TestLayout,
          children: [{ path: "/c/:conversationId", Component: ConversationPage }],
        },
      ],
      { initialEntries: [`/c/${firstConversationId}`] },
    );
    const user = userEvent.setup();
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    await screen.findByRole("heading", { level: 1, name: "Conversación terminada" });
    await waitFor(() => expect(chatMocks.recoverConversation).toHaveBeenCalled());
    expect(document.querySelector(".conversation-alert")).toBeNull();
    expect(
      screen.queryByRole("button", { name: copy.conversations.common.retry }),
    ).not.toBeInTheDocument();
    expect(document.querySelector(".generation-status")).toHaveTextContent(
      copy.conversations.generation.status.refreshing,
    );
    expect(await screen.findByText("Respuesta final", { exact: true })).toBeVisible();
    expect(
      screen.getByRole("button", { name: copy.conversations.generation.actions.send }),
    ).toBeDisabled();

    chatMocks.snapshots.set(firstConversationId, {
      ...terminalSnapshot,
      recoveryRequired: true,
    });
    await act(async () => {
      await router.navigate(`/c/${firstConversationId}`, {
        replace: true,
        state: { testRender: "recovery-required" },
      });
    });

    expect(await screen.findByRole("alert")).toHaveTextContent(
      copy.conversations.generation.errors.recovery,
    );
    expect(document.querySelector(".generation-status")).toBeNull();
    const retry = screen.getByRole("button", { name: copy.conversations.common.retry });
    const failedRecoveryCalls = chatMocks.recoverConversation.mock.calls.length;
    await act(async () => {
      await Promise.resolve();
    });
    expect(chatMocks.recoverConversation).toHaveBeenCalledTimes(failedRecoveryCalls);

    await user.click(retry);
    expect(chatMocks.recoverConversation).toHaveBeenCalledTimes(failedRecoveryCalls + 1);
  });

  it("does not present a canonically interrupted runtime as an active remote stream", async () => {
    const assistantMessageId = "33333333-3333-4333-8333-333333333333";
    const userMessageId = "44444444-4444-4444-8444-444444444444";
    const generationId = "55555555-5555-4555-8555-555555555555";
    chatMocks.snapshots.set(firstConversationId, {
      awaitingCanonical: false,
      committedUserText: undefined,
      contextWarning: false,
      conversationId: firstConversationId,
      consumesDraft: false,
      errorCode: "STREAM_INTERRUPTED",
      generationId,
      locallyOwned: true,
      messageId: assistantMessageId,
      phase: "interrupted",
      reason: "error",
      recoveryRequired: true,
      revision: 2,
      text: "Respuesta parcial",
      userMessageId,
    });
    let responseStatus: "active" | "incomplete" = "active";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.endsWith("/answer-report-states")) {
          return json({ conversationId: firstConversationId, reportedMessageIds: [] });
        }
        if (url.endsWith("/draft")) {
          return json({
            scope: { kind: "conversation", conversationId: firstConversationId },
            content: "",
            revision: 0,
            updatedAt: null,
          });
        }
        if (url.endsWith(`/api/conversations/${firstConversationId}`)) {
          return json({
            conversation: {
              id: firstConversationId,
              title: "Respuesta interrumpida",
              isArchived: false,
              revision: 2,
              createdAt: "2026-08-07T12:00:00.000Z",
              updatedAt: "2026-08-07T12:00:01.000Z",
            },
            selectedLeafId: assistantMessageId,
            messages: [
              {
                id: userMessageId,
                parentMessageId: null,
                role: "user",
                content: [{ type: "text", text: "Pregunta" }],
                createdAt: "2026-08-07T12:00:00.000Z",
                siblingCount: 0,
              },
              {
                id: assistantMessageId,
                parentMessageId: userMessageId,
                role: "assistant",
                content: [{ type: "text", text: "Respuesta parcial" }],
                createdAt: "2026-08-07T12:00:01.000Z",
                siblingCount: 0,
              },
            ],
            nextCursor: null,
          });
        }
        if (url.endsWith(`/api/conversations/${firstConversationId}/response-states`)) {
          return json({
            conversationId: firstConversationId,
            revision: responseStatus === "active" ? 1 : 2,
            responses: [
              {
                generationId,
                messageId: assistantMessageId,
                status: responseStatus,
                reason: responseStatus === "active" ? null : "error",
                errorCode: responseStatus === "active" ? null : "STREAM_INTERRUPTED",
              },
            ],
          });
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    seedModelTierQueries(queryClient, queryScope, [firstConversationId]);
    const router = createMemoryRouter(
      [
        {
          Component: TestLayout,
          children: [{ path: "/c/:conversationId", Component: ConversationPage }],
        },
      ],
      { initialEntries: [`/c/${firstConversationId}`] },
    );
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    expect(await screen.findByText("Respuesta parcial", { exact: true })).toBeVisible();
    expect(
      screen.getByText(copy.conversations.generation.terminal.incomplete, {
        selector: ".response-outcome",
      }),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: copy.conversations.generation.actions.stop }),
    ).not.toBeInTheDocument();
    const interruptedAlert = screen.getByRole("alert");
    expect(interruptedAlert).toHaveTextContent(copy.conversations.generation.status.interrupted);
    expect(
      within(interruptedAlert).getByRole("button", { name: copy.conversations.common.retry }),
    ).toBeEnabled();

    responseStatus = "incomplete";
    chatMocks.snapshots.delete(firstConversationId);
    await act(async () => {
      await queryClient.invalidateQueries();
      await router.navigate(`/c/${firstConversationId}`, {
        replace: true,
        state: { testRender: "reloaded-incomplete" },
      });
    });

    expect(
      screen.getByText(copy.conversations.generation.terminal.incomplete, {
        selector: ".response-outcome",
      }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: copy.conversations.messages.tryAgain }),
    ).toBeEnabled();
    expect(
      screen.queryByRole("button", { name: copy.conversations.generation.actions.stop }),
    ).not.toBeInTheDocument();
  });

  it("reconciles a failed remote Stop once after polling observes terminal state", async () => {
    const assistantMessageId = "33333333-3333-4333-8333-333333333333";
    const userMessageId = "44444444-4444-4444-8444-444444444444";
    const generationId = "55555555-5555-4555-8555-555555555555";
    chatMocks.snapshots.set(firstConversationId, {
      awaitingCanonical: false,
      committedUserText: undefined,
      conversationId: firstConversationId,
      consumesDraft: false,
      errorCode: undefined,
      generationId,
      locallyOwned: false,
      messageId: assistantMessageId,
      phase: "generating",
      reason: undefined,
      recoveryRequired: false,
      revision: undefined,
      text: "",
      userMessageId: undefined,
    });
    let responseStatus: "active" | "cancelled" = "active";
    chatMocks.recoverConversation.mockImplementation(async () => {
      const current = chatMocks.snapshots.get(firstConversationId);
      if (current) {
        chatMocks.snapshots.set(firstConversationId, {
          ...current,
          recoveryRequired: true,
        });
      }
    });
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/answer-report-states")) {
        return json({ conversationId: firstConversationId, reportedMessageIds: [] });
      }
      if (url.endsWith("/draft")) {
        return json({
          scope: { kind: "conversation", conversationId: firstConversationId },
          content: "",
          revision: 0,
          updatedAt: null,
        });
      }
      if (url.endsWith(`/api/conversations/${firstConversationId}`)) {
        return json({
          conversation: {
            id: firstConversationId,
            title: "Respuesta remota",
            isArchived: false,
            revision: 2,
            createdAt: "2026-08-07T12:00:00.000Z",
            updatedAt: "2026-08-07T12:00:01.000Z",
          },
          selectedLeafId: assistantMessageId,
          messages: [
            {
              id: userMessageId,
              parentMessageId: null,
              role: "user",
              content: [{ type: "text", text: "Pregunta" }],
              createdAt: "2026-08-07T12:00:00.000Z",
              siblingCount: 0,
            },
            {
              id: assistantMessageId,
              parentMessageId: userMessageId,
              role: "assistant",
              content: [{ type: "text", text: "Respuesta detenida" }],
              createdAt: "2026-08-07T12:00:01.000Z",
              siblingCount: 0,
            },
          ],
          nextCursor: null,
        });
      }
      if (url.endsWith(`/api/conversations/${firstConversationId}/response-states`)) {
        return json({
          conversationId: firstConversationId,
          revision: 2,
          responses: [
            {
              generationId,
              messageId: assistantMessageId,
              status: responseStatus,
              reason: responseStatus === "cancelled" ? "cancelled" : null,
              errorCode: null,
            },
          ],
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    seedModelTierQueries(queryClient, queryScope, [firstConversationId, secondConversationId]);
    const router = createMemoryRouter(
      [
        {
          Component: TestLayout,
          children: [{ path: "/c/:conversationId", Component: ConversationPage }],
        },
      ],
      { initialEntries: [`/c/${firstConversationId}`] },
    );
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    const user = userEvent.setup();

    await screen.findByRole("heading", { level: 1, name: "Respuesta remota" });
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([input]) =>
          String(input).endsWith(`/api/conversations/${firstConversationId}/response-states`),
        ),
      ).toBe(true),
    );
    expect(chatMocks.recoverConversation).not.toHaveBeenCalled();

    responseStatus = "cancelled";
    await act(async () => {
      await queryClient.invalidateQueries();
    });
    await waitFor(() =>
      expect(chatMocks.recoverConversation).toHaveBeenCalledWith(firstConversationId),
    );
    expect(chatMocks.recoverConversation).toHaveBeenCalledOnce();

    await act(async () => {
      await router.navigate(`/c/${firstConversationId}`, {
        replace: true,
        state: { testRender: "remote-recovery-failed" },
      });
    });
    expect(chatMocks.recoverConversation).toHaveBeenCalledOnce();

    const recoveryCopy = await screen.findByText(copy.conversations.generation.errors.recovery);
    const recoveryAlert = recoveryCopy.closest<HTMLElement>('[role="alert"]');
    if (!recoveryAlert) {
      throw new Error("The recovery action was not associated with its alert");
    }
    const retry = within(recoveryAlert).getByRole("button", {
      name: copy.conversations.common.retry,
    });
    await user.click(retry);
    expect(chatMocks.recoverConversation).toHaveBeenCalledTimes(2);
  });
});

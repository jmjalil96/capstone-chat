import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, Outlet } from "react-router";
import { RouterProvider } from "react-router/dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { copy } from "../copy";
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
});

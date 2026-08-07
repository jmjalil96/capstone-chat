import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, Outlet } from "react-router";
import { RouterProvider } from "react-router/dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { copy } from "../copy";
import { conversationQueryKeys, draftScopeKey } from "./api";
import { ConversationPage } from "./conversation-page";
import { DraftEditor } from "./draft-editor";
import { DraftMemoryProvider, useDraftMemory } from "./draft-memory";

const conversationId = "11111111-1111-4111-8111-111111111111";
const queryScope = ["workspace-1", "employee-1", "2026-08-06T12:00:00.000Z"] as const;

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function DraftMemoryProbe() {
  const drafts = useDraftMemory();
  const deletedScope = draftScopeKey({ kind: "conversation", conversationId });
  return (
    <output data-testid="deleted-draft-state">
      {drafts.records[deletedScope] ? "present" : "absent"}
    </output>
  );
}

function TestLayout() {
  return (
    <DraftMemoryProvider queryScope={queryScope}>
      <DraftMemoryProbe />
      <Outlet />
    </DraftMemoryProvider>
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("conversation page", () => {
  it("abandons canonical recovery when the conversation route changes", async () => {
    const secondConversationId = "22222222-2222-4222-8222-222222222222";
    const messageId = "33333333-3333-4333-8333-333333333333";
    let firstInitialRead = true;
    let finishRecovery: ((response: Response) => void) | undefined;
    let recoverySignal: AbortSignal | null | undefined;
    const summary = (id: string, title: string) => ({
      id,
      title,
      isArchived: false,
      revision: 0,
      createdAt: "2026-08-06T12:00:00.000Z",
      updatedAt: "2026-08-06T12:00:00.000Z",
    });
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url.endsWith(`/api/conversations/${conversationId}?cursor=cursor.signature`)) {
        return json(
          {
            code: "CONVERSATION_CHANGED",
            message: "Conversation changed",
            requestId: "request-cursor",
          },
          409,
        );
      }
      if (url.endsWith(`/api/conversations/${conversationId}`)) {
        if (firstInitialRead) {
          firstInitialRead = false;
          return json({
            conversation: summary(conversationId, "Conversación anterior"),
            selectedLeafId: messageId,
            messages: [
              {
                id: messageId,
                parentMessageId: null,
                role: "user",
                content: [{ type: "text", text: "Mensaje anterior" }],
                createdAt: "2026-08-06T12:00:00.000Z",
                siblingCount: 0,
              },
            ],
            nextCursor: "cursor.signature",
          });
        }
        recoverySignal = init?.signal;
        return new Promise<Response>((resolve) => {
          finishRecovery = resolve;
        });
      }
      if (url.endsWith(`/api/conversations/${secondConversationId}`)) {
        return json({
          conversation: summary(secondConversationId, "Conversación actual"),
          selectedLeafId: null,
          messages: [],
          nextCursor: null,
        });
      }
      if (url.endsWith(`/api/conversations/${secondConversationId}/draft`)) {
        return json({
          scope: { kind: "conversation", conversationId: secondConversationId },
          content: "",
          revision: 0,
          updatedAt: null,
        });
      }
      throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const router = createMemoryRouter(
      [
        {
          Component: TestLayout,
          children: [{ path: "/c/:conversationId", Component: ConversationPage }],
        },
      ],
      { initialEntries: [`/c/${conversationId}`] },
    );
    const user = userEvent.setup();
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    expect(
      await screen.findByRole("heading", { level: 1, name: "Conversación anterior" }),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: copy.conversations.conversation.older }));
    await waitFor(() => expect(finishRecovery).toBeTypeOf("function"));

    await act(async () => {
      await router.navigate(`/c/${secondConversationId}`);
    });
    expect(
      await screen.findByRole("heading", { level: 1, name: "Conversación actual" }),
    ).toBeVisible();
    await waitFor(() => expect(recoverySignal?.aborted).toBe(true));

    await act(async () => {
      finishRecovery?.(
        json({
          conversation: summary(conversationId, "Conversación anterior recuperada"),
          selectedLeafId: messageId,
          messages: [],
          nextCursor: null,
        }),
      );
      await Promise.resolve();
    });

    expect(router.state.location.pathname).toBe(`/c/${secondConversationId}`);
    expect(screen.getByRole("heading", { name: "Conversación actual" })).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("settles an active draft save before deletion and cannot resurrect discarded client state", async () => {
    const conversation = {
      id: conversationId,
      title: "Conversación para eliminar",
      isArchived: false,
      revision: 0,
      createdAt: "2026-08-06T12:00:00.000Z",
      updatedAt: "2026-08-06T12:00:00.000Z",
    };
    const requestOrder: string[] = [];
    let finishDraftSave: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";

      if (url.endsWith(`/api/conversations/${conversationId}/draft`) && method === "PUT") {
        requestOrder.push("draft-save-start");
        return new Promise<Response>((resolve) => {
          finishDraftSave = (response) => {
            requestOrder.push("draft-save-finish");
            resolve(response);
          };
        });
      }
      if (url.endsWith(`/api/conversations/${conversationId}/draft`)) {
        return json({
          scope: { kind: "conversation", conversationId },
          content: "",
          revision: 0,
          updatedAt: null,
        });
      }
      if (url.endsWith(`/api/conversations/${conversationId}`) && method === "DELETE") {
        requestOrder.push("delete");
        return new Response(null, { status: 204 });
      }
      if (url.endsWith(`/api/conversations/${conversationId}`)) {
        return json({
          conversation,
          selectedLeafId: null,
          messages: [],
          nextCursor: null,
        });
      }
      if (url.endsWith("/api/drafts/new")) {
        return json({
          scope: { kind: "new" },
          content: "",
          revision: 0,
          updatedAt: null,
        });
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const router = createMemoryRouter(
      [
        {
          Component: TestLayout,
          children: [
            { path: "/c/:conversationId", Component: ConversationPage },
            {
              path: "/",
              element: (
                <>
                  <h1>Eliminada</h1>
                  <DraftEditor scope={{ kind: "new" }} />
                </>
              ),
            },
          ],
        },
      ],
      { initialEntries: [`/c/${conversationId}`] },
    );
    const user = userEvent.setup();
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    const editor = await screen.findByRole("textbox", { name: copy.conversations.draft.label });
    await waitFor(() => expect(editor).toBeEnabled());
    await user.type(editor, "Borrador que se eliminará");
    await waitFor(() => expect(finishDraftSave).toBeTypeOf("function"), { timeout: 1_500 });

    await user.click(screen.getByRole("button", { name: copy.conversations.conversation.delete }));
    await user.click(
      screen.getByRole("button", { name: copy.conversations.conversation.confirmDelete }),
    );
    expect(editor).toBeDisabled();
    expect(requestOrder).toEqual(["draft-save-start"]);

    await act(async () => {
      finishDraftSave?.(
        json({
          scope: { kind: "conversation", conversationId },
          content: "Borrador que se eliminará",
          revision: 1,
          updatedAt: "2026-08-06T12:00:01.000Z",
        }),
      );
    });

    expect(await screen.findByRole("heading", { name: "Eliminada" })).toBeVisible();
    expect(requestOrder).toEqual(["draft-save-start", "draft-save-finish", "delete"]);
    expect(screen.getByTestId("deleted-draft-state")).toHaveTextContent("absent");
    expect(
      await screen.findByRole("textbox", { name: copy.conversations.draft.label }),
    ).toBeEnabled();
    expect(
      queryClient.getQueryData(
        conversationQueryKeys.draft(queryScope, { kind: "conversation", conversationId }),
      ),
    ).toBeUndefined();
  });
});

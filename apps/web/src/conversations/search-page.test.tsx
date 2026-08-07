import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { createMemoryRouter, Outlet } from "react-router";
import { RouterProvider } from "react-router/dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { copy } from "../copy";
import { ConversationPage } from "./conversation-page";
import { DraftMemoryProvider } from "./draft-memory";
import { SearchPage } from "./search-page";

const conversationId = "11111111-1111-4111-8111-111111111111";
const leafMessageId = "22222222-2222-4222-8222-222222222222";
const queryScope = ["workspace-1", "employee-1", "2026-08-06T12:00:00.000Z"] as const;

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
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
  vi.unstubAllGlobals();
});

describe("search page", () => {
  it("does not restore obsolete navigation after the employee leaves a pending result", async () => {
    let finishSelection: ((response: Response) => void) | undefined;
    let selectionSignal: AbortSignal | null | undefined;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";

      if (url.endsWith("/api/conversations/search") && method === "POST") {
        return json({
          results: [
            {
              conversation: {
                id: conversationId,
                title: "Resultado preservado",
                isArchived: false,
                revision: 3,
                createdAt: "2026-08-06T12:00:00.000Z",
                updatedAt: "2026-08-06T12:00:00.000Z",
              },
              leafMessageId,
              matchedMessageId: leafMessageId,
              matchKind: "message",
              snippet: [{ highlighted: true, text: "coincidencia preservada" }],
            },
          ],
          nextCursor: null,
        });
      }
      if (url.endsWith(`/api/conversations/${conversationId}/selection`) && method === "PUT") {
        selectionSignal = init?.signal;
        return new Promise<Response>((resolve) => {
          finishSelection = resolve;
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
            { path: "/search", Component: SearchPage },
            { path: "/", element: <h1>Nuevo destino</h1> },
          ],
        },
      ],
      { initialEntries: ["/search"] },
    );
    const user = userEvent.setup();
    render(
      <StrictMode>
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </StrictMode>,
    );

    await user.type(
      screen.getByRole("searchbox", { name: copy.conversations.search.label }),
      "coi",
    );
    const result = await screen.findByRole("button", { name: /coincidencia preservada/iu });
    await user.click(result);
    await waitFor(() => expect(finishSelection).toBeTypeOf("function"));

    await act(async () => {
      await router.navigate("/");
    });
    expect(await screen.findByRole("heading", { name: "Nuevo destino" })).toBeVisible();
    await waitFor(() => expect(selectionSignal?.aborted).toBe(true));

    await act(async () => {
      finishSelection?.(
        json({
          conversation: {
            id: conversationId,
            title: "Resultado preservado",
            isArchived: false,
            revision: 4,
            createdAt: "2026-08-06T12:00:00.000Z",
            updatedAt: "2026-08-06T12:00:01.000Z",
          },
          selectedLeafId: leafMessageId,
        }),
      );
      await Promise.resolve();
    });

    expect(router.state.location.pathname).toBe("/");
    expect(screen.getByRole("heading", { name: "Nuevo destino" })).toBeVisible();
    expect(
      fetchMock.mock.calls.some(([input, init]) => {
        const url = typeof input === "string" ? input : input.toString();
        return url.endsWith(`/api/conversations/${conversationId}`) && !init?.method;
      }),
    ).toBe(false);
  });

  it("starts a fresh canonical read when the destination opens during search prefetch", async () => {
    let detailReads = 0;
    let prefetchSignal: AbortSignal | null | undefined;
    const summary = {
      id: conversationId,
      title: "Destino canónico",
      isArchived: false,
      revision: 4,
      createdAt: "2026-08-06T12:00:00.000Z",
      updatedAt: "2026-08-06T12:00:01.000Z",
    };
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";

      if (url.endsWith("/api/conversations/search") && method === "POST") {
        return json({
          results: [
            {
              conversation: { ...summary, revision: 3 },
              leafMessageId,
              matchedMessageId: leafMessageId,
              matchKind: "message",
              snippet: [{ highlighted: true, text: "destino encontrado" }],
            },
          ],
          nextCursor: null,
        });
      }
      if (url.endsWith(`/api/conversations/${conversationId}/selection`) && method === "PUT") {
        return json({ conversation: summary, selectedLeafId: leafMessageId });
      }
      if (url.endsWith(`/api/conversations/${conversationId}/draft`) && method === "GET") {
        return json({
          scope: { kind: "conversation", conversationId },
          content: "",
          revision: 0,
          updatedAt: null,
        });
      }
      if (url.endsWith(`/api/conversations/${conversationId}`) && method === "GET") {
        detailReads += 1;
        if (detailReads === 1) {
          prefetchSignal = init?.signal;
          return new Promise<Response>((_resolve, reject) => {
            const rejectAbort = () => reject(new DOMException("Aborted", "AbortError"));
            if (prefetchSignal?.aborted) {
              rejectAbort();
            } else {
              prefetchSignal?.addEventListener("abort", rejectAbort, { once: true });
            }
          });
        }
        return json({
          conversation: summary,
          selectedLeafId: leafMessageId,
          messages: [
            {
              id: leafMessageId,
              parentMessageId: null,
              role: "user",
              content: [{ type: "text", text: "Destino encontrado" }],
              createdAt: "2026-08-06T12:00:00.000Z",
              siblingCount: 0,
            },
          ],
          nextCursor: null,
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
            { path: "/search", Component: SearchPage },
            { path: "/c/:conversationId", Component: ConversationPage },
          ],
        },
      ],
      { initialEntries: ["/search"] },
    );
    const user = userEvent.setup();
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    await user.type(
      screen.getByRole("searchbox", { name: copy.conversations.search.label }),
      "destino",
    );
    await user.click(await screen.findByRole("button", { name: /destino encontrado/iu }));
    await waitFor(() => expect(detailReads).toBe(1));

    await act(async () => {
      await router.navigate(`/c/${conversationId}`);
    });

    await waitFor(() => expect(prefetchSignal?.aborted).toBe(true));
    expect(await screen.findByRole("heading", { level: 1, name: summary.title })).toBeVisible();
    expect(router.state.location.pathname).toBe(`/c/${conversationId}`);
    expect(detailReads).toBe(2);
  });
});

import type { ConversationDetailResponse } from "@capstone/protocol";
import { type InfiniteData, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { createMemoryRouter, Outlet } from "react-router";
import { RouterProvider } from "react-router/dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { copy } from "../copy";
import { conversationQueryKeys } from "./api";
import { SEARCH_DEBOUNCE_DELAY_MS } from "./config";
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
  it("blocks an over-limit multibyte query until it fits the shared UTF-8 bound", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/api/conversations/search") && init?.method === "POST") {
        return json({ results: [], nextCursor: null });
      }
      throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const router = createMemoryRouter(
      [
        {
          Component: TestLayout,
          children: [{ path: "/search", Component: SearchPage }],
        },
      ],
      { initialEntries: ["/search"] },
    );
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    const searchbox = await screen.findByRole("searchbox", {
      name: copy.conversations.search.label,
    });
    vi.useFakeTimers();
    fireEvent.change(searchbox, { target: { value: "ñ".repeat(129) } });
    expect(searchbox).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("alert")).toHaveTextContent(copy.conversations.search.tooLarge);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_DELAY_MS * 2);
    });
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.change(searchbox, { target: { value: "ñ".repeat(128) } });
    expect(searchbox).not.toHaveAttribute("aria-invalid");
    expect(screen.queryByText(copy.conversations.search.tooLarge)).not.toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_DELAY_MS);
    });
    vi.useRealTimers();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      query: "ñ".repeat(128),
    });
  });

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

  it("consumes a matched-message intent before sequential opaque pagination finishes", async () => {
    const targetMessageId = "33333333-3333-4333-8333-333333333333";
    const olderAssistantId = "44444444-4444-4444-8444-444444444444";
    const currentUserId = "55555555-5555-4555-8555-555555555555";
    const currentAssistantId = "66666666-6666-4666-8666-666666666666";
    const summary = {
      id: conversationId,
      title: "Resultado profundo",
      isArchived: false,
      revision: 4,
      createdAt: "2026-08-06T12:00:00.000Z",
      updatedAt: "2026-08-06T12:00:04.000Z",
    };
    let resolveOlder!: (response: Response) => void;
    const olderPage = new Promise<Response>((resolve) => {
      resolveOlder = resolve;
    });
    const detailUrls: string[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";
      if (url.endsWith(`/api/conversations/${conversationId}/draft`) && method === "GET") {
        return json({
          scope: { kind: "conversation", conversationId },
          content: "",
          revision: 0,
          updatedAt: null,
        });
      }
      if (url.endsWith(`/api/conversations/${conversationId}/response-states`)) {
        return json({ conversationId, revision: 4, responses: [] });
      }
      if (url.includes(`/api/conversations/${conversationId}`) && method === "GET") {
        detailUrls.push(url);
        if (url.endsWith("?cursor=opaque.cursor")) {
          return olderPage;
        }
        return json({
          conversation: summary,
          selectedLeafId: currentAssistantId,
          messages: [
            {
              id: currentUserId,
              parentMessageId: olderAssistantId,
              role: "user",
              content: [{ type: "text", text: "Pregunta actual" }],
              createdAt: "2026-08-06T12:00:02.000Z",
              siblingCount: 0,
            },
            {
              id: currentAssistantId,
              parentMessageId: currentUserId,
              role: "assistant",
              content: [{ type: "text", text: "Respuesta actual" }],
              createdAt: "2026-08-06T12:00:03.000Z",
              siblingCount: 0,
            },
          ],
          nextCursor: "opaque.cursor",
        });
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const router = createMemoryRouter(
      [
        {
          Component: TestLayout,
          children: [{ path: "/c/:conversationId", Component: ConversationPage }],
        },
      ],
      {
        initialEntries: [
          {
            pathname: `/c/${conversationId}`,
            state: { matchedMessageId: targetMessageId },
          },
        ],
      },
    );
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    expect(await screen.findByRole("heading", { level: 1, name: summary.title })).toBeVisible();
    await waitFor(() =>
      expect(detailUrls).toContain(`/api/conversations/${conversationId}?cursor=opaque.cursor`),
    );
    expect(router.state.location.state).toBeNull();
    expect(screen.queryByText("Objetivo preservado")).not.toBeInTheDocument();

    await act(async () => {
      resolveOlder(
        json({
          conversation: summary,
          selectedLeafId: currentAssistantId,
          messages: [
            {
              id: targetMessageId,
              parentMessageId: null,
              role: "user",
              content: [{ type: "text", text: "Objetivo preservado" }],
              createdAt: "2026-08-06T12:00:00.000Z",
              siblingCount: 0,
            },
            {
              id: olderAssistantId,
              parentMessageId: targetMessageId,
              role: "assistant",
              content: [{ type: "text", text: "Respuesta anterior" }],
              createdAt: "2026-08-06T12:00:01.000Z",
              siblingCount: 0,
            },
          ],
          nextCursor: null,
        }),
      );
      await olderPage;
    });

    const target = await screen.findByText("Objetivo preservado", { exact: true });
    expect(target.closest("[data-message-id]")).toHaveAttribute("data-message-id", targetMessageId);
    expect(target.closest("[data-message-id]")).toHaveClass("search-match");
    expect(screen.getByText(copy.conversations.search.located)).toHaveClass("visually-hidden");
    expect(detailUrls).toEqual([
      `/api/conversations/${conversationId}`,
      `/api/conversations/${conversationId}?cursor=opaque.cursor`,
    ]);
  });

  it("recovers a stale deep cursor for the new revision, then consumes it once", async () => {
    const targetMessageId = "33333333-3333-4333-8333-333333333333";
    const currentMessageId = "44444444-4444-4444-8444-444444444444";
    const summary = (revision: number) => ({
      id: conversationId,
      title: "Resultado que cambia",
      isArchived: false,
      revision,
      createdAt: "2026-08-06T12:00:00.000Z",
      updatedAt: "2026-08-06T12:00:04.000Z",
    });
    let canonicalReads = 0;
    const detailUrls: string[] = [];
    const currentPage = (revision: number, cursor: string | null): ConversationDetailResponse => ({
      conversation: summary(revision),
      selectedLeafId: currentMessageId,
      messages: [
        {
          id: currentMessageId,
          parentMessageId: targetMessageId,
          role: "user",
          content: [{ type: "text", text: "Mensaje actual" }],
          createdAt: "2026-08-06T12:00:03.000Z",
          siblingCount: 0,
        },
      ],
      nextCursor: cursor,
    });
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";
      if (url.endsWith(`/api/conversations/${conversationId}/draft`) && method === "GET") {
        return json({
          scope: { kind: "conversation", conversationId },
          content: "",
          revision: 0,
          updatedAt: null,
        });
      }
      if (url.includes(`/api/conversations/${conversationId}`) && method === "GET") {
        detailUrls.push(url);
        if (url.endsWith("?cursor=old.cursor")) {
          return json(
            {
              code: "CONVERSATION_CHANGED",
              message: "Conversation changed",
              requestId: "request-stale-cursor",
            },
            409,
          );
        }
        if (url.endsWith("?cursor=new.cursor")) {
          return json({
            conversation: summary(5),
            selectedLeafId: currentMessageId,
            messages: [
              {
                id: targetMessageId,
                parentMessageId: null,
                role: "user",
                content: [{ type: "text", text: "Objetivo tras el cambio" }],
                createdAt: "2026-08-06T12:00:00.000Z",
                siblingCount: 0,
              },
            ],
            nextCursor: null,
          });
        }
        canonicalReads += 1;
        return json(
          canonicalReads === 1 ? currentPage(4, "old.cursor") : currentPage(5, "new.cursor"),
        );
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const router = createMemoryRouter(
      [
        {
          Component: TestLayout,
          children: [{ path: "/c/:conversationId", Component: ConversationPage }],
        },
      ],
      {
        initialEntries: [
          {
            pathname: `/c/${conversationId}`,
            state: { matchedMessageId: targetMessageId },
          },
        ],
      },
    );
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    await waitFor(() =>
      expect(detailUrls).toContain(`/api/conversations/${conversationId}?cursor=old.cursor`),
    );
    const target = await screen.findByText("Objetivo tras el cambio", { exact: true });
    expect(target.closest("[data-message-id]")).toHaveClass("search-match");
    expect(canonicalReads).toBe(2);
    expect(detailUrls).toContain(`/api/conversations/${conversationId}?cursor=new.cursor`);
    const readsAfterSuccess = detailUrls.length;

    await act(async () => {
      queryClient.setQueryData<InfiniteData<ConversationDetailResponse>>(
        conversationQueryKeys.detail(queryScope, conversationId),
        (current) =>
          current
            ? {
                ...current,
                pages: current.pages.map((page) => ({
                  ...page,
                  conversation: summary(6),
                })),
              }
            : current,
      );
      await Promise.resolve();
    });

    expect(detailUrls).toHaveLength(readsAfterSuccess);
  });
});

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter } from "react-router";
import { RouterProvider } from "react-router/dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { copy } from "../copy";
import { ChatRuntimeProvider } from "./chat-runtime-provider";
import { ConversationPage } from "./conversation-page";
import { DraftMemoryProvider } from "./draft-memory";
import { NewChatPage } from "./new-chat-page";

const queryScope = ["workspace-1", "employee-1", "2026-08-08T12:00:00.000Z"] as const;
const conversationId = "11111111-1111-4111-8111-111111111111";
const userMessageId = "22222222-2222-4222-8222-222222222222";
const assistantMessageId = "33333333-3333-4333-8333-333333333333";
const generationId = "44444444-4444-4444-8444-444444444444";

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function policy(defaultTier: "balanced" | "fast" | "pro", proAvailable = true) {
  return {
    defaultTier,
    tiers: [
      { tier: "fast", enabled: true, available: true },
      { tier: "balanced", enabled: true, available: true },
      { tier: "pro", enabled: true, available: proAvailable },
    ],
  } as const;
}

function renderApp(router: ReturnType<typeof createMemoryRouter>) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    queryClient,
    ...render(
      <QueryClientProvider client={queryClient}>
        <DraftMemoryProvider queryScope={queryScope}>
          <ChatRuntimeProvider>
            <RouterProvider router={router} />
          </ChatRuntimeProvider>
        </DraftMemoryProvider>
      </QueryClientProvider>,
    ),
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("tiered generation experience", () => {
  it("uses the workspace default for the first request in a new chat", async () => {
    let responseBody: unknown;
    const stream = new ReadableStream<Uint8Array>();
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (url === "/api/model-tiers") {
        return json(policy("pro"));
      }
      if (url === "/api/drafts/new" && method === "PUT") {
        const body = JSON.parse(String(init?.body)) as { content: string };
        return json({
          scope: { kind: "new" },
          content: body.content,
          revision: 1,
          updatedAt: "2026-08-08T12:00:00.000Z",
        });
      }
      if (url === "/api/drafts/new") {
        return json({ scope: { kind: "new" }, content: "", revision: 0, updatedAt: null });
      }
      if (url === "/api/conversations" && method === "POST") {
        return json({
          id: conversationId,
          title: null,
          isArchived: false,
          revision: 0,
          createdAt: "2026-08-08T12:00:00.000Z",
          updatedAt: "2026-08-08T12:00:00.000Z",
        });
      }
      if (url.endsWith(`/api/conversations/${conversationId}/responses`)) {
        responseBody = JSON.parse(String(init?.body));
        return new Response(stream, {
          status: 200,
          headers: { "content-type": "application/x-ndjson" },
        });
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const router = createMemoryRouter(
      [
        { path: "/", Component: NewChatPage },
        { path: "/c/:conversationId", element: <h1>Conversación creada</h1> },
      ],
      { initialEntries: ["/"] },
    );
    const { queryClient } = renderApp(router);
    const user = userEvent.setup();

    const pro = await screen.findByRole("radio", { name: /Pro/ });
    await waitFor(() => expect(pro).toBeChecked());
    await user.type(
      await screen.findByRole("textbox", { name: copy.conversations.draft.label }),
      "Analiza este caso",
    );
    await user.click(
      screen.getByRole("button", { name: copy.conversations.generation.actions.send }),
    );

    await waitFor(() => expect(responseBody).toMatchObject({ source: "draft", modelTier: "pro" }));
    expect(
      queryClient.getQueryData(["conversations", ...queryScope, "preferred-tier", conversationId]),
    ).toEqual({ conversationId, modelTier: "pro" });
  });

  it("blocks every generation action when the persisted tier is unavailable", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === "/api/model-tiers") {
        return json(policy("balanced", false));
      }
      if (url.endsWith("/preferred-tier")) {
        return json({ conversationId, modelTier: "pro" });
      }
      if (url.endsWith("/draft")) {
        return json({
          scope: { kind: "conversation", conversationId },
          content: "Siguiente pregunta",
          revision: 1,
          updatedAt: "2026-08-08T12:00:00.000Z",
        });
      }
      if (url.endsWith("/response-states")) {
        return json({
          conversationId,
          revision: 2,
          responses: [
            {
              generationId,
              messageId: assistantMessageId,
              status: "completed",
              reason: "length",
              errorCode: null,
            },
          ],
        });
      }
      if (url.endsWith(`/api/conversations/${conversationId}`)) {
        return json({
          conversation: {
            id: conversationId,
            title: "Nivel no disponible",
            isArchived: false,
            revision: 2,
            createdAt: "2026-08-08T12:00:00.000Z",
            updatedAt: "2026-08-08T12:00:01.000Z",
          },
          selectedLeafId: assistantMessageId,
          messages: [
            {
              id: userMessageId,
              parentMessageId: null,
              role: "user",
              content: [{ type: "text", text: "Pregunta" }],
              createdAt: "2026-08-08T12:00:00.000Z",
              siblingCount: 0,
            },
            {
              id: assistantMessageId,
              parentMessageId: userMessageId,
              role: "assistant",
              content: [{ type: "text", text: "Respuesta" }],
              createdAt: "2026-08-08T12:00:01.000Z",
              siblingCount: 0,
            },
          ],
          nextCursor: null,
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const router = createMemoryRouter(
      [{ path: "/c/:conversationId", Component: ConversationPage }],
      { initialEntries: [`/c/${conversationId}`] },
    );
    renderApp(router);

    await screen.findByRole("heading", { name: "Nivel no disponible" });
    await waitFor(() =>
      expect(screen.getByText(copy.conversations.modelTiers.unavailable)).toBeVisible(),
    );
    expect(
      screen.getByRole("button", { name: copy.conversations.generation.actions.send }),
    ).toBeDisabled();
    expect(
      screen.queryByRole("button", { name: copy.conversations.messages.edit }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: copy.conversations.messages.tryAgain }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: copy.conversations.generation.actions.continue }),
    ).not.toBeInTheDocument();
  });

  it("keeps the active request on its committed tier while preparing the next tier", async () => {
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
      },
    });
    let serverDraft = "";
    const responseBodies: unknown[] = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (url === "/api/model-tiers") {
        return json(policy("balanced"));
      }
      if (url.endsWith("/preferred-tier") && method === "PUT") {
        return json({ conversationId, modelTier: "pro" });
      }
      if (url.endsWith("/preferred-tier")) {
        return json({ conversationId, modelTier: "balanced" });
      }
      if (url.endsWith("/draft") && method === "PUT") {
        serverDraft = (JSON.parse(String(init?.body)) as { content: string }).content;
        return json({
          scope: { kind: "conversation", conversationId },
          content: serverDraft,
          revision: 1,
          updatedAt: "2026-08-08T12:00:00.000Z",
        });
      }
      if (url.endsWith("/draft")) {
        return json({
          scope: { kind: "conversation", conversationId },
          content: serverDraft,
          revision: serverDraft ? 1 : 0,
          updatedAt: serverDraft ? "2026-08-08T12:00:00.000Z" : null,
        });
      }
      if (url.endsWith("/responses")) {
        responseBodies.push(JSON.parse(String(init?.body)));
        serverDraft = "";
        return new Response(stream, {
          status: 200,
          headers: { "content-type": "application/x-ndjson" },
        });
      }
      if (url.endsWith("/response-states")) {
        return json({
          conversationId,
          revision: 1,
          responses: [
            {
              generationId,
              messageId: assistantMessageId,
              status: "active",
              reason: null,
              errorCode: null,
            },
          ],
        });
      }
      if (url.endsWith(`/api/conversations/${conversationId}`)) {
        return json({
          conversation: {
            id: conversationId,
            title: "Respuesta activa",
            isArchived: false,
            revision: 0,
            createdAt: "2026-08-08T12:00:00.000Z",
            updatedAt: "2026-08-08T12:00:00.000Z",
          },
          selectedLeafId: null,
          messages: [],
          nextCursor: null,
        });
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const router = createMemoryRouter(
      [{ path: "/c/:conversationId", Component: ConversationPage }],
      { initialEntries: [`/c/${conversationId}`] },
    );
    renderApp(router);
    const user = userEvent.setup();

    const editor = await screen.findByRole("textbox", {
      name: copy.conversations.draft.label,
    });
    await waitFor(() => expect(editor).toBeEnabled());
    await user.type(editor, "Primera pregunta");
    await user.click(
      screen.getByRole("button", { name: copy.conversations.generation.actions.send }),
    );
    await waitFor(() => expect(responseBodies).toHaveLength(1));
    streamController.enqueue(
      new TextEncoder().encode(
        `${JSON.stringify({
          type: "response.started",
          conversationId,
          generationId,
          userMessageId,
          messageId: assistantMessageId,
          revision: 1,
        })}\n`,
      ),
    );

    await screen.findByRole("button", { name: copy.conversations.generation.actions.stop });
    await user.click(screen.getByRole("radio", { name: /Pro/ }));
    await waitFor(() => expect(screen.getByRole("radio", { name: /Pro/ })).toBeChecked());
    expect(responseBodies).toEqual([expect.objectContaining({ modelTier: "balanced" })]);
  });
});

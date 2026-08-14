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

function tierTriggerName(tier: "balanced" | "fast" | "pro"): string {
  return `${copy.conversations.modelTiers.label}: ${copy.conversations.modelTiers.tiers[tier].name}`;
}

const anyTierTrigger = new RegExp(`^${copy.conversations.modelTiers.label}:`, "u");

async function chooseTier(
  user: ReturnType<typeof userEvent.setup>,
  rowName: RegExp,
): Promise<void> {
  await user.click(screen.getByRole("button", { name: anyTierTrigger }));
  await user.click(screen.getByRole("button", { name: rowName }));
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
  it("starts from the workspace default and keeps a new-chat tier change local until creation", async () => {
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

    await screen.findByRole("button", { name: tierTriggerName("pro") });
    await chooseTier(user, /^Fast/u);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: tierTriggerName("fast") })).toBeVisible(),
    );
    expect(
      fetchMock.mock.calls.some(
        ([url, init]) => String(url).endsWith("/preferred-tier") && init?.method === "PUT",
      ),
    ).toBe(false);
    await user.type(
      await screen.findByRole("textbox", { name: copy.conversations.draft.label }),
      "Analiza este caso",
    );
    await user.click(
      screen.getByRole("button", { name: copy.conversations.generation.actions.send }),
    );

    await waitFor(() => expect(responseBody).toMatchObject({ source: "draft", modelTier: "fast" }));
    expect(
      queryClient.getQueryData(["conversations", ...queryScope, "preferred-tier", conversationId]),
    ).toEqual({ conversationId, modelTier: "fast" });
  });

  it("sends the untouched workspace default tier for a new chat", async () => {
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
    renderApp(router);
    const user = userEvent.setup();

    // No tier interaction at all: the first request must carry the workspace
    // default exactly as the policy delivered it.
    await screen.findByRole("button", { name: tierTriggerName("pro") });
    await user.type(
      await screen.findByRole("textbox", { name: copy.conversations.draft.label }),
      "Analiza este caso",
    );
    await user.click(
      screen.getByRole("button", { name: copy.conversations.generation.actions.send }),
    );

    await waitFor(() => expect(responseBody).toMatchObject({ source: "draft", modelTier: "pro" }));
    expect(
      fetchMock.mock.calls.some(
        ([url, init]) => String(url).endsWith("/preferred-tier") && init?.method === "PUT",
      ),
    ).toBe(false);
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

  it("fences generation initiators while an existing conversation tier is saving", async () => {
    let finishTierUpdate!: (response: Response) => void;
    const tierUpdate = new Promise<Response>((resolve) => {
      finishTierUpdate = resolve;
    });
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (url === "/api/model-tiers") {
        return json(policy("balanced"));
      }
      if (url.endsWith("/preferred-tier") && method === "PUT") {
        return tierUpdate;
      }
      if (url.endsWith("/preferred-tier")) {
        return json({ conversationId, modelTier: "balanced" });
      }
      if (url.endsWith("/draft")) {
        return json({
          scope: { kind: "conversation", conversationId },
          content: "Siguiente pregunta",
          revision: 1,
          updatedAt: "2026-08-08T12:00:02.000Z",
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
            title: "Preferencia en guardado",
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
              content: [{ type: "text", text: "Respuesta incompleta" }],
              createdAt: "2026-08-08T12:00:01.000Z",
              siblingCount: 0,
            },
          ],
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

    const send = await screen.findByRole("button", {
      name: copy.conversations.generation.actions.send,
    });
    const edit = await screen.findByRole("button", { name: copy.conversations.messages.edit });
    const picker = screen.getByRole("button", { name: anyTierTrigger });
    await waitFor(() => {
      expect(send).toBeEnabled();
      expect(screen.getByRole("button", { name: tierTriggerName("balanced") })).toBeVisible();
    });
    expect(
      screen.getByRole("button", { name: copy.conversations.messages.tryAgain }),
    ).toBeEnabled();
    expect(
      screen.getByRole("button", { name: copy.conversations.generation.actions.continue }),
    ).toBeEnabled();

    await user.click(edit);
    const inlineEditor = screen.getByRole("textbox", {
      name: copy.conversations.messages.editLabel,
    });
    await user.clear(inlineEditor);
    await user.type(inlineEditor, "Pregunta editada");
    const saveEdit = screen.getByRole("button", { name: copy.conversations.messages.saveEdit });
    expect(saveEdit).toBeEnabled();

    await chooseTier(user, /^Pro/u);
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/conversations/${conversationId}/preferred-tier`,
        expect.objectContaining({ method: "PUT" }),
      ),
    );

    expect(screen.getByRole("button", { name: tierTriggerName("balanced") })).toBeVisible();
    expect(picker).toHaveAttribute("aria-disabled", "true");
    expect(picker).toBeEnabled();
    expect(send).toBeDisabled();
    expect(saveEdit).toBeDisabled();
    expect(
      screen.queryByRole("button", { name: copy.conversations.messages.tryAgain }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: copy.conversations.generation.actions.continue }),
    ).not.toBeInTheDocument();

    finishTierUpdate(json({ conversationId, modelTier: "pro" }));
    await tierUpdate;

    await waitFor(() => {
      expect(screen.getByRole("button", { name: tierTriggerName("pro") })).toBeVisible();
      expect(picker).not.toHaveAttribute("aria-disabled");
      expect(send).toBeEnabled();
      expect(saveEdit).toBeEnabled();
    });
    expect(
      screen.getByRole("button", { name: copy.conversations.messages.tryAgain }),
    ).toBeEnabled();
    expect(
      screen.getByRole("button", { name: copy.conversations.generation.actions.continue }),
    ).toBeEnabled();
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
    await chooseTier(user, /^Pro/u);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: tierTriggerName("pro") })).toBeVisible(),
    );
    expect(responseBodies).toEqual([expect.objectContaining({ modelTier: "balanced" })]);
  });
});

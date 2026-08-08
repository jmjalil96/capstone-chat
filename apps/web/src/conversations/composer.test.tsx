import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { copy } from "../copy";
import { conversationQueryKeys } from "./api";
import type { ChatRuntime } from "./chat-runtime";
import { ChatRuntimeProvider, useChatRuntime } from "./chat-runtime-provider";
import { DraftEditor, type DraftEditorComposer } from "./draft-editor";
import { DraftMemoryProvider } from "./draft-memory";

const queryScope = ["workspace-1", "employee-1", "2026-08-07T12:00:00.000Z"] as const;
const conversationId = "11111111-1111-4111-8111-111111111111";
const generationId = "22222222-2222-4222-8222-222222222222";
const userMessageId = "33333333-3333-4333-8333-333333333333";
const messageId = "44444444-4444-4444-8444-444444444444";

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function draft(content: string, revision: number) {
  return {
    scope: { kind: "conversation", conversationId },
    content,
    revision,
    updatedAt: revision === 0 ? null : "2026-08-07T12:00:00.000Z",
  } as const;
}

function responseStarted(): Uint8Array {
  return new TextEncoder().encode(
    `${JSON.stringify({
      type: "response.started",
      conversationId,
      generationId,
      userMessageId,
      messageId,
      revision: 1,
    })}\n`,
  );
}

type ConversationComposer = Extract<DraftEditorComposer, { kind: "conversation" }>;

function RuntimeProbe({ capture }: { readonly capture: (runtime: ChatRuntime) => void }) {
  const runtime = useChatRuntime();
  useEffect(() => capture(runtime), [capture, runtime]);
  return null;
}

function renderComposer(
  overrides: Partial<Omit<ConversationComposer, "kind">> = {},
  captureRuntime?: (runtime: ChatRuntime) => void,
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <DraftMemoryProvider queryScope={queryScope}>
          <ChatRuntimeProvider>
            {captureRuntime ? <RuntimeProbe capture={captureRuntime} /> : null}
            <DraftEditor
              scope={{ kind: "conversation", conversationId }}
              composer={{
                kind: "conversation",
                conversationId,
                isArchived: false,
                isCoherent: true,
                isRefreshing: false,
                observedRevision: 0,
                parentMessageId: null,
                ...overrides,
              }}
              modelTier="balanced"
              tierAvailable
              autoFocus
            />
          </ChatRuntimeProvider>
        </DraftMemoryProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
  return { ...view, queryClient };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("streaming composer", () => {
  it("keeps the compaction fallback warning visible while generation continues", async () => {
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
      },
    });
    const fetchMock = vi.fn(async (url: string, options?: RequestInit) => {
      if (url.endsWith("/draft") && options?.method === "PUT") {
        return json(draft("Pregunta extensa", 1));
      }
      if (url.endsWith("/draft")) {
        return json(draft("", 0));
      }
      if (url.endsWith("/responses")) {
        return new Response(stream, {
          headers: { "content-type": "application/x-ndjson" },
          status: 200,
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderComposer();

    const editor = await screen.findByRole("textbox", { name: copy.conversations.draft.label });
    await waitFor(() => expect(editor).toBeEnabled());
    fireEvent.change(editor, { target: { value: "Pregunta extensa" } });
    fireEvent.click(
      screen.getByRole("button", { name: copy.conversations.generation.actions.send }),
    );
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/responses"))).toBe(true),
    );

    await act(async () => {
      streamController.enqueue(responseStarted());
      streamController.enqueue(
        new TextEncoder().encode(
          `${JSON.stringify({ type: "context.compacting" })}\n${JSON.stringify({
            code: "CONTEXT_COMPACTION_FALLBACK",
            type: "context.warning",
          })}\n`,
        ),
      );
    });

    expect(
      await screen.findByText(copy.conversations.generation.status.contextFallback),
    ).toHaveAttribute("role", "status");
    expect(screen.getByText(copy.conversations.generation.status.generating)).toBeInTheDocument();
  });

  it("sends on desktop Enter, fences the confirmed draft, and resets only after start", async () => {
    let resolveResponse!: (response: Response) => void;
    const responseRequest = new Promise<Response>((resolve) => {
      resolveResponse = resolve;
    });
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
      },
    });
    const fetchMock = vi.fn(async (url: string, options?: RequestInit) => {
      if (url.endsWith("/draft") && options?.method === "PUT") {
        return json(draft("Pregunta exacta", 1));
      }
      if (url.endsWith("/draft")) {
        return json(draft("", 0));
      }
      if (url.endsWith("/responses")) {
        return responseRequest;
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderComposer();

    const editor = await screen.findByRole("textbox", { name: copy.conversations.draft.label });
    await waitFor(() => expect(editor).toBeEnabled());
    fireEvent.change(editor, { target: { value: "Pregunta exacta" } });
    fireEvent.keyDown(editor, { key: "Enter" });

    await waitFor(() => expect(editor).toHaveAttribute("readonly"));
    expect(editor).toHaveValue("Pregunta exacta");
    const streamCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/responses"));
    expect(streamCall).toBeDefined();
    expect(JSON.parse(String(streamCall?.[1]?.body))).toEqual({
      source: "draft",
      parentMessageId: null,
      content: [{ type: "text", text: "Pregunta exacta" }],
      modelTier: "balanced",
      observedRevision: 0,
      draftRevision: 1,
    });

    resolveResponse(
      new Response(stream, { status: 200, headers: { "content-type": "application/x-ndjson" } }),
    );
    streamController.enqueue(responseStarted());

    await waitFor(() => expect(editor).not.toHaveAttribute("readonly"));
    await waitFor(() => expect(editor).toHaveValue(""));
    expect(editor).toHaveFocus();
    fireEvent.change(editor, { target: { value: "Siguiente borrador" } });
    expect(editor).toHaveValue("Siguiente borrador");
    const stopButton = screen.getByRole("button", {
      name: copy.conversations.generation.actions.stop,
    });
    expect(stopButton).toBeEnabled();
    fireEvent.click(stopButton);
    await waitFor(() => expect(editor).toHaveFocus());
  });

  it("keeps mobile Enter as a newline gesture and sends from the visible button", async () => {
    vi.stubGlobal("matchMedia", () => ({
      matches: true,
      media: "",
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
      },
    });
    const fetchMock = vi.fn(async (url: string, options?: RequestInit) => {
      if (url.endsWith("/draft") && options?.method === "PUT") {
        return json(draft("Pregunta móvil", 1));
      }
      if (url.endsWith("/draft")) {
        return json(draft("", 0));
      }
      if (url.endsWith("/responses")) {
        return new Response(stream, {
          status: 200,
          headers: { "content-type": "application/x-ndjson" },
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderComposer();

    const editor = await screen.findByRole("textbox", { name: copy.conversations.draft.label });
    await waitFor(() => expect(editor).toBeEnabled());
    fireEvent.change(editor, { target: { value: "Pregunta móvil" } });
    fireEvent.keyDown(editor, { key: "Enter" });
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/responses"))).toBe(false);

    fireEvent.click(
      screen.getByRole("button", { name: copy.conversations.generation.actions.send }),
    );
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/responses"))).toBe(true),
    );
    streamController.enqueue(responseStarted());
    await waitFor(() => expect(editor).toHaveFocus());
    await waitFor(() => expect(editor).toHaveValue(""));
  });

  it("does not submit desktop Shift+Enter, key repeat, or IME composition", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/draft")) {
        return json(draft("", 0));
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderComposer();

    const editor = await screen.findByRole("textbox", { name: copy.conversations.draft.label });
    await waitFor(() => expect(editor).toBeEnabled());
    fireEvent.change(editor, { target: { value: "Sin envío" } });
    fireEvent.keyDown(editor, { key: "Enter", shiftKey: true });
    fireEvent.keyDown(editor, { key: "Enter", repeat: true });
    fireEvent.keyDown(editor, { key: "Enter", isComposing: true });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("shows a stable existing-conversation preflight error and preserves the draft", async () => {
    const fetchMock = vi.fn(async (url: string, options?: RequestInit) => {
      if (url.endsWith("/draft") && options?.method === "PUT") {
        return json(draft("Borrador preservado", 1));
      }
      if (url.endsWith("/draft")) {
        return json(draft("", 0));
      }
      if (url.endsWith("/responses")) {
        return json(
          {
            code: "DRAFT_CHANGED",
            message: "backend prose is ignored",
            requestId: "request-1",
          },
          409,
        );
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderComposer();

    const editor = await screen.findByRole("textbox", { name: copy.conversations.draft.label });
    await waitFor(() => expect(editor).toBeEnabled());
    fireEvent.change(editor, { target: { value: "Borrador preservado" } });
    fireEvent.click(
      screen.getByRole("button", { name: copy.conversations.generation.actions.send }),
    );

    expect(
      await screen.findByText(copy.conversations.generation.errors.draftChanged),
    ).toHaveAttribute("role", "alert");
    expect(editor).toHaveValue("Borrador preservado");
    expect(editor).not.toHaveAttribute("readonly");
  });

  it.each(["wrong-content-type", "eof-before-start"] as const)(
    "consumes the committed draft and reports ambiguous recovery for %s",
    async (mode) => {
      const fetchMock = vi.fn(async (url: string, options?: RequestInit) => {
        if (url.endsWith("/draft") && options?.method === "PUT") {
          return json(draft("Pregunta comprometida", 1));
        }
        if (url.endsWith("/draft")) {
          return json(draft("", 0));
        }
        if (url.endsWith("/responses")) {
          if (mode === "wrong-content-type") {
            return json({ committed: true });
          }
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.close();
              },
            }),
            { status: 200, headers: { "content-type": "application/x-ndjson" } },
          );
        }
        if (url.endsWith(`/api/conversations/${conversationId}`)) {
          return json({
            conversation: {
              id: conversationId,
              title: "Pregunta comprometida",
              isArchived: false,
              revision: 2,
              createdAt: "2026-08-07T12:00:00.000Z",
              updatedAt: "2026-08-07T12:00:01.000Z",
            },
            selectedLeafId: messageId,
            messages: [
              {
                id: userMessageId,
                parentMessageId: null,
                role: "user",
                content: [{ type: "text", text: "Pregunta comprometida" }],
                createdAt: "2026-08-07T12:00:00.000Z",
                siblingCount: 0,
              },
              {
                id: messageId,
                parentMessageId: userMessageId,
                role: "assistant",
                content: [{ type: "text", text: "" }],
                createdAt: "2026-08-07T12:00:01.000Z",
                siblingCount: 0,
              },
            ],
            nextCursor: null,
          });
        }
        throw new Error(`Unexpected request: ${url}`);
      });
      vi.stubGlobal("fetch", fetchMock);
      renderComposer();

      const editor = await screen.findByRole("textbox", { name: copy.conversations.draft.label });
      await waitFor(() => expect(editor).toBeEnabled());
      fireEvent.change(editor, { target: { value: "Pregunta comprometida" } });
      fireEvent.click(
        screen.getByRole("button", { name: copy.conversations.generation.actions.send }),
      );

      expect(
        await screen.findByText(copy.conversations.generation.errors.ambiguous),
      ).toHaveAttribute("role", "alert");
      await waitFor(() => expect(editor).toHaveValue(""));
      expect(editor).not.toHaveAttribute("readonly");
    },
  );

  it("preserves a newer draft when late ambiguous-start recovery proves the sent turn", async () => {
    let runtime: ChatRuntime | undefined;
    let responseAttempts = 0;
    let canonicalReads = 0;
    let nextDraftSaves = 0;
    let serverDraft = draft("", 0);
    const fetchMock = vi.fn(async (url: string, options?: RequestInit) => {
      if (url.endsWith("/draft") && options?.method === "PUT") {
        const body = JSON.parse(String(options.body)) as {
          content: string;
          observedRevision: number;
        };
        if (body.observedRevision !== serverDraft.revision) {
          return json(
            {
              code: "DRAFT_CHANGED",
              message: "Draft changed",
              requestId: "request-draft-conflict",
            },
            409,
          );
        }
        serverDraft = draft(body.content, body.observedRevision + 1);
        if (body.content === "Siguiente borrador") {
          nextDraftSaves += 1;
        }
        return json(serverDraft);
      }
      if (url.endsWith("/draft")) {
        return json(serverDraft);
      }
      if (url.endsWith("/responses")) {
        responseAttempts += 1;
        if (responseAttempts === 1) {
          serverDraft = draft("", 0);
          throw new TypeError("request status unknown");
        }
        return json(
          {
            code: "GENERATION_ALREADY_EXISTS",
            message: "Generation already exists",
            requestId: "request-replay",
          },
          409,
        );
      }
      if (url.endsWith(`/api/conversations/${conversationId}`)) {
        canonicalReads += 1;
        const committed = canonicalReads >= 3;
        return json({
          conversation: {
            id: conversationId,
            title: committed ? "Pregunta enviada" : null,
            isArchived: false,
            revision: committed ? 2 : 0,
            createdAt: "2026-08-07T12:00:00.000Z",
            updatedAt: "2026-08-07T12:00:01.000Z",
          },
          selectedLeafId: committed ? messageId : null,
          messages: committed
            ? [
                {
                  id: userMessageId,
                  parentMessageId: null,
                  role: "user",
                  content: [{ type: "text", text: "Pregunta enviada" }],
                  createdAt: "2026-08-07T12:00:00.000Z",
                  siblingCount: 0,
                },
                {
                  id: messageId,
                  parentMessageId: userMessageId,
                  role: "assistant",
                  content: [{ type: "text", text: "" }],
                  createdAt: "2026-08-07T12:00:01.000Z",
                  siblingCount: 0,
                },
              ]
            : [],
          nextCursor: null,
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const { queryClient } = renderComposer({}, (current) => {
      runtime = current;
    });

    const editor = await screen.findByRole("textbox", { name: copy.conversations.draft.label });
    await waitFor(() => expect(editor).toBeEnabled());
    await waitFor(() => expect(runtime).toBeDefined());
    fireEvent.change(editor, { target: { value: "Pregunta enviada" } });
    fireEvent.click(
      screen.getByRole("button", { name: copy.conversations.generation.actions.send }),
    );

    expect(await screen.findByText(copy.conversations.generation.errors.ambiguous)).toHaveAttribute(
      "role",
      "alert",
    );
    vi.useFakeTimers();
    fireEvent.change(editor, { target: { value: "Siguiente borrador" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    expect(
      screen.getByRole("heading", { name: copy.conversations.draft.conflictTitle }),
    ).toBeVisible();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: copy.conversations.draft.replaceServer }));
    });
    expect(document.querySelector(".draft-save-status")).toHaveTextContent(
      copy.conversations.draft.saved,
    );
    expect(serverDraft).toMatchObject({ content: "Siguiente borrador", revision: 1 });
    expect(nextDraftSaves).toBe(1);

    await act(async () => {
      await runtime?.recoverConversation(conversationId);
    });

    expect(responseAttempts).toBe(2);
    expect(canonicalReads).toBe(3);
    expect(editor).toHaveValue("Siguiente borrador");
    expect(
      queryClient.getQueryData(
        conversationQueryKeys.draft(queryScope, {
          kind: "conversation",
          conversationId,
        }),
      ),
    ).toMatchObject({ content: "Siguiente borrador", revision: 1 });
    expect(nextDraftSaves).toBe(1);
    expect(
      screen.queryByRole("heading", { name: copy.conversations.draft.conflictTitle }),
    ).not.toBeInTheDocument();
    expect(editor).toHaveValue("Siguiente borrador");
  });

  it("keeps remote Stop available when the draft cannot be loaded", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/draft")) {
        return json(
          { code: "INTERNAL_ERROR", message: "hidden backend detail", requestId: "request-1" },
          500,
        );
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderComposer({ remoteGeneration: { generationId, messageId } });

    expect(await screen.findByRole("alert")).toBeVisible();
    expect(
      screen.getByRole("button", { name: copy.conversations.generation.actions.stop }),
    ).toBeEnabled();
  });

  it("announces remote completion independently from the saved draft status", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/draft")) {
        return json(draft("", 0));
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderComposer({ remoteOutcome: "completed" });

    expect(await screen.findByText(copy.conversations.generation.status.completed)).toHaveAttribute(
      "role",
      "status",
    );
    expect(await screen.findByText(copy.conversations.draft.saved)).toHaveAttribute(
      "role",
      "status",
    );
    const editor = screen.getByRole("textbox", { name: copy.conversations.draft.label });
    fireEvent.change(editor, { target: { value: "Borrador independiente" } });
    expect(screen.getByText(copy.conversations.generation.status.completed)).toHaveAttribute(
      "role",
      "status",
    );
    expect(screen.getByText(copy.conversations.draft.unsaved)).toHaveAttribute("role", "status");
  });

  it("keeps remote generation status and failed next-draft persistence visible", async () => {
    const fetchMock = vi.fn(async (url: string, options?: RequestInit) => {
      if (url.endsWith("/draft") && options?.method === "PUT") {
        return json(
          { code: "INTERNAL_ERROR", message: "hidden backend detail", requestId: "request-2" },
          500,
        );
      }
      if (url.endsWith("/draft")) {
        return json(draft("", 0));
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderComposer({
      isCoherent: false,
      isRefreshing: false,
      remoteGeneration: { generationId, messageId },
    });

    const editor = await screen.findByRole("textbox", { name: copy.conversations.draft.label });
    await waitFor(() => expect(editor).toBeEnabled());
    fireEvent.change(editor, { target: { value: "Siguiente borrador" } });
    expect(screen.getByText(copy.conversations.generation.status.generating)).toHaveAttribute(
      "role",
      "status",
    );
    expect(screen.getByText(copy.conversations.draft.unsaved)).toHaveAttribute("role", "status");
    await waitFor(
      () =>
        expect(
          fetchMock.mock.calls.some(
            ([url, options]) => String(url).endsWith("/draft") && options?.method === "PUT",
          ),
        ).toBe(true),
      { timeout: 1_500 },
    );
    expect(screen.getByText(copy.conversations.generation.status.generating)).toHaveAttribute(
      "role",
      "status",
    );
    expect(screen.getByRole("button", { name: copy.conversations.draft.retry })).toBeVisible();
  });

  it("does not remeasure a long next draft for streamed response frames", async () => {
    let frame: FrameRequestCallback | undefined;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frame = callback;
      return 1;
    });
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
      },
    });
    const fetchMock = vi.fn(async (url: string, options?: RequestInit) => {
      if (url.endsWith("/draft") && options?.method === "PUT") {
        const body = JSON.parse(String(options.body)) as { content: string };
        return json(draft(body.content, 1));
      }
      if (url.endsWith("/draft")) {
        return json(draft("", 0));
      }
      if (url.endsWith("/responses")) {
        return new Response(stream, {
          status: 200,
          headers: { "content-type": "application/x-ndjson" },
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderComposer();

    const editor = await screen.findByRole("textbox", { name: copy.conversations.draft.label });
    await waitFor(() => expect(editor).toBeEnabled());
    let measurements = 0;
    Object.defineProperty(editor, "scrollHeight", {
      configurable: true,
      get: () => {
        measurements += 1;
        return 320;
      },
    });
    fireEvent.change(editor, { target: { value: "Pregunta" } });
    fireEvent.click(
      screen.getByRole("button", { name: copy.conversations.generation.actions.send }),
    );
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/responses"))).toBe(true),
    );
    streamController.enqueue(responseStarted());
    await waitFor(() => expect(editor).toHaveValue(""));
    fireEvent.change(editor, { target: { value: "Siguiente borrador\n".repeat(40) } });
    await waitFor(() => expect(measurements).toBeGreaterThan(0));
    const afterDraftChange = measurements;

    streamController.enqueue(
      new TextEncoder().encode(
        `${JSON.stringify({ type: "content.delta", text: "Respuesta parcial" })}\n`,
      ),
    );
    await waitFor(() => expect(frame).toBeTypeOf("function"));
    await act(async () => {
      frame?.(0);
      await Promise.resolve();
    });

    expect(measurements).toBe(afterDraftChange);
  });
});

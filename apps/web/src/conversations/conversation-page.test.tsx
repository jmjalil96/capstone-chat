import type {
  ConversationDetailResponse,
  ResponseState,
  SessionResponse,
} from "@capstone/protocol";
import { type InfiniteData, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect, useState } from "react";
import { createMemoryRouter, Outlet } from "react-router";
import { RouterProvider } from "react-router/dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { copy } from "../copy";
import { conversationQueryKeys, draftScopeKey } from "./api";
import type { ChatRuntime } from "./chat-runtime";
import { ChatRuntimeProvider, useChatRuntime } from "./chat-runtime-provider";
import { ConversationPage } from "./conversation-page";
import { DraftEditor } from "./draft-editor";
import { DraftMemoryProvider, useDraftMemory } from "./draft-memory";
import { ProtectedDraftLayout } from "./protected-draft-layout";

const conversationId = "11111111-1111-4111-8111-111111111111";
const queryScope = ["workspace-1", "employee-1", "2026-08-06T12:00:00.000Z"] as const;

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function conversationMessage(
  id: string,
  parentMessageId: string | null,
  role: "assistant" | "user",
  text: string,
) {
  return {
    id,
    parentMessageId,
    role,
    content: [{ type: "text" as const, text }],
    createdAt: "2026-08-06T12:00:00.000Z",
    siblingCount: 0,
  };
}

function streamLine(event: unknown): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(event)}\n`);
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
  it("keeps an active runtime across metadata refreshes and rotates it with authentication scope", async () => {
    const session = {
      employee: { id: "employee-1", name: "Ana", email: "ana@example.test" },
      workspace: {
        id: "workspace-1",
        identity: "capstone",
        name: "Capstone",
        role: "member",
      },
      session: {
        createdAt: "2026-08-06T12:00:00.000Z",
        expiresAt: "2026-08-13T12:00:00.000Z",
      },
    } satisfies SessionResponse;
    const runtimes: ChatRuntime[] = [];
    let updateSession!: (next: SessionResponse) => void;
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
      },
    });

    function SessionHarness() {
      const [current, setCurrent] = useState<SessionResponse>(session);
      updateSession = setCurrent;
      return <Outlet context={current} />;
    }

    function RuntimeProbe() {
      const runtime = useChatRuntime();
      useEffect(() => {
        runtimes.push(runtime);
      }, [runtime]);
      return null;
    }

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(stream, {
            status: 200,
            headers: { "content-type": "application/x-ndjson" },
          }),
      ),
    );
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const router = createMemoryRouter([
      {
        Component: SessionHarness,
        children: [
          {
            Component: ProtectedDraftLayout,
            children: [{ path: "/", Component: RuntimeProbe }],
          },
        ],
      },
    ]);
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(runtimes).toHaveLength(1));

    const runtime = runtimes[0];
    if (!runtime) {
      throw new Error("The authenticated runtime did not mount");
    }
    const started = runtime.startResponse(conversationId, {
      source: "continue",
      parentMessageId: "22222222-2222-4222-8222-222222222222",
      modelTier: "balanced",
      observedRevision: 1,
    });
    streamController.enqueue(
      streamLine({
        type: "response.started",
        conversationId,
        generationId: "33333333-3333-4333-8333-333333333333",
        userMessageId: "44444444-4444-4444-8444-444444444444",
        messageId: "55555555-5555-4555-8555-555555555555",
        revision: 2,
      }),
    );
    await started;

    await act(async () => {
      updateSession({
        ...session,
        session: { ...session.session, expiresAt: "2026-08-14T12:00:00.000Z" },
      });
      await Promise.resolve();
    });
    expect(runtimes).toHaveLength(1);
    expect(runtime.getSnapshot(conversationId)?.phase).toBe("generating");
    streamController.enqueue(streamLine({ type: "content.delta", text: "Sigue activa" }));
    await waitFor(() => expect(runtime.getSnapshot(conversationId)?.text).toBe("Sigue activa"));

    await act(async () => {
      updateSession({
        ...session,
        session: {
          createdAt: "2026-08-07T12:00:00.000Z",
          expiresAt: "2026-08-14T12:00:00.000Z",
        },
      });
      await Promise.resolve();
    });
    await waitFor(() => expect(runtimes.length).toBeGreaterThan(1));
    await waitFor(() => expect(runtime.getSnapshot(conversationId)).toBeUndefined());
    const runtimeAfterSessionRotation = runtimes.at(-1);
    const runtimeCountAfterSessionRotation = runtimes.length;

    await act(async () => {
      updateSession({
        ...session,
        employee: { ...session.employee, id: "employee-2" },
        session: {
          createdAt: "2026-08-07T12:00:00.000Z",
          expiresAt: "2026-08-14T12:00:00.000Z",
        },
      });
      await Promise.resolve();
    });
    await waitFor(() => expect(runtimes.length).toBeGreaterThan(runtimeCountAfterSessionRotation));
    expect(runtimes.at(-1)).not.toBe(runtimeAfterSessionRotation);
  });

  it("presents a committed typed turn in order before canonical detail catches up", async () => {
    const userMessageId = "22222222-2222-4222-8222-222222222222";
    const assistantMessageId = "33333333-3333-4333-8333-333333333333";
    const generationId = "44444444-4444-4444-8444-444444444444";
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
      },
    });
    let detailReads = 0;
    let resolveCanonical!: (response: Response) => void;
    const canonicalRead = new Promise<Response>((resolve) => {
      resolveCanonical = resolve;
    });
    const summary = (revision: number) => ({
      id: conversationId,
      title: "Turno superpuesto",
      isArchived: false,
      revision,
      createdAt: "2026-08-06T12:00:00.000Z",
      updatedAt: "2026-08-06T12:00:00.000Z",
    });
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";
      if (url.endsWith(`/api/conversations/${conversationId}/draft`) && method === "PUT") {
        const body = JSON.parse(String(init?.body)) as { content: string };
        return json({
          scope: { kind: "conversation", conversationId },
          content: body.content,
          revision: 1,
          updatedAt: "2026-08-06T12:00:01.000Z",
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
      if (url.endsWith(`/api/conversations/${conversationId}/responses`)) {
        return new Response(stream, {
          status: 200,
          headers: { "content-type": "application/x-ndjson" },
        });
      }
      if (url.endsWith(`/api/conversations/${conversationId}/response-states`)) {
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
        detailReads += 1;
        if (detailReads === 1) {
          return json({
            conversation: summary(0),
            selectedLeafId: null,
            messages: [],
            nextCursor: null,
          });
        }
        return canonicalRead;
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const router = createMemoryRouter(
      [{ path: "/c/:conversationId", Component: ConversationPage }],
      { initialEntries: [`/c/${conversationId}`] },
    );
    const user = userEvent.setup();
    render(
      <QueryClientProvider client={queryClient}>
        <DraftMemoryProvider queryScope={queryScope}>
          <ChatRuntimeProvider>
            <RouterProvider router={router} />
          </ChatRuntimeProvider>
        </DraftMemoryProvider>
      </QueryClientProvider>,
    );

    const editor = await screen.findByRole("textbox", { name: copy.conversations.draft.label });
    await waitFor(() => expect(editor).toBeEnabled());
    await user.type(editor, "Pregunta superpuesta");
    await user.click(
      screen.getByRole("button", { name: copy.conversations.generation.actions.send }),
    );
    streamController.enqueue(
      streamLine({
        type: "response.started",
        conversationId,
        generationId,
        userMessageId,
        messageId: assistantMessageId,
        revision: 1,
      }),
    );
    streamController.enqueue(streamLine({ type: "content.delta", text: "Respuesta parcial" }));

    await screen.findByText("Respuesta parcial", { exact: true });
    const presentedIds = () =>
      [...document.querySelectorAll<HTMLElement>(".message")].map(
        (element) => element.dataset.messageId,
      );
    expect(presentedIds()).toEqual([userMessageId, assistantMessageId]);
    expect(
      [...document.querySelectorAll<HTMLElement>(".message-content")].map(
        (element) => element.textContent,
      ),
    ).toEqual(["Pregunta superpuesta", "Respuesta parcial"]);

    await act(async () => {
      resolveCanonical(
        json({
          conversation: summary(1),
          selectedLeafId: assistantMessageId,
          messages: [
            conversationMessage(userMessageId, null, "user", "Pregunta superpuesta"),
            conversationMessage(assistantMessageId, userMessageId, "assistant", ""),
          ],
          nextCursor: null,
        }),
      );
      await canonicalRead;
    });
    await waitFor(() => expect(detailReads).toBeGreaterThan(1));
    expect(presentedIds()).toEqual([userMessageId, assistantMessageId]);
    expect(document.querySelectorAll(".message")).toHaveLength(2);
  });

  it("withholds a Continue assistant until its canonical user parent is available", async () => {
    const initialUserId = "22222222-2222-4222-8222-222222222222";
    const initialAssistantId = "33333333-3333-4333-8333-333333333333";
    const continuedUserId = "44444444-4444-4444-8444-444444444444";
    const continuedAssistantId = "55555555-5555-4555-8555-555555555555";
    const generationId = "66666666-6666-4666-8666-666666666666";
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
      },
    });
    let detailReads = 0;
    let resolveCanonical!: (response: Response) => void;
    const canonicalRead = new Promise<Response>((resolve) => {
      resolveCanonical = resolve;
    });
    const summary = (revision: number) => ({
      id: conversationId,
      title: "Continuación ordenada",
      isArchived: false,
      revision,
      createdAt: "2026-08-06T12:00:00.000Z",
      updatedAt: "2026-08-06T12:00:00.000Z",
    });
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith(`/api/conversations/${conversationId}/draft`)) {
        return json({
          scope: { kind: "conversation", conversationId },
          content: "Borrador separado",
          revision: 2,
          updatedAt: "2026-08-06T12:00:00.000Z",
        });
      }
      if (url.endsWith(`/api/conversations/${conversationId}/responses`)) {
        return new Response(stream, {
          status: 200,
          headers: { "content-type": "application/x-ndjson" },
        });
      }
      if (url.endsWith(`/api/conversations/${conversationId}/response-states`)) {
        const body = JSON.parse(String(init?.body)) as { messageIds: string[] };
        return json({
          conversationId,
          revision: body.messageIds.includes(continuedAssistantId) ? 3 : 2,
          responses: body.messageIds.flatMap<ResponseState>((id) =>
            id === initialAssistantId
              ? [
                  {
                    generationId: "77777777-7777-4777-8777-777777777777",
                    messageId: id,
                    status: "completed",
                    reason: "length",
                    errorCode: null,
                  },
                ]
              : id === continuedAssistantId
                ? [
                    {
                      generationId,
                      messageId: id,
                      status: "active",
                      reason: null,
                      errorCode: null,
                    },
                  ]
                : [],
          ),
        });
      }
      if (url.endsWith(`/api/conversations/${conversationId}`)) {
        detailReads += 1;
        if (detailReads === 1) {
          return json({
            conversation: summary(2),
            selectedLeafId: initialAssistantId,
            messages: [
              conversationMessage(initialUserId, null, "user", "Pregunta original"),
              conversationMessage(
                initialAssistantId,
                initialUserId,
                "assistant",
                "Respuesta truncada",
              ),
            ],
            nextCursor: null,
          });
        }
        return canonicalRead;
      }
      throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const router = createMemoryRouter(
      [{ path: "/c/:conversationId", Component: ConversationPage }],
      { initialEntries: [`/c/${conversationId}`] },
    );
    const user = userEvent.setup();
    render(
      <QueryClientProvider client={queryClient}>
        <DraftMemoryProvider queryScope={queryScope}>
          <ChatRuntimeProvider>
            <RouterProvider router={router} />
          </ChatRuntimeProvider>
        </DraftMemoryProvider>
      </QueryClientProvider>,
    );

    await user.click(
      await screen.findByRole("button", { name: copy.conversations.generation.actions.continue }),
    );
    streamController.enqueue(
      streamLine({
        type: "response.started",
        conversationId,
        generationId,
        userMessageId: continuedUserId,
        messageId: continuedAssistantId,
        revision: 3,
      }),
    );
    streamController.enqueue(
      streamLine({ type: "content.delta", text: "Continuación todavía no canónica" }),
    );
    await waitFor(() => expect(detailReads).toBeGreaterThan(1));
    expect(
      screen.queryByText("Continuación todavía no canónica", { exact: true }),
    ).not.toBeInTheDocument();
    expect(
      [...document.querySelectorAll<HTMLElement>(".message")].map(
        (element) => element.dataset.messageId,
      ),
    ).toEqual([initialUserId, initialAssistantId]);

    await act(async () => {
      resolveCanonical(
        json({
          conversation: summary(3),
          selectedLeafId: continuedAssistantId,
          messages: [
            conversationMessage(initialUserId, null, "user", "Pregunta original"),
            conversationMessage(
              initialAssistantId,
              initialUserId,
              "assistant",
              "Respuesta truncada",
            ),
            conversationMessage(continuedUserId, initialAssistantId, "user", "Continuar respuesta"),
            conversationMessage(continuedAssistantId, continuedUserId, "assistant", ""),
          ],
          nextCursor: null,
        }),
      );
      await canonicalRead;
    });
    expect(
      await screen.findByText("Continuación todavía no canónica", { exact: true }),
    ).toBeVisible();
    expect(
      [...document.querySelectorAll<HTMLElement>(".message")].map(
        (element) => element.dataset.messageId,
      ),
    ).toEqual([initialUserId, initialAssistantId, continuedUserId, continuedAssistantId]);
  });

  it("uses committed-response copy after a durable response.failed event", async () => {
    const userMessageId = "22222222-2222-4222-8222-222222222222";
    const assistantMessageId = "33333333-3333-4333-8333-333333333333";
    const generationId = "44444444-4444-4444-8444-444444444444";
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
      },
    });
    let detailReads = 0;
    let recoveryAvailable = false;
    let responseRequests = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";
      if (url.endsWith(`/api/conversations/${conversationId}/draft`) && method === "PUT") {
        const body = JSON.parse(String(init?.body)) as { content: string };
        return json({
          scope: { kind: "conversation", conversationId },
          content: body.content,
          revision: 1,
          updatedAt: "2026-08-06T12:00:00.000Z",
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
      if (url.endsWith(`/api/conversations/${conversationId}/responses`)) {
        responseRequests += 1;
        if (responseRequests > 1) {
          return json(
            { code: "DRAFT_CHANGED", message: "retry reached API", requestId: "request-retry" },
            409,
          );
        }
        return new Response(stream, {
          status: 200,
          headers: { "content-type": "application/x-ndjson" },
        });
      }
      if (url.endsWith(`/api/conversations/${conversationId}/response-states`)) {
        if (recoveryAvailable) {
          return json({
            conversationId,
            revision: 2,
            responses: [
              {
                generationId,
                messageId: assistantMessageId,
                status: "failed",
                reason: "error",
                errorCode: "GENERATION_FAILED",
              },
            ],
          });
        }
        return json(
          { code: "INTERNAL_ERROR", message: "hidden backend detail", requestId: "request-state" },
          500,
        );
      }
      if (url.endsWith(`/api/conversations/${conversationId}`)) {
        detailReads += 1;
        if (detailReads > 1 && !recoveryAvailable) {
          return json(
            {
              code: "INTERNAL_ERROR",
              message: "hidden backend detail",
              requestId: "request-detail",
            },
            500,
          );
        }
        if (recoveryAvailable) {
          return json({
            conversation: {
              id: conversationId,
              title: "Falla durable",
              isArchived: false,
              revision: 2,
              createdAt: "2026-08-06T12:00:00.000Z",
              updatedAt: "2026-08-06T12:00:02.000Z",
            },
            selectedLeafId: assistantMessageId,
            messages: [
              {
                id: userMessageId,
                parentMessageId: null,
                role: "user",
                content: [{ type: "text", text: "Pregunta" }],
                createdAt: "2026-08-06T12:00:01.000Z",
                siblingCount: 0,
              },
              {
                id: assistantMessageId,
                parentMessageId: userMessageId,
                role: "assistant",
                content: [{ type: "text", text: "" }],
                createdAt: "2026-08-06T12:00:01.000Z",
                siblingCount: 0,
              },
            ],
            nextCursor: null,
          });
        }
        return json({
          conversation: {
            id: conversationId,
            title: "Falla durable",
            isArchived: false,
            revision: 0,
            createdAt: "2026-08-06T12:00:00.000Z",
            updatedAt: "2026-08-06T12:00:00.000Z",
          },
          selectedLeafId: null,
          messages: [],
          nextCursor: null,
        });
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const router = createMemoryRouter(
      [{ path: "/c/:conversationId", Component: ConversationPage }],
      { initialEntries: [`/c/${conversationId}`] },
    );
    const user = userEvent.setup();
    render(
      <QueryClientProvider client={queryClient}>
        <DraftMemoryProvider queryScope={queryScope}>
          <ChatRuntimeProvider>
            <RouterProvider router={router} />
          </ChatRuntimeProvider>
        </DraftMemoryProvider>
      </QueryClientProvider>,
    );

    const editor = await screen.findByRole("textbox", { name: copy.conversations.draft.label });
    await waitFor(() => expect(editor).toBeEnabled());
    await user.type(editor, "Pregunta");
    await user.click(
      screen.getByRole("button", { name: copy.conversations.generation.actions.send }),
    );
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/responses"))).toBe(true),
    );
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
    await waitFor(() => expect(editor).toHaveValue(""));
    streamController.enqueue(
      new TextEncoder().encode(
        `${JSON.stringify({
          type: "response.failed",
          messageId: assistantMessageId,
          revision: 2,
          errorCode: "GENERATION_FAILED",
          partial: false,
        })}\n`,
      ),
    );
    streamController.close();

    expect(
      (await screen.findByText(copy.conversations.generation.errors.committed)).closest(
        '[role="alert"]',
      ),
    ).toBeVisible();
    expect(
      screen.queryByText(copy.conversations.generation.errors.generic),
    ).not.toBeInTheDocument();

    recoveryAvailable = true;
    await user.click(screen.getByRole("button", { name: copy.conversations.common.retry }));
    await waitFor(() =>
      expect(
        screen.queryByText(copy.conversations.generation.errors.committed),
      ).not.toBeInTheDocument(),
    );
    await user.type(editor, "Siguiente pregunta");
    await user.click(
      screen.getByRole("button", { name: copy.conversations.generation.actions.send }),
    );
    await waitFor(() => expect(responseRequests).toBe(2));
  });

  it("loads and merges bounded response states for every message page", async () => {
    const olderUserId = "22222222-2222-4222-8222-222222222222";
    const olderAssistantId = "33333333-3333-4333-8333-333333333333";
    const currentUserId = "44444444-4444-4444-8444-444444444444";
    const currentAssistantId = "55555555-5555-4555-8555-555555555555";
    const olderGenerationId = "66666666-6666-4666-8666-666666666666";
    const currentGenerationId = "77777777-7777-4777-8777-777777777777";
    const responseStateRequests: string[][] = [];
    const conversation = {
      id: conversationId,
      title: "Conversación paginada",
      isArchived: false,
      revision: 5,
      createdAt: "2026-08-06T12:00:00.000Z",
      updatedAt: "2026-08-06T12:00:05.000Z",
    };
    const message = (
      id: string,
      parentMessageId: string | null,
      role: "assistant" | "user",
      text: string,
    ) => ({
      id,
      parentMessageId,
      role,
      content: [{ type: "text", text }],
      createdAt: "2026-08-06T12:00:00.000Z",
      siblingCount: 0,
    });
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith(`/api/conversations/${conversationId}?cursor=cursor.signature`)) {
        return json({
          conversation,
          selectedLeafId: currentAssistantId,
          messages: [
            message(olderUserId, null, "user", "Pregunta anterior"),
            message(olderAssistantId, olderUserId, "assistant", "Respuesta anterior"),
          ],
          nextCursor: null,
        });
      }
      if (url.endsWith(`/api/conversations/${conversationId}/response-states`)) {
        const body = JSON.parse(String(init?.body)) as { messageIds: string[] };
        responseStateRequests.push(body.messageIds);
        return json({
          conversationId,
          revision: conversation.revision,
          responses: body.messageIds.flatMap((id) =>
            id === currentAssistantId
              ? [
                  {
                    generationId: currentGenerationId,
                    messageId: id,
                    status: "cancelled",
                    reason: "cancelled",
                    errorCode: null,
                  },
                ]
              : id === olderAssistantId
                ? [
                    {
                      generationId: olderGenerationId,
                      messageId: id,
                      status: "completed",
                      reason: "length",
                      errorCode: null,
                    },
                  ]
                : [],
          ),
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
      if (url.endsWith(`/api/conversations/${conversationId}`)) {
        return json({
          conversation,
          selectedLeafId: currentAssistantId,
          messages: [
            message(currentUserId, olderAssistantId, "user", "Pregunta actual"),
            message(currentAssistantId, currentUserId, "assistant", "Respuesta actual"),
          ],
          nextCursor: "cursor.signature",
        });
      }
      throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
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
      { initialEntries: [`/c/${conversationId}`] },
    );
    const user = userEvent.setup();
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    expect(
      (await screen.findAllByText(copy.conversations.generation.terminal.cancelled))[0],
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: copy.conversations.conversation.older }));
    expect(await screen.findByText(copy.conversations.generation.terminal.length)).toBeVisible();
    expect(responseStateRequests).toEqual(
      expect.arrayContaining([[currentAssistantId], [olderAssistantId]]),
    );
  });

  it("clears a failed pagination anchor before unrelated messages change", async () => {
    const firstMessageId = "22222222-2222-4222-8222-222222222222";
    const addedMessageId = "33333333-3333-4333-8333-333333333333";
    const summary = {
      id: conversationId,
      title: "Ancla de paginación",
      isArchived: false,
      revision: 1,
      createdAt: "2026-08-06T12:00:00.000Z",
      updatedAt: "2026-08-06T12:00:00.000Z",
    };
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith(`/api/conversations/${conversationId}?cursor=cursor.signature`)) {
        return json(
          { code: "INTERNAL_ERROR", message: "Page failed", requestId: "page-failed" },
          500,
        );
      }
      if (url.endsWith(`/api/conversations/${conversationId}/draft`)) {
        return json({
          scope: { kind: "conversation", conversationId },
          content: "",
          revision: 0,
          updatedAt: null,
        });
      }
      if (url.endsWith(`/api/conversations/${conversationId}`)) {
        return json({
          conversation: summary,
          selectedLeafId: firstMessageId,
          messages: [conversationMessage(firstMessageId, null, "user", "Mensaje inicial")],
          nextCursor: "cursor.signature",
        });
      }
      throw new Error(`Unexpected request: ${url}`);
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
      { initialEntries: [`/c/${conversationId}`] },
    );
    const user = userEvent.setup();
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    await screen.findByText("Mensaje inicial", { exact: true });
    const container = document.querySelector<HTMLElement>(".message-scroll");
    expect(container).not.toBeNull();
    let top = 7;
    const scrollWrites: number[] = [];
    Object.defineProperties(container, {
      scrollHeight: { configurable: true, get: () => 100 },
      scrollTop: {
        configurable: true,
        get: () => top,
        set: (value: number) => {
          top = value;
          scrollWrites.push(value);
        },
      },
    });
    await user.click(screen.getByRole("button", { name: copy.conversations.conversation.older }));
    await screen.findByRole("alert");
    const writesAfterFailure = scrollWrites.length;

    await act(async () => {
      queryClient.setQueryData<InfiniteData<ConversationDetailResponse>>(
        conversationQueryKeys.detail(queryScope, conversationId),
        (current) =>
          current
            ? {
                ...current,
                pages: current.pages.map((page, index) =>
                  index === 0
                    ? {
                        ...page,
                        messages: [
                          ...page.messages,
                          conversationMessage(
                            addedMessageId,
                            firstMessageId,
                            "user",
                            "Cambio no relacionado",
                          ),
                        ],
                      }
                    : page,
                ),
              }
            : current,
      );
    });
    await screen.findByText("Cambio no relacionado", { exact: true });
    expect(scrollWrites).toHaveLength(writesAfterFailure);
  });

  it("repositions after same-size cursor recovery succeeds on Retry", async () => {
    const messageId = "22222222-2222-4222-8222-222222222222";
    let canonicalReads = 0;
    const summary = (revision: number) => ({
      id: conversationId,
      title: "Recuperación de rama",
      isArchived: false,
      revision,
      createdAt: "2026-08-06T12:00:00.000Z",
      updatedAt: "2026-08-06T12:00:00.000Z",
    });
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
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
      if (url.endsWith(`/api/conversations/${conversationId}/draft`)) {
        return json({
          scope: { kind: "conversation", conversationId },
          content: "",
          revision: 0,
          updatedAt: null,
        });
      }
      if (url.endsWith(`/api/conversations/${conversationId}`)) {
        canonicalReads += 1;
        if (canonicalReads === 2) {
          return json(
            { code: "INTERNAL_ERROR", message: "Recovery failed", requestId: "recovery-failed" },
            500,
          );
        }
        return json({
          conversation: summary(canonicalReads === 1 ? 1 : 2),
          selectedLeafId: messageId,
          messages: [
            conversationMessage(
              messageId,
              null,
              "user",
              canonicalReads === 1 ? "Rama anterior" : "Rama recuperada",
            ),
          ],
          nextCursor: "cursor.signature",
        });
      }
      throw new Error(`Unexpected request: ${url}`);
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
      { initialEntries: [`/c/${conversationId}`] },
    );
    const user = userEvent.setup();
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    await screen.findByText("Rama anterior", { exact: true });
    const container = document.querySelector<HTMLElement>(".message-scroll");
    expect(container).not.toBeNull();
    let top = 0;
    const scrollWrites: number[] = [];
    Object.defineProperties(container, {
      scrollHeight: { configurable: true, get: () => 240 },
      scrollTop: {
        configurable: true,
        get: () => top,
        set: (value: number) => {
          top = value;
          scrollWrites.push(value);
        },
      },
    });

    await user.click(screen.getByRole("button", { name: copy.conversations.conversation.older }));
    await waitFor(() => expect(canonicalReads).toBe(2));
    expect(top).toBe(0);
    await user.click(screen.getByRole("button", { name: copy.conversations.common.retry }));

    expect(await screen.findByText("Rama recuperada", { exact: true })).toBeVisible();
    await waitFor(() => expect(top).toBe(240));
    expect(scrollWrites.at(-1)).toBe(240);
  });

  it("keeps Send disabled while reload lifecycle state is unresolved", async () => {
    const userMessageId = "22222222-2222-4222-8222-222222222222";
    const assistantMessageId = "33333333-3333-4333-8333-333333333333";
    const generationId = "44444444-4444-4444-8444-444444444444";
    let resolveResponseState!: (response: Response) => void;
    const responseState = new Promise<Response>((resolve) => {
      resolveResponseState = resolve;
    });
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith(`/api/conversations/${conversationId}/response-states`)) {
        return responseState;
      }
      if (url.endsWith(`/api/conversations/${conversationId}/draft`)) {
        return json({
          scope: { kind: "conversation", conversationId },
          content: "Siguiente pregunta",
          revision: 1,
          updatedAt: "2026-08-06T12:00:01.000Z",
        });
      }
      if (url.endsWith(`/api/conversations/${conversationId}`)) {
        return json({
          conversation: {
            id: conversationId,
            title: "Respuesta activa",
            isArchived: false,
            revision: 1,
            createdAt: "2026-08-06T12:00:00.000Z",
            updatedAt: "2026-08-06T12:00:01.000Z",
          },
          selectedLeafId: assistantMessageId,
          messages: [
            {
              id: userMessageId,
              parentMessageId: null,
              role: "user",
              content: [{ type: "text", text: "Pregunta" }],
              createdAt: "2026-08-06T12:00:00.000Z",
              siblingCount: 0,
            },
            {
              id: assistantMessageId,
              parentMessageId: userMessageId,
              role: "assistant",
              content: [{ type: "text", text: "Parcial" }],
              createdAt: "2026-08-06T12:00:01.000Z",
              siblingCount: 0,
            },
          ],
          nextCursor: null,
        });
      }
      throw new Error(`Unexpected request: ${url}`);
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
      { initialEntries: [`/c/${conversationId}`] },
    );
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    const editor = await screen.findByRole("textbox", { name: copy.conversations.draft.label });
    await waitFor(() => expect(editor).toHaveValue("Siguiente pregunta"));
    expect(
      screen.getByRole("button", { name: copy.conversations.generation.actions.send }),
    ).toBeDisabled();

    await act(async () => {
      resolveResponseState(
        json({
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
        }),
      );
      await responseState;
    });
    expect(
      await screen.findByRole("button", { name: copy.conversations.generation.actions.stop }),
    ).toBeVisible();
  });

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

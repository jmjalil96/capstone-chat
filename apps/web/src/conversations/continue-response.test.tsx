import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { copy } from "../copy";
import { seedModelTierQueries } from "../test/model-tier-fixture";
import { ChatRuntimeProvider } from "./chat-runtime-provider";
import { ConversationPage } from "./conversation-page";
import { DraftMemoryProvider } from "./draft-memory";

const queryScope = ["workspace-1", "employee-1", "2026-08-07T12:00:00.000Z"] as const;
const conversationId = "11111111-1111-4111-8111-111111111111";
const userMessageId = "22222222-2222-4222-8222-222222222222";
const messageId = "33333333-3333-4333-8333-333333333333";
const generationId = "44444444-4444-4444-8444-444444444444";

function json(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Continue response", () => {
  it("continues the selected length response at the coherent revision without consuming a draft", async () => {
    const secondConversationId = "88888888-8888-4888-8888-888888888888";
    const secondUserMessageId = "99999999-9999-4999-8999-999999999999";
    const secondMessageId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
      },
    });
    let continuationBody: unknown;
    let resolveSecondDraft!: (response: Response) => void;
    const secondDraft = new Promise<Response>((resolve) => {
      resolveSecondDraft = resolve;
    });
    const fetchMock = vi.fn(async (url: string, options?: RequestInit) => {
      if (url.endsWith(`/api/conversations/${secondConversationId}/response-states`)) {
        return json({
          conversationId: secondConversationId,
          revision: 1,
          responses: [
            {
              generationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
              messageId: secondMessageId,
              status: "completed",
              reason: "stop",
              errorCode: null,
            },
          ],
        });
      }
      if (url.endsWith(`/api/conversations/${secondConversationId}/draft`)) {
        return secondDraft;
      }
      if (url.endsWith(`/api/conversations/${secondConversationId}`)) {
        return json({
          conversation: {
            id: secondConversationId,
            title: "Conversación siguiente",
            isArchived: false,
            revision: 1,
            createdAt: "2026-08-07T12:00:00.000Z",
            updatedAt: "2026-08-07T12:00:01.000Z",
          },
          selectedLeafId: secondMessageId,
          messages: [
            {
              id: secondUserMessageId,
              parentMessageId: null,
              role: "user",
              content: [{ type: "text", text: "Segunda pregunta" }],
              createdAt: "2026-08-07T12:00:00.000Z",
              siblingCount: 0,
            },
            {
              id: secondMessageId,
              parentMessageId: secondUserMessageId,
              role: "assistant",
              content: [{ type: "text", text: "Segunda respuesta" }],
              createdAt: "2026-08-07T12:00:01.000Z",
              siblingCount: 0,
            },
          ],
          nextCursor: null,
        });
      }
      if (url.endsWith("/response-states")) {
        return json({
          conversationId,
          revision: 4,
          responses: [
            {
              generationId,
              messageId,
              status: "completed",
              reason: "length",
              errorCode: null,
            },
          ],
        });
      }
      if (url.endsWith("/draft")) {
        return json({
          scope: { kind: "conversation", conversationId },
          content: "Borrador separado",
          revision: 2,
          updatedAt: "2026-08-07T12:00:00.000Z",
        });
      }
      if (url.endsWith("/responses")) {
        continuationBody = JSON.parse(String(options?.body));
        return new Response(stream, {
          status: 200,
          headers: { "content-type": "application/x-ndjson" },
        });
      }
      if (url.endsWith(`/api/conversations/${conversationId}`)) {
        return json({
          conversation: {
            id: conversationId,
            title: "Respuesta extensa",
            isArchived: false,
            revision: 4,
            createdAt: "2026-08-07T12:00:00.000Z",
            updatedAt: "2026-08-07T12:00:01.000Z",
          },
          selectedLeafId: messageId,
          messages: [
            {
              id: userMessageId,
              parentMessageId: null,
              role: "user",
              content: [{ type: "text", text: "Explica el tema" }],
              createdAt: "2026-08-07T12:00:00.000Z",
              siblingCount: 0,
            },
            {
              id: messageId,
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
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    seedModelTierQueries(queryClient, queryScope, [conversationId, secondConversationId]);
    const router = createMemoryRouter(
      [{ path: "/c/:conversationId", Component: ConversationPage }],
      { initialEntries: [`/c/${conversationId}`] },
    );
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
    await waitFor(() => expect(editor).toHaveValue("Borrador separado"));
    const continueButton = await screen.findByRole("button", {
      name: copy.conversations.generation.actions.continue,
    });
    fireEvent.click(continueButton);

    await waitFor(() =>
      expect(continuationBody).toEqual({
        source: "continue",
        parentMessageId: messageId,
        modelTier: "balanced",
        observedRevision: 4,
      }),
    );
    expect(editor).toHaveValue("Borrador separado");
    expect(editor).not.toHaveAttribute("readonly");
    expect(
      fetchMock.mock.calls.filter(
        ([url, options]) => String(url).endsWith("/draft") && options?.method === "PUT",
      ),
    ).toHaveLength(0);

    streamController.enqueue(
      new TextEncoder().encode(
        `${JSON.stringify({
          type: "response.started",
          conversationId,
          generationId: "55555555-5555-4555-8555-555555555555",
          userMessageId: "66666666-6666-4666-8666-666666666666",
          messageId: "77777777-7777-4777-8777-777777777777",
          revision: 5,
        })}\n`,
      ),
    );
    await waitFor(() => expect(editor).toHaveFocus());
    expect(editor).toHaveValue("Borrador separado");

    await act(async () => {
      await router.navigate(`/c/${secondConversationId}`);
    });
    const secondHeading = await screen.findByRole("heading", {
      level: 1,
      name: "Conversación siguiente",
    });
    expect(secondHeading).toHaveFocus();
    await act(async () => {
      resolveSecondDraft(
        json({
          scope: { kind: "conversation", conversationId: secondConversationId },
          content: "Borrador siguiente",
          revision: 1,
          updatedAt: "2026-08-07T12:00:01.000Z",
        }),
      );
      await secondDraft;
    });
    const secondEditor = await screen.findByRole("textbox", {
      name: copy.conversations.draft.label,
    });
    await waitFor(() => expect(secondEditor).toHaveValue("Borrador siguiente"));
    expect(secondHeading).toHaveFocus();
    expect(secondEditor).not.toHaveFocus();
  });
});

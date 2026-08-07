import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ConversationStreamProtocolError,
  conversationActorScope,
  conversationQueryKeys,
  conversationQueryScope,
  fetchResponseStates,
  openConversationResponse,
  searchConversations,
} from "./api";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("conversation browser requests", () => {
  it("namespaces private cache keys by workspace, employee, and session generation", () => {
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
    } as const;

    expect(conversationQueryKeys.draft(conversationQueryScope(session), { kind: "new" })).toEqual([
      "conversations",
      "workspace-1",
      "employee-1",
      "2026-08-06T12:00:00.000Z",
      "draft",
      "new",
    ]);
    expect(conversationActorScope(session)).toEqual(["workspace-1", "employee-1"]);
    expect(
      conversationQueryKeys.all(
        conversationQueryScope({
          ...session,
          session: { ...session.session, createdAt: "2026-08-07T12:00:00.000Z" },
        }),
      ),
    ).not.toEqual(conversationQueryKeys.all(conversationQueryScope(session)));
  });

  it("keeps search text in a bounded POST body instead of the URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ results: [], nextCursor: null }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await searchConversations({ query: "póliza sintética" });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/conversations/search",
      expect.objectContaining({
        body: JSON.stringify({ query: "póliza sintética" }),
        credentials: "same-origin",
        method: "POST",
      }),
    );
    expect(fetchMock.mock.calls[0]?.[0]).not.toContain("póliza");
  });

  it("rejects a malformed response at the browser boundary", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ results: "not-a-page" }))),
    );

    await expect(searchConversations({ query: "texto" })).rejects.toThrow(
      "did not match the protocol",
    );
  });

  it("sends the exact streaming headers and rejects a successful non-stream response", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(stream, {
          status: 200,
          headers: { "content-type": "application/x-ndjson" },
        }),
      )
      .mockResolvedValueOnce(
        new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const signal = new AbortController().signal;
    const request = {
      source: "continue",
      parentMessageId: "11111111-1111-4111-8111-111111111111",
      modelTier: "balanced",
      observedRevision: 2,
    } as const;
    const key = "22222222-2222-4222-8222-222222222222";

    await openConversationResponse("33333333-3333-4333-8333-333333333333", request, key, signal);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/conversations/33333333-3333-4333-8333-333333333333/responses",
      expect.objectContaining({
        headers: {
          accept: "application/x-ndjson",
          "content-type": "application/json",
          "idempotency-key": key,
        },
      }),
    );
    await expect(
      openConversationResponse("33333333-3333-4333-8333-333333333333", request, key, signal),
    ).rejects.toBeInstanceOf(ConversationStreamProtocolError);
  });

  it("rejects response state outside the requested bounded message set", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            conversationId: "33333333-3333-4333-8333-333333333333",
            revision: 2,
            responses: [
              {
                generationId: "44444444-4444-4444-8444-444444444444",
                messageId: "55555555-5555-4555-8555-555555555555",
                status: "active",
                reason: null,
                errorCode: null,
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );

    await expect(
      fetchResponseStates("33333333-3333-4333-8333-333333333333", {
        messageIds: ["66666666-6666-4666-8666-666666666666"],
      }),
    ).rejects.toThrow("requested messages");
  });
});

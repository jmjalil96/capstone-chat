import { afterEach, describe, expect, it, vi } from "vitest";

import { subscribeSessionBoundary } from "../api/session-boundary";
import {
  ConversationHttpError,
  ConversationStreamProtocolError,
  conversationActorScope,
  conversationQueryKeys,
  conversationQueryScope,
  fetchAlternativeContexts,
  fetchConversationPreferredTier,
  fetchModelTierPolicy,
  fetchResponseStates,
  fetchResponseUpdates,
  openConversationResponse,
  searchConversations,
  undoConversation,
  updateConversationPreferredTier,
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

  it("reads only the employee tier policy and validates its stable shape", async () => {
    const policy = {
      defaultTier: "balanced",
      tiers: [
        { tier: "fast", enabled: true, available: true },
        { tier: "balanced", enabled: true, available: true },
        { tier: "pro", enabled: true, available: false },
      ],
    } as const;
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(policy), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchModelTierPolicy()).resolves.toEqual(policy);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/model-tiers",
      expect.objectContaining({
        credentials: "same-origin",
        headers: { accept: "application/json" },
      }),
    );
  });

  it("reads and updates a narrow conversation preference", async () => {
    const conversationId = "33333333-3333-4333-8333-333333333333";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ conversationId, modelTier: "balanced" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ conversationId, modelTier: "pro" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchConversationPreferredTier(conversationId)).resolves.toEqual({
      conversationId,
      modelTier: "balanced",
    });
    await expect(
      updateConversationPreferredTier(conversationId, { modelTier: "pro" }),
    ).resolves.toEqual({
      conversationId,
      modelTier: "pro",
    });
    expect(fetchMock).toHaveBeenLastCalledWith(
      `/api/conversations/${conversationId}/preferred-tier`,
      expect.objectContaining({ body: JSON.stringify({ modelTier: "pro" }), method: "PUT" }),
    );
  });

  it("rejects a preferred-tier response for another conversation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            conversationId: "44444444-4444-4444-8444-444444444444",
            modelTier: "fast",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );

    await expect(
      fetchConversationPreferredTier("33333333-3333-4333-8333-333333333333"),
    ).rejects.toThrow("requested resource");
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

  it("preserves an unparseable error response status without accepting malformed success", async () => {
    const conversationId = "33333333-3333-4333-8333-333333333333";
    const generationId = "44444444-4444-4444-8444-444444444444";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("Bad gateway", {
          status: 502,
          headers: { "content-type": "text/html" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "upstream unavailable" }), {
          status: 503,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response("not-json", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const unavailable = fetchResponseUpdates(conversationId, generationId, { cursor: null });
    await expect(unavailable).rejects.toBeInstanceOf(ConversationHttpError);
    await expect(unavailable).rejects.toMatchObject({ status: 502 });

    const nonconformingError = fetchResponseUpdates(conversationId, generationId, { cursor: null });
    await expect(nonconformingError).rejects.toBeInstanceOf(ConversationHttpError);
    await expect(nonconformingError).rejects.toMatchObject({ status: 503 });

    const malformedSuccess = fetchResponseUpdates(conversationId, generationId, { cursor: null });
    await expect(malformedSuccess).rejects.toThrow("was not valid JSON");
    await expect(malformedSuccess).rejects.not.toBeInstanceOf(ConversationHttpError);
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

  it("reports only workspace-denied 403 responses as a denied session boundary", async () => {
    const conversationId = "33333333-3333-4333-8333-333333333333";
    const generationId = "44444444-4444-4444-8444-444444444444";
    const boundaries: string[] = [];
    const unsubscribe = subscribeSessionBoundary((status) => boundaries.push(status));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            code: "WORKSPACE_ACCESS_DENIED",
            message: "Workspace access denied",
            requestId: "request-denied",
          }),
          { status: 403, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            code: "SESSION_REFRESH_REQUIRED",
            message: "Fresh session required",
            requestId: "request-fresh",
          }),
          { status: 403, headers: { "content-type": "application/json" } },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    try {
      await expect(
        fetchResponseUpdates(conversationId, generationId, { cursor: null }),
      ).rejects.toMatchObject({
        code: "WORKSPACE_ACCESS_DENIED",
        status: 403,
      });
      await expect(
        fetchResponseUpdates(conversationId, generationId, { cursor: null }),
      ).rejects.toMatchObject({
        code: "SESSION_REFRESH_REQUIRED",
        status: 403,
      });
      expect(boundaries).toEqual(["denied"]);
    } finally {
      unsubscribe();
    }
  });

  it("binds alternative-context caches to actor, revision, and a sorted message set", () => {
    const queryScope = ["workspace-1", "employee-1", "session-1"] as const;
    const ids = ["66666666-6666-4666-8666-666666666666", "55555555-5555-4555-8555-555555555555"];

    expect(conversationQueryKeys.alternativeContext(queryScope, "conversation-1", 7, ids)).toEqual([
      "conversations",
      ...queryScope,
      "alternative-context",
      "conversation-1",
      7,
      [...ids].sort(),
    ]);
  });

  it("requires one exact alternative context for every requested message", async () => {
    const conversationId = "33333333-3333-4333-8333-333333333333";
    const firstMessageId = "55555555-5555-4555-8555-555555555555";
    const secondMessageId = "66666666-6666-4666-8666-666666666666";
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          conversationId,
          revision: 3,
          contexts: [
            {
              messageId: firstMessageId,
              position: 1,
              total: 2,
              previousLeafMessageId: null,
              nextLeafMessageId: "77777777-7777-4777-8777-777777777777",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchAlternativeContexts(conversationId, {
        messageIds: [firstMessageId, secondMessageId],
      }),
    ).rejects.toThrow("requested messages");
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/conversations/${conversationId}/alternative-contexts`,
      expect.objectContaining({
        body: JSON.stringify({ messageIds: [firstMessageId, secondMessageId] }),
        method: "POST",
      }),
    );
  });

  it("posts Undo with the observed revision and validates the selected conversation", async () => {
    const conversationId = "33333333-3333-4333-8333-333333333333";
    const selectedLeafId = "55555555-5555-4555-8555-555555555555";
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          conversation: {
            id: conversationId,
            title: "Conversación",
            isArchived: false,
            revision: 4,
            createdAt: "2026-08-07T12:00:00.000Z",
            updatedAt: "2026-08-07T12:00:01.000Z",
          },
          selectedLeafId,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(undoConversation(conversationId, { observedRevision: 3 })).resolves.toMatchObject({
      selectedLeafId,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/conversations/${conversationId}/undo`,
      expect.objectContaining({ body: JSON.stringify({ observedRevision: 3 }), method: "POST" }),
    );
  });
});

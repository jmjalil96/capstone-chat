import { afterEach, describe, expect, it, vi } from "vitest";

import {
  conversationActorScope,
  conversationQueryKeys,
  conversationQueryScope,
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
});

import type { SessionResponse } from "@capstone/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  assistantRulesQueryKeys,
  assistantRulesQueryScope,
  fetchMemberAssistantRules,
} from "./assistant-rules-api";

const session = {
  employee: { id: "employee-1", name: "Ana", email: "ana@example.test" },
  workspace: {
    id: "workspace-1",
    identity: "capstone",
    name: "Capstone",
    role: "member",
  },
  session: {
    createdAt: "2026-08-17T12:00:00.000Z",
    expiresAt: "2026-08-24T12:00:00.000Z",
  },
} satisfies SessionResponse;

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    headers: { "content-type": "application/json" },
    status,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("member assistant rules API", () => {
  it("scopes the query and validates the read-only response", async () => {
    const signal = new AbortController().signal;
    const fetchMock = vi.fn().mockResolvedValue(
      json({
        baseVersion: "capstone-chat-base-v2",
        baseText: "REGLAS BASE",
        workspaceText: "Reglas del espacio",
        effectivePrompt: "Reglas del espacio\n\nREGLAS BASE",
        updatedAt: "2026-08-17T12:00:00.000Z",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const scope = assistantRulesQueryScope(session);

    expect(assistantRulesQueryKeys.member(scope)).toEqual([
      "assistant-rules",
      "workspace-1",
      "employee-1",
      "2026-08-17T12:00:00.000Z",
    ]);
    await expect(fetchMemberAssistantRules(signal)).resolves.toMatchObject({
      workspaceText: "Reglas del espacio",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/assistant-rules",
      expect.objectContaining({
        credentials: "same-origin",
        headers: { accept: "application/json" },
        signal,
      }),
    );
  });

  it("rejects responses that leak administrator fields", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        json({
          baseVersion: "capstone-chat-base-v2",
          baseText: "REGLAS BASE",
          workspaceText: "Reglas del espacio",
          effectivePrompt: "Reglas del espacio\n\nREGLAS BASE",
          updatedAt: "2026-08-17T12:00:00.000Z",
          actor: { kind: "system", label: "Sistema" },
        }),
      ),
    );

    await expect(fetchMemberAssistantRules()).rejects.toThrow(
      "The assistant rules response did not match the protocol.",
    );
  });
});

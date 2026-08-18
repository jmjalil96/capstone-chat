import type { SessionResponse } from "@capstone/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  type AdministrationApiError,
  administrationQueryScope,
  fetchAdminAssistantRulesHistory,
  fetchAdminEmployees,
  fetchAdminPolicy,
  fetchAdminPolicyHistory,
  previewAdminAssistantRules,
  refreshAdminCatalog,
  revertAdminAssistantRules,
  revertAdminPolicy,
  revokeAdminEmployeeSessions,
  updateAdminEmployeeSoftBudget,
} from "./api";

const session = {
  employee: { id: "employee-1", name: "Ana Pérez", email: "ana@example.test" },
  workspace: {
    id: "workspace-1",
    identity: "capstone",
    name: "Capstone",
    role: "admin",
  },
  session: {
    createdAt: "2026-08-08T12:00:00.000Z",
    expiresAt: "2026-08-15T12:00:00.000Z",
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

describe("administration API client", () => {
  it("scopes queries by workspace, employee, and authentication generation", () => {
    expect(administrationQueryScope(session)).toEqual([
      "workspace-1",
      "employee-1",
      "2026-08-08T12:00:00.000Z",
    ]);
  });

  it("encodes opaque cursors and validates employee pages", async () => {
    const signal = new AbortController().signal;
    const fetchMock = vi.fn().mockResolvedValue(
      json({
        items: [
          {
            approvalId: "11111111-1111-4111-8111-111111111111",
            userId: null,
            name: null,
            email: "pending@example.test",
            role: "member",
            status: "pending",
            monthlySoftBudgetUsd: null,
          },
        ],
        nextCursor: null,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchAdminEmployees("opaque cursor/+", signal)).resolves.toMatchObject({
      items: [{ email: "pending@example.test" }],
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/employees?cursor=opaque+cursor%2F%2B",
      expect.objectContaining({
        credentials: "same-origin",
        headers: { accept: "application/json" },
        signal,
      }),
    );
  });

  it("sends closed JSON mutation bodies and accepts only an empty revocation response", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        json({
          approvalId: "11111111-1111-4111-8111-111111111111",
          userId: "employee-2",
          name: "Luis Pérez",
          email: "luis@example.test",
          role: "member",
          status: "active",
          monthlySoftBudgetUsd: "25.000000000000000000",
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await updateAdminEmployeeSoftBudget("11111111-1111-4111-8111-111111111111", {
      monthlySoftBudgetUsd: "25.000000000000000000",
    });
    await revokeAdminEmployeeSessions("11111111-1111-4111-8111-111111111111");

    expect(fetchMock.mock.calls[0]).toEqual([
      "/api/admin/employees/11111111-1111-4111-8111-111111111111/soft-budget",
      expect.objectContaining({
        body: JSON.stringify({ monthlySoftBudgetUsd: "25.000000000000000000" }),
        credentials: "same-origin",
        headers: { accept: "application/json", "content-type": "application/json" },
        method: "PUT",
      }),
    ]);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "/api/admin/employees/11111111-1111-4111-8111-111111111111/sessions/revoke",
    );
  });

  it("surfaces stable API errors and rejects malformed success payloads", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        json(
          {
            code: "MODEL_POLICY_CHANGED",
            message: "Policy changed",
            requestId: "request-1",
          },
          409,
        ),
      )
      .mockResolvedValueOnce(json({ revision: 1, unexpected: true }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchAdminPolicy()).rejects.toEqual(
      expect.objectContaining<Partial<AdministrationApiError>>({
        code: "MODEL_POLICY_CHANGED",
        status: 409,
      }),
    );
    await expect(fetchAdminPolicy()).rejects.toThrow(
      "The administration response did not match the protocol.",
    );
  });

  it("passes the refresh cursor only in the JSON body", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        json({ available: 1, claimed: 1, unavailable: 0, updated: 1, nextCursor: null }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await refreshAdminCatalog({ cursor: "next-page" });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/model-catalog/refresh",
      expect.objectContaining({
        body: JSON.stringify({ cursor: "next-page" }),
        method: "POST",
      }),
    );
  });

  it("validates assistant previews and encodes assistant history cursors", async () => {
    const signal = new AbortController().signal;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        json({
          normalizedWorkspaceText: "Regla normalizada",
          effectivePrompt: "CONTEXTO EDITABLE\n\nRegla normalizada\n\nREGLAS BASE",
          estimate: {
            counts: { codePoints: 17, utf8Bytes: 17, approximateInputTokens: 5 },
            balancedMaximumResponseCostPercent: "0.25",
          },
        }),
      )
      .mockResolvedValueOnce(json({ items: [], nextCursor: null }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      previewAdminAssistantRules({ workspaceText: "Regla normalizada" }, signal),
    ).resolves.toMatchObject({ normalizedWorkspaceText: "Regla normalizada" });
    await expect(fetchAdminAssistantRulesHistory("opaque/assistant +")).resolves.toEqual({
      items: [],
      nextCursor: null,
    });

    expect(fetchMock.mock.calls[0]).toEqual([
      "/api/admin/assistant-rules/preview",
      expect.objectContaining({
        body: JSON.stringify({ workspaceText: "Regla normalizada" }),
        method: "POST",
        signal,
      }),
    ]);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "/api/admin/assistant-rules/revisions?cursor=opaque%2Fassistant+%2B",
    );
  });

  it("uses closed policy history and revision-revert endpoints", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ items: [], nextCursor: null }))
      .mockResolvedValueOnce(
        json(
          { code: "MODEL_POLICY_CONFLICT", message: "Conflict", requestId: "request-policy" },
          409,
        ),
      )
      .mockResolvedValueOnce(
        json(
          { code: "ASSISTANT_RULES_CHANGED", message: "Changed", requestId: "request-rules" },
          409,
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchAdminPolicyHistory()).resolves.toEqual({ items: [], nextCursor: null });
    await expect(revertAdminPolicy(7, { observedRevision: 9 })).rejects.toMatchObject({
      code: "MODEL_POLICY_CONFLICT",
    });
    await expect(revertAdminAssistantRules(4, { observedRevision: 6 })).rejects.toMatchObject({
      code: "ASSISTANT_RULES_CHANGED",
    });

    expect(fetchMock.mock.calls[1]).toEqual([
      "/api/admin/model-policy/revisions/7/revert",
      expect.objectContaining({
        body: JSON.stringify({ observedRevision: 9 }),
        method: "POST",
      }),
    ]);
    expect(fetchMock.mock.calls[2]?.[0]).toBe("/api/admin/assistant-rules/revisions/4/revert");
  });
});

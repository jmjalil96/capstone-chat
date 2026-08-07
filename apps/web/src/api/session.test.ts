import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchSession } from "./session";

const validSession = {
  employee: {
    id: "employee-1",
    name: "Ana Pérez",
    email: "ana@example.test",
  },
  workspace: {
    id: "workspace-1",
    identity: "capstone",
    name: "Capstone",
    role: "admin",
  },
  session: {
    createdAt: "2026-08-06T12:00:00.000Z",
    expiresAt: "2026-08-13T12:00:00.000Z",
  },
};

function response(payload: unknown, status: number): Response {
  return {
    json: vi.fn().mockResolvedValue(payload),
    status,
  } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchSession", () => {
  it("returns a validated authenticated session", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(validSession, 200));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchSession()).resolves.toEqual({
      status: "authenticated",
      session: validSession,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/session",
      expect.objectContaining({ credentials: "same-origin" }),
    );
  });

  it("maps the authentication error to an anonymous session", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        response(
          {
            code: "AUTHENTICATION_REQUIRED",
            message: "Authentication required",
            requestId: "request-1",
          },
          401,
        ),
      ),
    );

    await expect(fetchSession()).resolves.toEqual({ status: "anonymous" });
  });

  it("maps the workspace error to denied access", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        response(
          {
            code: "WORKSPACE_ACCESS_DENIED",
            message: "Workspace access denied",
            requestId: "request-2",
          },
          403,
        ),
      ),
    );

    await expect(fetchSession()).resolves.toEqual({ status: "denied" });
  });

  it("rejects malformed and mismatched session responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        response(
          {
            ...validSession,
            workspace: { ...validSession.workspace, role: "owner" },
          },
          200,
        ),
      ),
    );

    await expect(fetchSession()).rejects.toThrow("did not match the protocol");
  });
});

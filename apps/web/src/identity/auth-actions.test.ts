import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const client = vi.hoisted(() => ({
  changePassword: vi.fn(),
  requestPasswordReset: vi.fn(),
  resetPassword: vi.fn(),
  sendVerificationEmail: vi.fn(),
  signIn: { email: vi.fn() },
  signOut: vi.fn(),
  signUp: { email: vi.fn() },
}));

vi.mock("./auth-client", () => ({ authClient: client }));

import {
  type AuthActionError,
  changePassword,
  requestPasswordReset,
  resetPassword,
  sendVerificationEmail,
  signIn,
  signOut,
  signUp,
  verifyEmail,
} from "./auth-actions";

beforeEach(() => {
  vi.clearAllMocks();

  for (const request of [
    client.changePassword,
    client.requestPasswordReset,
    client.resetPassword,
    client.sendVerificationEmail,
    client.signIn.email,
    client.signOut,
    client.signUp.email,
  ]) {
    request.mockResolvedValue({ data: null, error: null });
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("auth actions", () => {
  it("uses Better Auth email/password endpoints with same-origin callbacks", async () => {
    await signUp({ name: "Ana", email: "ana@example.test", password: "abcdefghijkl" });
    await sendVerificationEmail("ana@example.test");
    await requestPasswordReset("ana@example.test");

    expect(client.signUp.email).toHaveBeenCalledWith({
      name: "Ana",
      email: "ana@example.test",
      password: "abcdefghijkl",
    });
    expect(client.sendVerificationEmail).toHaveBeenCalledWith({
      email: "ana@example.test",
    });
    expect(client.requestPasswordReset).toHaveBeenCalledWith({
      email: "ana@example.test",
      redirectTo: new URL("/reset-password", window.location.origin).toString(),
    });
  });

  it("submits verification credentials only in a same-origin JSON body", async () => {
    const request = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", request);

    await verifyEmail("verification-secret");

    expect(request).toHaveBeenCalledWith("/api/auth/verify-email", {
      body: JSON.stringify({ token: "verification-secret" }),
      cache: "no-store",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(String(request.mock.calls[0]?.[0])).not.toContain("verification-secret");
  });

  it("normalizes verification endpoint failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 400 })),
    );

    await expect(verifyEmail("invalid-secret")).rejects.toMatchObject({
      name: "AuthActionError",
      status: 400,
    });
  });

  it("uses the required session-revocation password semantics", async () => {
    await resetPassword({ newPassword: "abcdefghijkl", token: "reset-token" });
    await changePassword({ currentPassword: "abcdefghijkl", newPassword: "mnopqrstuvwx" });

    expect(client.resetPassword).toHaveBeenCalledWith({
      newPassword: "abcdefghijkl",
      token: "reset-token",
    });
    expect(client.changePassword).toHaveBeenCalledWith({
      currentPassword: "abcdefghijkl",
      newPassword: "mnopqrstuvwx",
      revokeOtherSessions: true,
    });
  });

  it("normalizes Better Auth failures without exposing provider messages", async () => {
    client.signIn.email.mockResolvedValue({
      data: null,
      error: { status: 401, message: "provider detail" },
    });

    await expect(signIn({ email: "ana@example.test", password: "abcdefghijkl" })).rejects.toEqual(
      expect.objectContaining<AuthActionError>({
        name: "AuthActionError",
        status: 401,
        message: "The authentication request was rejected.",
      }),
    );
  });

  it("uses the Better Auth sign-out endpoint", async () => {
    await signOut();

    expect(client.signOut).toHaveBeenCalledOnce();
  });
});

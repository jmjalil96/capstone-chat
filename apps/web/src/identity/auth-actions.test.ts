import { beforeEach, describe, expect, it, vi } from "vitest";

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

describe("auth actions", () => {
  it("uses Better Auth email/password endpoints with same-origin callbacks", async () => {
    await signUp({ name: "Ana", email: "ana@example.test", password: "abcdefghijkl" });
    await sendVerificationEmail("ana@example.test");
    await requestPasswordReset("ana@example.test");

    expect(client.signUp.email).toHaveBeenCalledWith({
      name: "Ana",
      email: "ana@example.test",
      password: "abcdefghijkl",
      callbackURL: new URL("/verify-email?verified=1", window.location.origin).toString(),
    });
    expect(client.sendVerificationEmail).toHaveBeenCalledWith({
      email: "ana@example.test",
      callbackURL: new URL("/verify-email?verified=1", window.location.origin).toString(),
    });
    expect(client.requestPasswordReset).toHaveBeenCalledWith({
      email: "ana@example.test",
      redirectTo: new URL("/reset-password", window.location.origin).toString(),
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

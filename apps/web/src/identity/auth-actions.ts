import { authClient } from "./auth-client";

export class AuthActionError extends Error {
  readonly status: number;

  constructor(status: number) {
    super("The authentication request was rejected.");
    this.name = "AuthActionError";
    this.status = status;
  }
}

function assertAuthSuccess(result: { error?: { status?: number } | null }): void {
  if (result.error) {
    throw new AuthActionError(result.error.status ?? 0);
  }
}

function appUrl(path: string): string {
  return new URL(path, window.location.origin).toString();
}

export async function signIn(input: { email: string; password: string }): Promise<void> {
  const result = await authClient.signIn.email(input);
  assertAuthSuccess(result);
}

export async function signUp(input: {
  email: string;
  name: string;
  password: string;
}): Promise<void> {
  const result = await authClient.signUp.email({
    ...input,
    callbackURL: appUrl("/verify-email?verified=1"),
  });
  assertAuthSuccess(result);
}

export async function signOut(): Promise<void> {
  const result = await authClient.signOut();
  assertAuthSuccess(result);
}

export async function sendVerificationEmail(email: string): Promise<void> {
  const result = await authClient.sendVerificationEmail({
    email,
    callbackURL: appUrl("/verify-email?verified=1"),
  });
  assertAuthSuccess(result);
}

export async function requestPasswordReset(email: string): Promise<void> {
  const result = await authClient.requestPasswordReset({
    email,
    redirectTo: appUrl("/reset-password"),
  });
  assertAuthSuccess(result);
}

export async function resetPassword(input: { newPassword: string; token: string }): Promise<void> {
  const result = await authClient.resetPassword(input);
  assertAuthSuccess(result);
}

export async function changePassword(input: {
  currentPassword: string;
  newPassword: string;
}): Promise<void> {
  const result = await authClient.changePassword({
    ...input,
    revokeOtherSessions: true,
  });
  assertAuthSuccess(result);
}

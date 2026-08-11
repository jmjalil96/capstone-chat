import type { QueryClient } from "@tanstack/react-query";

import { type SessionQueryResult, sessionQueryKey } from "./session";

const authenticationRequiredListeners = new Set<() => void>();

export function reportAuthenticationRequired(): void {
  for (const listener of authenticationRequiredListeners) {
    listener();
  }
}

export function subscribeAuthenticationRequired(listener: () => void): () => void {
  authenticationRequiredListeners.add(listener);
  return () => authenticationRequiredListeners.delete(listener);
}

export function isAuthenticationRequiredError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    Reflect.get(error, "status") === 401
  );
}

export function expireAuthenticatedSession(queryClient: QueryClient): void {
  const current = queryClient.getQueryData<SessionQueryResult>(sessionQueryKey);
  if (current?.status !== "authenticated") {
    return;
  }
  void queryClient.cancelQueries();
  queryClient.removeQueries({
    predicate: (query) => query.queryKey[0] !== sessionQueryKey[0],
  });
  queryClient.getMutationCache().clear();
  queryClient.setQueryData<SessionQueryResult>(sessionQueryKey, { status: "anonymous" });
}

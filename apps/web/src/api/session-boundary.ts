import type { QueryClient } from "@tanstack/react-query";

import { type SessionQueryResult, sessionQueryKey } from "./session";

export type SessionBoundaryStatus = "anonymous" | "denied";

const sessionBoundaryListeners = new Set<(status: SessionBoundaryStatus) => void>();

export function reportSessionBoundary(status: SessionBoundaryStatus): void {
  for (const listener of sessionBoundaryListeners) {
    listener(status);
  }
}

export function reportAuthenticationRequired(): void {
  reportSessionBoundary("anonymous");
}

export function reportWorkspaceAccessDenied(): void {
  reportSessionBoundary("denied");
}

export function subscribeSessionBoundary(
  listener: (status: SessionBoundaryStatus) => void,
): () => void {
  sessionBoundaryListeners.add(listener);
  return () => sessionBoundaryListeners.delete(listener);
}

function isAuthenticationRequiredError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    Reflect.get(error, "status") === 401
  );
}

export function sessionBoundaryStatusForError(error: unknown): SessionBoundaryStatus | undefined {
  if (isAuthenticationRequiredError(error)) {
    return "anonymous";
  }
  return typeof error === "object" &&
    error !== null &&
    "status" in error &&
    Reflect.get(error, "status") === 403 &&
    "code" in error &&
    Reflect.get(error, "code") === "WORKSPACE_ACCESS_DENIED"
    ? "denied"
    : undefined;
}

export function expireAuthenticatedSession(
  queryClient: QueryClient,
  status: SessionBoundaryStatus = "anonymous",
): void {
  const current = queryClient.getQueryData<SessionQueryResult>(sessionQueryKey);
  if (current?.status !== "authenticated") {
    return;
  }
  void queryClient.cancelQueries();
  queryClient.removeQueries({
    predicate: (query) => query.queryKey[0] !== sessionQueryKey[0],
  });
  queryClient.getMutationCache().clear();
  queryClient.setQueryData<SessionQueryResult>(sessionQueryKey, { status });
}

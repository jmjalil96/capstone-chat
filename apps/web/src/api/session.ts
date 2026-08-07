import { ApiErrorSchema, type SessionResponse, SessionResponseSchema } from "@capstone/protocol";
import { queryOptions } from "@tanstack/react-query";
import Value from "typebox/value";

const SESSION_ENDPOINT = "/api/session";

export const sessionQueryKey = ["session"] as const;

export type SessionQueryResult =
  | { status: "authenticated"; session: SessionResponse }
  | { status: "anonymous" }
  | { status: "denied" };

export async function fetchSession(signal?: AbortSignal): Promise<SessionQueryResult> {
  const response = await fetch(SESSION_ENDPOINT, {
    credentials: "same-origin",
    headers: {
      accept: "application/json",
    },
    signal: signal ?? null,
  });

  let payload: unknown;

  try {
    payload = await response.json();
  } catch {
    throw new Error("The session response was not valid JSON.");
  }

  if (response.status === 200 && Value.Check(SessionResponseSchema, payload)) {
    return { status: "authenticated", session: payload };
  }

  if (Value.Check(ApiErrorSchema, payload)) {
    if (response.status === 401 && payload.code === "AUTHENTICATION_REQUIRED") {
      return { status: "anonymous" };
    }

    if (response.status === 403 && payload.code === "WORKSPACE_ACCESS_DENIED") {
      return { status: "denied" };
    }
  }

  throw new Error("The session response did not match the protocol.");
}

export const sessionQueryOptions = queryOptions({
  gcTime: 0,
  queryKey: sessionQueryKey,
  queryFn: ({ signal }) => fetchSession(signal),
  refetchOnWindowFocus: true,
  retry: false,
});

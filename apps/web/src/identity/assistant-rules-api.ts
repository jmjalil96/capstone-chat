import {
  type ApiErrorCode,
  ApiErrorSchema,
  type MemberAssistantRulesResponse,
  MemberAssistantRulesResponseSchema,
  type SessionResponse,
} from "@capstone/protocol";
import Value from "typebox/value";

import { reportAuthenticationRequired, reportWorkspaceAccessDenied } from "../api/session-boundary";

export type AssistantRulesQueryScope = readonly [
  workspaceId: string,
  employeeId: string,
  sessionCreatedAt: string,
];

export function assistantRulesQueryScope(session: SessionResponse): AssistantRulesQueryScope {
  return [session.workspace.id, session.employee.id, session.session.createdAt];
}

export const assistantRulesQueryKeys = {
  all: ["assistant-rules"] as const,
  member: (scope: AssistantRulesQueryScope) => [...assistantRulesQueryKeys.all, ...scope] as const,
};

export class AssistantRulesApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;

  constructor(status: number, code: ApiErrorCode) {
    super("The assistant rules request was rejected.");
    this.name = "AssistantRulesApiError";
    this.code = code;
    this.status = status;
  }
}

export async function fetchMemberAssistantRules(
  signal?: AbortSignal,
): Promise<MemberAssistantRulesResponse> {
  const response = await fetch("/api/assistant-rules", {
    credentials: "same-origin",
    headers: { accept: "application/json" },
    signal: signal ?? null,
  });
  if (response.status === 401) {
    reportAuthenticationRequired();
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error("The assistant rules response was not valid JSON.");
  }

  if (
    response.status === 403 &&
    Value.Check(ApiErrorSchema, body) &&
    body.code === "WORKSPACE_ACCESS_DENIED"
  ) {
    reportWorkspaceAccessDenied();
  }
  if (!response.ok) {
    if (Value.Check(ApiErrorSchema, body)) {
      throw new AssistantRulesApiError(response.status, body.code);
    }
    throw new Error("The assistant rules error response did not match the protocol.");
  }
  if (!Value.Check(MemberAssistantRulesResponseSchema, body)) {
    throw new Error("The assistant rules response did not match the protocol.");
  }
  return body;
}

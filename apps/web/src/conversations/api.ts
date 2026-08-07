import {
  ApiErrorSchema,
  type ArchiveConversationRequest,
  ArchiveConversationResponseSchema,
  type ConversationDetailResponse,
  ConversationDetailResponseSchema,
  type ConversationListResponse,
  ConversationListResponseSchema,
  type ConversationSearchRequest,
  type ConversationSearchResponse,
  ConversationSearchResponseSchema,
  type ConversationSelectionResponse,
  ConversationSelectionResponseSchema,
  type ConversationSummary,
  type ConversationView,
  type DeleteConversationRequest,
  type DraftScope,
  type DraftState,
  DraftStateSchema,
  type OpaqueCursor,
  type RenameConversationRequest,
  RenameConversationResponseSchema,
  type SaveDraftRequest,
  type SelectConversationLeafRequest,
  type SessionResponse,
  type UnarchiveConversationRequest,
  UnarchiveConversationResponseSchema,
} from "@capstone/protocol";
import type { TSchema } from "typebox";
import Value from "typebox/value";

export class ConversationApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(status: number, code: string) {
    super("The conversation request was rejected.");
    this.name = "ConversationApiError";
    this.code = code;
    this.status = status;
  }
}

async function responsePayload(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new Error("The conversation response was not valid JSON.");
  }
}

async function validatedResponse<T>(response: Response, schema: TSchema): Promise<T> {
  const payload = await responsePayload(response);

  if (!response.ok) {
    if (Value.Check(ApiErrorSchema, payload)) {
      throw new ConversationApiError(response.status, payload.code);
    }
    throw new Error("The conversation error response did not match the protocol.");
  }

  if (!Value.Check(schema, payload)) {
    throw new Error("The conversation response did not match the protocol.");
  }

  return payload as T;
}

function assertConversationId(conversationId: string, receivedId: string): void {
  if (conversationId !== receivedId) {
    throw new Error("The conversation response did not match the requested resource.");
  }
}

function assertDraftScope(scope: DraftScope, draft: DraftState): void {
  if (draftScopeKey(scope) !== draftScopeKey(draft.scope)) {
    throw new Error("The draft response did not match the requested scope.");
  }
}

function jsonRequest(method: string, body: unknown, signal?: AbortSignal): RequestInit {
  return {
    body: JSON.stringify(body),
    credentials: "same-origin",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    method,
    signal: signal ?? null,
  };
}

function draftEndpoint(scope: DraftScope): string {
  return scope.kind === "new"
    ? "/api/drafts/new"
    : `/api/conversations/${encodeURIComponent(scope.conversationId)}/draft`;
}

export function draftScopeKey(scope: DraftScope): string {
  return scope.kind === "new" ? "new" : `conversation:${scope.conversationId}`;
}

export type ConversationActorScope = readonly [workspaceId: string, employeeId: string];

export type ConversationQueryScope = readonly [
  workspaceId: string,
  employeeId: string,
  sessionCreatedAt: string,
];

export function conversationActorScope(session: SessionResponse): ConversationActorScope {
  return [session.workspace.id, session.employee.id];
}

export function conversationQueryScope(session: SessionResponse): ConversationQueryScope {
  return [...conversationActorScope(session), session.session.createdAt];
}

export const conversationQueryKeys = {
  all: (queryScope: ConversationQueryScope) => ["conversations", ...queryScope] as const,
  histories: (queryScope: ConversationQueryScope) =>
    [...conversationQueryKeys.all(queryScope), "history"] as const,
  history: (queryScope: ConversationQueryScope, view: ConversationView) =>
    [...conversationQueryKeys.histories(queryScope), view] as const,
  detail: (queryScope: ConversationQueryScope, conversationId: string) =>
    [...conversationQueryKeys.all(queryScope), "detail", conversationId] as const,
  drafts: (queryScope: ConversationQueryScope) =>
    [...conversationQueryKeys.all(queryScope), "draft"] as const,
  draft: (queryScope: ConversationQueryScope, scope: DraftScope) =>
    [...conversationQueryKeys.drafts(queryScope), draftScopeKey(scope)] as const,
  searches: (queryScope: ConversationQueryScope) =>
    [...conversationQueryKeys.all(queryScope), "search"] as const,
  search: (queryScope: ConversationQueryScope, query: string) =>
    [...conversationQueryKeys.searches(queryScope), query] as const,
};

export async function fetchConversationHistory(
  view: ConversationView,
  cursor: OpaqueCursor | undefined,
  signal?: AbortSignal,
): Promise<ConversationListResponse> {
  const parameters = new URLSearchParams({ view });
  if (cursor) {
    parameters.set("cursor", cursor);
  }

  const response = await fetch(`/api/conversations?${parameters.toString()}`, {
    credentials: "same-origin",
    headers: { accept: "application/json" },
    signal: signal ?? null,
  });
  return validatedResponse(response, ConversationListResponseSchema);
}

export async function fetchConversation(
  conversationId: string,
  cursor: OpaqueCursor | undefined,
  signal?: AbortSignal,
): Promise<ConversationDetailResponse> {
  const parameters = new URLSearchParams();
  if (cursor) {
    parameters.set("cursor", cursor);
  }
  const query = parameters.size > 0 ? `?${parameters.toString()}` : "";
  const response = await fetch(`/api/conversations/${encodeURIComponent(conversationId)}${query}`, {
    credentials: "same-origin",
    headers: { accept: "application/json" },
    signal: signal ?? null,
  });
  const detail = await validatedResponse<ConversationDetailResponse>(
    response,
    ConversationDetailResponseSchema,
  );
  assertConversationId(conversationId, detail.conversation.id);
  return detail;
}

export async function renameConversation(
  conversationId: string,
  input: RenameConversationRequest,
  signal?: AbortSignal,
): Promise<ConversationSummary> {
  const response = await fetch(
    `/api/conversations/${encodeURIComponent(conversationId)}/title`,
    jsonRequest("PATCH", input, signal),
  );
  const conversation = await validatedResponse<ConversationSummary>(
    response,
    RenameConversationResponseSchema,
  );
  assertConversationId(conversationId, conversation.id);
  return conversation;
}

export async function selectConversationLeaf(
  conversationId: string,
  input: SelectConversationLeafRequest,
  signal?: AbortSignal,
): Promise<ConversationSelectionResponse> {
  const response = await fetch(
    `/api/conversations/${encodeURIComponent(conversationId)}/selection`,
    jsonRequest("PUT", input, signal),
  );
  const selection = await validatedResponse<ConversationSelectionResponse>(
    response,
    ConversationSelectionResponseSchema,
  );
  assertConversationId(conversationId, selection.conversation.id);
  return selection;
}

export async function archiveConversation(
  conversationId: string,
  input: ArchiveConversationRequest,
  signal?: AbortSignal,
): Promise<ConversationSummary> {
  const response = await fetch(
    `/api/conversations/${encodeURIComponent(conversationId)}/archive`,
    jsonRequest("POST", input, signal),
  );
  const conversation = await validatedResponse<ConversationSummary>(
    response,
    ArchiveConversationResponseSchema,
  );
  assertConversationId(conversationId, conversation.id);
  return conversation;
}

export async function unarchiveConversation(
  conversationId: string,
  input: UnarchiveConversationRequest,
  signal?: AbortSignal,
): Promise<ConversationSummary> {
  const response = await fetch(
    `/api/conversations/${encodeURIComponent(conversationId)}/unarchive`,
    jsonRequest("POST", input, signal),
  );
  const conversation = await validatedResponse<ConversationSummary>(
    response,
    UnarchiveConversationResponseSchema,
  );
  assertConversationId(conversationId, conversation.id);
  return conversation;
}

export async function deleteConversation(
  conversationId: string,
  input: DeleteConversationRequest,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(
    `/api/conversations/${encodeURIComponent(conversationId)}`,
    jsonRequest("DELETE", input, signal),
  );

  if (response.status === 204) {
    return;
  }

  const payload = await responsePayload(response);
  if (Value.Check(ApiErrorSchema, payload)) {
    throw new ConversationApiError(response.status, payload.code);
  }
  throw new Error("The conversation deletion response did not match the protocol.");
}

export async function fetchDraft(scope: DraftScope, signal?: AbortSignal): Promise<DraftState> {
  const response = await fetch(draftEndpoint(scope), {
    credentials: "same-origin",
    headers: { accept: "application/json" },
    signal: signal ?? null,
  });
  const draft = await validatedResponse<DraftState>(response, DraftStateSchema);
  assertDraftScope(scope, draft);
  return draft;
}

export async function saveDraft(
  scope: DraftScope,
  input: SaveDraftRequest,
  signal?: AbortSignal,
): Promise<DraftState> {
  const response = await fetch(draftEndpoint(scope), jsonRequest("PUT", input, signal));
  const draft = await validatedResponse<DraftState>(response, DraftStateSchema);
  assertDraftScope(scope, draft);
  return draft;
}

export async function searchConversations(
  input: ConversationSearchRequest,
  signal?: AbortSignal,
): Promise<ConversationSearchResponse> {
  const response = await fetch("/api/conversations/search", jsonRequest("POST", input, signal));
  return validatedResponse(response, ConversationSearchResponseSchema);
}

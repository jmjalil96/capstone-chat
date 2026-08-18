import {
  type AdminAddModelCatalogRequest,
  type AdminAddModelCatalogResponse,
  AdminAddModelCatalogResponseSchema,
  type AdminAnswerReportDetail,
  AdminAnswerReportDetailSchema,
  type AdminAnswerReportListResponse,
  AdminAnswerReportListResponseSchema,
  type AdminApproveEmployeeRequest,
  type AdminApproveEmployeeResponse,
  AdminApproveEmployeeResponseSchema,
  type AdminAssistantRulesResponse,
  AdminAssistantRulesResponseSchema,
  type AdminDeactivateEmployeeResponse,
  AdminDeactivateEmployeeResponseSchema,
  type AdminEmployeeListResponse,
  AdminEmployeeListResponseSchema,
  type AdminEmployeeSoftBudgetRequest,
  type AdminEmployeeSoftBudgetResponse,
  AdminEmployeeSoftBudgetResponseSchema,
  type AdminModelCatalogListResponse,
  AdminModelCatalogListResponseSchema,
  type AdminModelPolicyHistoryResponse,
  AdminModelPolicyHistoryResponseSchema,
  type AdminModelPolicyResponse,
  AdminModelPolicyResponseSchema,
  type AdminRefreshModelCatalogRequest,
  type AdminRefreshModelCatalogResponse,
  AdminRefreshModelCatalogResponseSchema,
  type AdminRevertModelPolicyRequest,
  type AdminUpdateModelPolicyRequest,
  type AdminUpdateModelPolicyResponse,
  AdminUpdateModelPolicyResponseSchema,
  type AdminUsageResponse,
  AdminUsageResponseSchema,
  type ApiErrorCode,
  ApiErrorSchema,
  type AssistantRulesHistoryResponse,
  AssistantRulesHistoryResponseSchema,
  type PreviewAssistantRulesRequest,
  type PreviewAssistantRulesResponse,
  PreviewAssistantRulesResponseSchema,
  type ResetAssistantRulesRequest,
  type RevertAssistantRulesRequest,
  type SessionResponse,
  type UpdateAssistantRulesRequest,
} from "@capstone/protocol";
import type { TSchema } from "typebox";
import Value from "typebox/value";
import { reportAuthenticationRequired, reportWorkspaceAccessDenied } from "../api/session-boundary";

export class AdministrationApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;

  constructor(status: number, code: ApiErrorCode) {
    super("The administration request was rejected.");
    this.name = "AdministrationApiError";
    this.code = code;
    this.status = status;
  }
}

export type AdministrationQueryScope = readonly [
  workspaceId: string,
  employeeId: string,
  sessionCreatedAt: string,
];

export function administrationQueryScope(session: SessionResponse): AdministrationQueryScope {
  return [session.workspace.id, session.employee.id, session.session.createdAt];
}

export const administrationQueryKeys = {
  all: (scope: AdministrationQueryScope) => ["administration", ...scope] as const,
  employees: (scope: AdministrationQueryScope) =>
    [...administrationQueryKeys.all(scope), "employees"] as const,
  catalog: (scope: AdministrationQueryScope) =>
    [...administrationQueryKeys.all(scope), "catalog"] as const,
  policy: (scope: AdministrationQueryScope) =>
    [...administrationQueryKeys.all(scope), "policy"] as const,
  policyHistory: (scope: AdministrationQueryScope) =>
    [...administrationQueryKeys.policy(scope), "revisions"] as const,
  assistantRules: (scope: AdministrationQueryScope) =>
    [...administrationQueryKeys.all(scope), "assistant-rules"] as const,
  assistantRulesHistory: (scope: AdministrationQueryScope) =>
    [...administrationQueryKeys.assistantRules(scope), "revisions"] as const,
  usage: (scope: AdministrationQueryScope) =>
    [...administrationQueryKeys.all(scope), "usage"] as const,
  reports: (scope: AdministrationQueryScope) =>
    [...administrationQueryKeys.all(scope), "answer-reports"] as const,
  report: (scope: AdministrationQueryScope, reportId: string) =>
    [...administrationQueryKeys.reports(scope), reportId] as const,
};

function jsonRequest(method: "POST" | "PUT", body: unknown, signal?: AbortSignal): RequestInit {
  return {
    body: JSON.stringify(body),
    credentials: "same-origin",
    headers: { accept: "application/json", "content-type": "application/json" },
    method,
    signal: signal ?? null,
  };
}

async function payload(response: Response): Promise<unknown> {
  if (response.status === 401) {
    reportAuthenticationRequired();
  }
  try {
    const body: unknown = await response.json();
    if (
      response.status === 403 &&
      Value.Check(ApiErrorSchema, body) &&
      body.code === "WORKSPACE_ACCESS_DENIED"
    ) {
      reportWorkspaceAccessDenied();
    }
    return body;
  } catch {
    throw new Error("The administration response was not valid JSON.");
  }
}

async function validated<T>(response: Response, schema: TSchema): Promise<T> {
  const body = await payload(response);
  if (!response.ok) {
    if (Value.Check(ApiErrorSchema, body)) {
      throw new AdministrationApiError(response.status, body.code);
    }
    throw new Error("The administration error response did not match the protocol.");
  }
  if (!Value.Check(schema, body)) {
    throw new Error("The administration response did not match the protocol.");
  }
  return body as T;
}

async function empty(response: Response): Promise<void> {
  if (response.ok && response.status === 204) {
    return;
  }
  const body = await payload(response);
  if (Value.Check(ApiErrorSchema, body)) {
    throw new AdministrationApiError(response.status, body.code);
  }
  throw new Error("The administration response did not match the protocol.");
}

function pageEndpoint(path: string, cursor?: string): string {
  if (cursor === undefined) {
    return path;
  }
  const query = new URLSearchParams({ cursor });
  return `${path}?${query.toString()}`;
}

function readRequest(signal?: AbortSignal): RequestInit {
  return {
    credentials: "same-origin",
    headers: { accept: "application/json" },
    signal: signal ?? null,
  };
}

export async function fetchAdminEmployees(
  cursor?: string,
  signal?: AbortSignal,
): Promise<AdminEmployeeListResponse> {
  return validated(
    await fetch(pageEndpoint("/api/admin/employees", cursor), readRequest(signal)),
    AdminEmployeeListResponseSchema,
  );
}

export async function approveAdminEmployee(
  input: AdminApproveEmployeeRequest,
  signal?: AbortSignal,
): Promise<AdminApproveEmployeeResponse> {
  return validated(
    await fetch("/api/admin/employees", jsonRequest("POST", input, signal)),
    AdminApproveEmployeeResponseSchema,
  );
}

function employeeEndpoint(approvalId: string, action: string): string {
  return `/api/admin/employees/${encodeURIComponent(approvalId)}/${action}`;
}

export async function resendAdminInvitation(
  approvalId: string,
  signal?: AbortSignal,
): Promise<void> {
  return empty(
    await fetch(employeeEndpoint(approvalId, "invitation"), jsonRequest("POST", {}, signal)),
  );
}

export async function deactivateAdminEmployee(
  approvalId: string,
  signal?: AbortSignal,
): Promise<AdminDeactivateEmployeeResponse> {
  return validated(
    await fetch(employeeEndpoint(approvalId, "deactivate"), jsonRequest("POST", {}, signal)),
    AdminDeactivateEmployeeResponseSchema,
  );
}

export async function revokeAdminEmployeeSessions(
  approvalId: string,
  signal?: AbortSignal,
): Promise<void> {
  return empty(
    await fetch(employeeEndpoint(approvalId, "sessions/revoke"), jsonRequest("POST", {}, signal)),
  );
}

export async function updateAdminEmployeeSoftBudget(
  approvalId: string,
  input: AdminEmployeeSoftBudgetRequest,
  signal?: AbortSignal,
): Promise<AdminEmployeeSoftBudgetResponse> {
  return validated(
    await fetch(employeeEndpoint(approvalId, "soft-budget"), jsonRequest("PUT", input, signal)),
    AdminEmployeeSoftBudgetResponseSchema,
  );
}

export async function fetchAdminCatalog(
  cursor?: string,
  signal?: AbortSignal,
): Promise<AdminModelCatalogListResponse> {
  return validated(
    await fetch(pageEndpoint("/api/admin/model-catalog", cursor), readRequest(signal)),
    AdminModelCatalogListResponseSchema,
  );
}

export async function addAdminCatalogModel(
  input: AdminAddModelCatalogRequest,
  signal?: AbortSignal,
): Promise<AdminAddModelCatalogResponse> {
  return validated(
    await fetch("/api/admin/model-catalog", jsonRequest("POST", input, signal)),
    AdminAddModelCatalogResponseSchema,
  );
}

export async function refreshAdminCatalog(
  input: AdminRefreshModelCatalogRequest,
  signal?: AbortSignal,
): Promise<AdminRefreshModelCatalogResponse> {
  return validated(
    await fetch("/api/admin/model-catalog/refresh", jsonRequest("POST", input, signal)),
    AdminRefreshModelCatalogResponseSchema,
  );
}

export async function fetchAdminPolicy(signal?: AbortSignal): Promise<AdminModelPolicyResponse> {
  return validated(
    await fetch("/api/admin/model-policy", readRequest(signal)),
    AdminModelPolicyResponseSchema,
  );
}

export async function updateAdminPolicy(
  input: AdminUpdateModelPolicyRequest,
  signal?: AbortSignal,
): Promise<AdminUpdateModelPolicyResponse> {
  return validated(
    await fetch("/api/admin/model-policy", jsonRequest("PUT", input, signal)),
    AdminUpdateModelPolicyResponseSchema,
  );
}

export async function fetchAdminPolicyHistory(
  cursor?: string,
  signal?: AbortSignal,
): Promise<AdminModelPolicyHistoryResponse> {
  return validated(
    await fetch(pageEndpoint("/api/admin/model-policy/revisions", cursor), readRequest(signal)),
    AdminModelPolicyHistoryResponseSchema,
  );
}

export async function revertAdminPolicy(
  revision: number,
  input: AdminRevertModelPolicyRequest,
  signal?: AbortSignal,
): Promise<AdminModelPolicyResponse> {
  return validated(
    await fetch(
      `/api/admin/model-policy/revisions/${encodeURIComponent(String(revision))}/revert`,
      jsonRequest("POST", input, signal),
    ),
    AdminModelPolicyResponseSchema,
  );
}

export async function fetchAdminAssistantRules(
  signal?: AbortSignal,
): Promise<AdminAssistantRulesResponse> {
  return validated(
    await fetch("/api/admin/assistant-rules", readRequest(signal)),
    AdminAssistantRulesResponseSchema,
  );
}

export async function previewAdminAssistantRules(
  input: PreviewAssistantRulesRequest,
  signal?: AbortSignal,
): Promise<PreviewAssistantRulesResponse> {
  return validated(
    await fetch("/api/admin/assistant-rules/preview", jsonRequest("POST", input, signal)),
    PreviewAssistantRulesResponseSchema,
  );
}

export async function updateAdminAssistantRules(
  input: UpdateAssistantRulesRequest,
  signal?: AbortSignal,
): Promise<AdminAssistantRulesResponse> {
  return validated(
    await fetch("/api/admin/assistant-rules", jsonRequest("PUT", input, signal)),
    AdminAssistantRulesResponseSchema,
  );
}

export async function resetAdminAssistantRules(
  input: ResetAssistantRulesRequest,
  signal?: AbortSignal,
): Promise<AdminAssistantRulesResponse> {
  return validated(
    await fetch("/api/admin/assistant-rules/reset", jsonRequest("POST", input, signal)),
    AdminAssistantRulesResponseSchema,
  );
}

export async function fetchAdminAssistantRulesHistory(
  cursor?: string,
  signal?: AbortSignal,
): Promise<AssistantRulesHistoryResponse> {
  return validated(
    await fetch(pageEndpoint("/api/admin/assistant-rules/revisions", cursor), readRequest(signal)),
    AssistantRulesHistoryResponseSchema,
  );
}

export async function revertAdminAssistantRules(
  revision: number,
  input: RevertAssistantRulesRequest,
  signal?: AbortSignal,
): Promise<AdminAssistantRulesResponse> {
  return validated(
    await fetch(
      `/api/admin/assistant-rules/revisions/${encodeURIComponent(String(revision))}/revert`,
      jsonRequest("POST", input, signal),
    ),
    AdminAssistantRulesResponseSchema,
  );
}

export async function fetchAdminUsage(
  cursor?: string,
  signal?: AbortSignal,
): Promise<AdminUsageResponse> {
  return validated(
    await fetch(pageEndpoint("/api/admin/usage", cursor), readRequest(signal)),
    AdminUsageResponseSchema,
  );
}

export async function fetchAdminAnswerReports(
  cursor?: string,
  signal?: AbortSignal,
): Promise<AdminAnswerReportListResponse> {
  return validated(
    await fetch(pageEndpoint("/api/admin/answer-reports", cursor), readRequest(signal)),
    AdminAnswerReportListResponseSchema,
  );
}

export async function fetchAdminAnswerReport(
  reportId: string,
  signal?: AbortSignal,
): Promise<AdminAnswerReportDetail> {
  return validated(
    await fetch(`/api/admin/answer-reports/${encodeURIComponent(reportId)}`, readRequest(signal)),
    AdminAnswerReportDetailSchema,
  );
}

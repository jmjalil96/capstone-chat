import type {
  AdminAssistantRulesResponse,
  MemberAssistantRulesResponse,
  PreviewAssistantRulesResponse,
} from "@capstone/protocol";
import { TypeBoxValidatorCompiler } from "@fastify/type-provider-typebox";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import {
  composeAssistantSystemPrompt,
  lockedAssistantBase,
} from "../src/assistant-rules/prompt.js";
import type { AssistantRulesService } from "../src/assistant-rules/service.js";
import { registerErrorHandling } from "../src/errors.js";
import type { ActorResolver, RequestActor } from "../src/identity/authorization.js";
import { registerAssistantRulesRoutes } from "../src/routes/assistant-rules.js";
import { testPromptSnapshot } from "./support/generation.js";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const updatedAt = "2026-08-17T12:00:00.000Z";
const workspaceText = "Regla de prueba";
const memberRules: MemberAssistantRulesResponse = Object.freeze({
  baseText: lockedAssistantBase.text,
  baseVersion: lockedAssistantBase.version,
  effectivePrompt: composeAssistantSystemPrompt(workspaceText),
  updatedAt,
  workspaceText,
});
const adminRules: AdminAssistantRulesResponse = Object.freeze({
  actor: Object.freeze({ kind: "system", label: "Sistema" }),
  baseText: lockedAssistantBase.text,
  baseVersion: lockedAssistantBase.version,
  changeKind: "bootstrap",
  disclosure: Object.freeze({
    retainedInImmutableHistory: true,
    sentToConfiguredZdrProvider: true,
    visibleToActiveMembers: true,
  }),
  effectivePrompt: composeAssistantSystemPrompt(workspaceText),
  estimate: Object.freeze({
    balancedMaximumResponseCostPercent: "1",
    counts: Object.freeze({
      approximateInputTokens: 4,
      codePoints: 15,
      utf8Bytes: 15,
    }),
  }),
  limits: Object.freeze({
    maximumCodePoints: 3_200,
    maximumUtf8Bytes: 12_800,
  }),
  revertedFromRevision: null,
  revision: 1,
  updatedAt,
  workspaceText,
});
const preview: PreviewAssistantRulesResponse = Object.freeze({
  effectivePrompt: composeAssistantSystemPrompt(workspaceText),
  estimate: adminRules.estimate,
  normalizedWorkspaceText: workspaceText,
});

function actor(role: "admin" | "member", fresh = true): RequestActor {
  const now = Date.now();
  return Object.freeze({
    employee: Object.freeze({
      email: "employee@example.test",
      id: "employee-id",
      name: "Persona Administradora",
    }),
    role,
    session: Object.freeze({
      createdAt: new Date(now - (fresh ? 1_000 : 60 * 60 * 1_000)),
      expiresAt: new Date(now + 60 * 60 * 1_000),
      id: "session-id",
    }),
    workspace: Object.freeze({
      id: workspaceId,
      identity: "capstone",
      name: "Capstone",
    }),
  });
}

function actorResolver(requestActor: RequestActor): ActorResolver {
  return async () => Object.freeze({ actor: requestActor, authenticationHeaders: new Headers() });
}

function createStore(overrides: Partial<AssistantRulesService> = {}): AssistantRulesService {
  return {
    capturePromptSnapshot: async () => testPromptSnapshot,
    history: async () => Object.freeze({ items: [], nextCursor: null }),
    preview: async () => preview,
    readAdmin: async () => adminRules,
    readMember: async () => memberRules,
    reset: async () => adminRules,
    revert: async () => adminRules,
    save: async () => adminRules,
    ...overrides,
  };
}

function createServer(requestActor: RequestActor, assistantRules = createStore()) {
  const server = Fastify({ logger: false }).setValidatorCompiler(TypeBoxValidatorCompiler);
  registerErrorHandling(server);
  registerAssistantRulesRoutes(server, {
    assistantRules,
    resolveActor: actorResolver(requestActor),
  });
  return server;
}

describe("assistant-rules routes", () => {
  it("allows active members to read only the member-safe contract", async () => {
    const server = createServer(actor("member"));
    try {
      const member = await server.inject({ method: "GET", url: "/api/assistant-rules" });
      const admin = await server.inject({ method: "GET", url: "/api/admin/assistant-rules" });

      expect(member.statusCode).toBe(200);
      expect(member.json()).toEqual(memberRules);
      expect(member.body).not.toContain("actor");
      expect(admin.statusCode).toBe(403);
      expect(admin.json()).toMatchObject({ code: "ADMIN_ACCESS_REQUIRED" });
    } finally {
      await server.close();
    }
  });

  it("allows stale administrator reads and preview but fences mutations", async () => {
    const save = vi.fn<AssistantRulesService["save"]>(async () => adminRules);
    const server = createServer(actor("admin", false), createStore({ save }));
    try {
      const read = await server.inject({ method: "GET", url: "/api/admin/assistant-rules" });
      const previewResponse = await server.inject({
        method: "POST",
        payload: { workspaceText },
        url: "/api/admin/assistant-rules/preview",
      });
      const mutation = await server.inject({
        method: "PUT",
        payload: { observedRevision: 1, workspaceText },
        url: "/api/admin/assistant-rules",
      });

      expect(read.statusCode).toBe(200);
      expect(previewResponse.statusCode).toBe(200);
      expect(mutation.statusCode).toBe(403);
      expect(mutation.json()).toMatchObject({ code: "SESSION_REFRESH_REQUIRED" });
      expect(save).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("passes the fresh actor and closed mutation contract to the service", async () => {
    const save = vi.fn<AssistantRulesService["save"]>(async () => ({
      ...adminRules,
      actor: { displayName: "Persona Administradora", kind: "user", userId: "employee-id" },
      changeKind: "save",
      revision: 2,
    }));
    const requestActor = actor("admin");
    const server = createServer(requestActor, createStore({ save }));
    try {
      const response = await server.inject({
        method: "PUT",
        payload: { observedRevision: 1, workspaceText },
        url: "/api/admin/assistant-rules",
      });
      const unknownField = await server.inject({
        method: "PUT",
        payload: { observedRevision: 1, unknown: true, workspaceText },
        url: "/api/admin/assistant-rules",
      });

      expect(response.statusCode).toBe(200);
      expect(save).toHaveBeenCalledExactlyOnceWith(workspaceId, requestActor, 1, workspaceText);
      expect(unknownField.statusCode).toBe(400);
    } finally {
      await server.close();
    }
  });

  it("routes newest-first history and append-only revert with the source revision", async () => {
    const history = vi.fn<AssistantRulesService["history"]>(async () => ({
      items: [],
      nextCursor: null,
    }));
    const revert = vi.fn<AssistantRulesService["revert"]>(async () => ({
      ...adminRules,
      actor: { displayName: "Persona Administradora", kind: "user", userId: "employee-id" },
      changeKind: "revert",
      revertedFromRevision: 1,
      revision: 2,
    }));
    const requestActor = actor("admin");
    const server = createServer(requestActor, createStore({ history, revert }));
    try {
      const historyResponse = await server.inject({
        method: "GET",
        url: "/api/admin/assistant-rules/revisions",
      });
      const revertResponse = await server.inject({
        method: "POST",
        payload: { observedRevision: 1 },
        url: "/api/admin/assistant-rules/revisions/1/revert",
      });

      expect(historyResponse.statusCode).toBe(200);
      expect(history).toHaveBeenCalledExactlyOnceWith(workspaceId, undefined);
      expect(revertResponse.statusCode).toBe(200);
      expect(revert).toHaveBeenCalledExactlyOnceWith(workspaceId, requestActor, 1, 1);
    } finally {
      await server.close();
    }
  });
});

import type {
  AdminModelCapability,
  AdminModelCatalogItem,
  AdminModelPolicyResponse,
  AdminUpdateModelPolicyRequest,
} from "@capstone/protocol";
import { TypeBoxValidatorCompiler } from "@fastify/type-provider-typebox";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { registerErrorHandling } from "../src/errors.js";
import type { ActorResolver, RequestActor } from "../src/identity/authorization.js";
import type { CatalogModelSnapshot } from "../src/model-policy/catalog.js";
import type { CatalogSnapshotLoader } from "../src/model-policy/catalog-refresh.js";
import {
  CatalogRefreshActiveError,
  ModelPolicyChangedError,
  ModelPolicyConflictError,
  ModelPolicyUnavailableError,
} from "../src/model-policy/service.js";
import {
  type AdminModelRoutesDependencies,
  registerAdminModelRoutes,
} from "../src/routes/admin-models.js";
import { testCatalogCapability } from "./support/generation.js";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const catalogIds = [
  "22222222-2222-4222-8222-222222222220",
  "22222222-2222-4222-8222-222222222221",
  "22222222-2222-4222-8222-222222222222",
] as const;
const refreshOwnerId = "33333333-3333-4333-8333-333333333333";
const adminCapability: AdminModelCapability = Object.freeze({
  reasoning: Object.freeze({
    defaultEffort: null,
    defaultEnabled: null,
    effortSupport: Object.freeze({ kind: "all" }),
    kind: "optional",
    maxTokensAccepted: true,
    traceSafety: "provider_excluded",
  }),
  temperatureSupported: true,
});
const disabledReasoningStatus = Object.freeze({
  kind: "exact" as const,
  reason: "reasoning_disabled" as const,
});
const supportedTemperatureStatus = Object.freeze({
  kind: "exact" as const,
  reason: "supported" as const,
});

const snapshot: CatalogModelSnapshot = Object.freeze({
  available: true,
  canonicalSlug: "approved/exact-model",
  capability: testCatalogCapability,
  completionPricePerToken: "0.000002",
  contextLength: 128_000,
  displayName: "Approved exact model",
  inputModalities: Object.freeze(["text"]),
  maximumOutputTokens: 8_192,
  metadataSource: "openrouter",
  modelId: "approved/exact-model",
  outputModalities: Object.freeze(["text"]),
  promptPricePerToken: "0.000001",
  requestPriceUsd: "0",
  supportedParameters: Object.freeze(["max_tokens", "reasoning"]),
  validatedAt: new Date("2026-08-08T12:00:00.000Z"),
});

const catalogItem: AdminModelCatalogItem = Object.freeze({
  available: true,
  capability: adminCapability,
  catalogId: catalogIds[0],
  contextLength: 128_000,
  displayName: "Approved exact model",
  maximumOutputTokens: 8_192,
  modelId: "approved/exact-model",
  validatedAt: "2026-08-08T12:00:00.000Z",
});

const policy: AdminModelPolicyResponse = {
  actor: { kind: "system", label: "Sistema" },
  changeKind: "bootstrap",
  currency: "USD",
  defaultTier: "balanced",
  monthlyBudgetUsd: "100",
  revertedFromRevision: null,
  revision: 1,
  tiers: [
    {
      available: true,
      budgetStatus: disabledReasoningStatus,
      catalog: {
        available: true,
        capability: adminCapability,
        contextLength: 128_000,
        displayName: "Fast model",
        maximumOutputTokens: 8_192,
        modelId: "approved/fast",
        validatedAt: "2026-08-08T12:00:00.000Z",
      },
      catalogId: catalogIds[0],
      enabled: true,
      effortStatus: disabledReasoningStatus,
      maximumOutputTokens: 4_096,
      reasoningBudgetTokens: 0,
      reasoningEffort: "off",
      temperaturePreset: "precise",
      temperatureStatus: supportedTemperatureStatus,
      tier: "fast",
    },
    {
      available: true,
      budgetStatus: disabledReasoningStatus,
      catalog: {
        available: true,
        capability: adminCapability,
        contextLength: 128_000,
        displayName: "Balanced model",
        maximumOutputTokens: 16_384,
        modelId: "approved/balanced",
        validatedAt: "2026-08-08T12:00:00.000Z",
      },
      catalogId: catalogIds[1],
      enabled: true,
      effortStatus: disabledReasoningStatus,
      maximumOutputTokens: 8_192,
      reasoningBudgetTokens: 0,
      reasoningEffort: "off",
      temperaturePreset: "balanced",
      temperatureStatus: supportedTemperatureStatus,
      tier: "balanced",
    },
    {
      available: true,
      budgetStatus: {
        kind: "translated",
        reason: "max_tokens_precision_unverified",
      },
      catalog: {
        available: true,
        capability: adminCapability,
        contextLength: 128_000,
        displayName: "Pro model",
        maximumOutputTokens: 32_768,
        modelId: "approved/pro",
        validatedAt: "2026-08-08T12:00:00.000Z",
      },
      catalogId: catalogIds[2],
      enabled: true,
      effortStatus: {
        kind: "translated",
        reason: "max_tokens_precision_unverified",
      },
      maximumOutputTokens: 16_384,
      reasoningBudgetTokens: 8_192,
      reasoningEffort: "high",
      temperaturePreset: "balanced",
      temperatureStatus: supportedTemperatureStatus,
      tier: "pro",
    },
  ],
  updatedAt: "2026-08-08T12:00:00.000Z",
};

const policyUpdate: AdminUpdateModelPolicyRequest = {
  defaultTier: "balanced",
  monthlyBudgetUsd: "101",
  observedRevision: 1,
  tiers: [
    {
      catalogId: catalogIds[0],
      enabled: true,
      maximumOutputTokens: 4_096,
      reasoningBudgetTokens: 0,
      reasoningEffort: "off",
      temperaturePreset: "precise",
      tier: "fast",
    },
    {
      catalogId: catalogIds[1],
      enabled: true,
      maximumOutputTokens: 8_192,
      reasoningBudgetTokens: 0,
      reasoningEffort: "off",
      temperaturePreset: "balanced",
      tier: "balanced",
    },
    {
      catalogId: catalogIds[2],
      enabled: true,
      maximumOutputTokens: 16_384,
      reasoningBudgetTokens: 8_192,
      reasoningEffort: "high",
      temperaturePreset: "balanced",
      tier: "pro",
    },
  ],
};

type ModelPolicyStore = AdminModelRoutesDependencies["modelPolicy"];

function actor(role: "admin" | "member", fresh = true): RequestActor {
  const current = Date.now();
  return Object.freeze({
    employee: Object.freeze({
      email: "admin@capstone.example",
      id: "admin-user",
      name: "Administradora",
    }),
    role,
    session: Object.freeze({
      createdAt: new Date(current - (fresh ? 1_000 : 60 * 60 * 1_000)),
      expiresAt: new Date(current + 60 * 60 * 1_000),
      id: "admin-session",
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

function createStore(overrides: Partial<ModelPolicyStore> = {}): ModelPolicyStore {
  return {
    approveCatalogSnapshot: async () => catalogItem,
    claimAdminCatalogRefresh: async () =>
      Object.freeze({ modelIds: Object.freeze([]), nextCursor: null, ownerId: refreshOwnerId }),
    completeCatalogRefresh: async () => Object.freeze({ available: 0, unavailable: 0, updated: 0 }),
    listAdminCatalog: async () => Object.freeze({ items: [], nextCursor: null }),
    listAdminPolicyHistory: async () => Object.freeze({ items: [], nextCursor: null }),
    readAdminPolicy: async () => policy,
    releaseCatalogRefresh: async () => 0,
    replaceAdminPolicy: async () => ({ ...policy, monthlyBudgetUsd: "101", revision: 2 }),
    revertAdminPolicy: async () => ({ ...policy, changeKind: "revert", revision: 2 }),
    ...overrides,
  };
}

function createServer(options: {
  readonly actor: RequestActor;
  readonly loader?: CatalogSnapshotLoader;
  readonly mode?: "fake" | "openrouter";
  readonly store?: ModelPolicyStore;
}) {
  const server = Fastify({ logger: false }).setValidatorCompiler(TypeBoxValidatorCompiler);
  registerErrorHandling(server);
  registerAdminModelRoutes(server, {
    ...(options.loader === undefined ? {} : { loadCatalogSnapshots: options.loader }),
    modelGateway: options.mode ?? "openrouter",
    modelPolicy: options.store ?? createStore(),
    ownerIdFactory: () => refreshOwnerId,
    resolveActor: actorResolver(options.actor),
  });
  return server;
}

describe("administrator model routes", () => {
  it("allows stale administrator reads but requires a fresh mutation session", async () => {
    let listCalls = 0;
    let loaderCalls = 0;
    const server = createServer({
      actor: actor("admin", false),
      loader: async () => {
        loaderCalls += 1;
        return [snapshot];
      },
      store: createStore({
        listAdminCatalog: async () => {
          listCalls += 1;
          return { items: [catalogItem], nextCursor: null };
        },
      }),
    });
    try {
      const read = await server.inject({ method: "GET", url: "/api/admin/model-catalog" });
      const mutation = await server.inject({
        method: "POST",
        payload: { modelId: snapshot.modelId },
        url: "/api/admin/model-catalog",
      });

      expect(read.statusCode).toBe(200);
      expect(read.json()).toEqual({ items: [catalogItem], nextCursor: null });
      expect(mutation.statusCode).toBe(403);
      expect(mutation.json()).toMatchObject({ code: "SESSION_REFRESH_REQUIRED" });
      expect(listCalls).toBe(1);
      expect(loaderCalls).toBe(0);
    } finally {
      await server.close();
    }
  });

  it("requires the administrator role for reads", async () => {
    const server = createServer({ actor: actor("member") });
    try {
      const response = await server.inject({ method: "GET", url: "/api/admin/model-policy" });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ code: "ADMIN_ACCESS_REQUIRED" });
    } finally {
      await server.close();
    }
  });

  it("loads one exact catalog snapshot before persisting workspace approval", async () => {
    const order: string[] = [];
    const loader: CatalogSnapshotLoader = async (modelIds, signal) => {
      order.push("load");
      expect(modelIds).toEqual([snapshot.modelId]);
      expect(signal.aborted).toBe(false);
      return [snapshot];
    };
    const server = createServer({
      actor: actor("admin"),
      loader,
      store: createStore({
        approveCatalogSnapshot: async (receivedWorkspaceId, gatewayMode, receivedSnapshot) => {
          order.push("persist");
          expect(receivedWorkspaceId).toBe(workspaceId);
          expect(gatewayMode).toBe("openrouter");
          expect(receivedSnapshot).toBe(snapshot);
          return catalogItem;
        },
      }),
    });
    try {
      const response = await server.inject({
        method: "POST",
        payload: { modelId: snapshot.modelId },
        url: "/api/admin/model-catalog",
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(catalogItem);
      expect(order).toEqual(["load", "persist"]);
    } finally {
      await server.close();
    }
  });

  it("fails closed when an exact model has no eligible validated snapshot", async () => {
    let persistCalls = 0;
    const server = createServer({
      actor: actor("admin"),
      loader: async () => [],
      store: createStore({
        approveCatalogSnapshot: async () => {
          persistCalls += 1;
          return catalogItem;
        },
      }),
    });
    try {
      const response = await server.inject({
        method: "POST",
        payload: { modelId: snapshot.modelId },
        url: "/api/admin/model-catalog",
      });
      expect(response.statusCode).toBe(422);
      expect(response.json()).toMatchObject({ code: "MODEL_VALIDATION_FAILED" });
      expect(persistCalls).toBe(0);
    } finally {
      await server.close();
    }
  });

  it("keeps live catalog mutations unavailable in simulated mode", async () => {
    let loaderCalls = 0;
    const server = createServer({
      actor: actor("admin"),
      loader: async () => {
        loaderCalls += 1;
        return [snapshot];
      },
      mode: "fake",
    });
    try {
      const add = await server.inject({
        method: "POST",
        payload: { modelId: snapshot.modelId },
        url: "/api/admin/model-catalog",
      });
      const refresh = await server.inject({
        method: "POST",
        payload: { cursor: null },
        url: "/api/admin/model-catalog/refresh",
      });
      expect(add.statusCode).toBe(409);
      expect(add.json()).toMatchObject({ code: "MODEL_POLICY_CONFLICT" });
      expect(refresh.statusCode).toBe(409);
      expect(refresh.json()).toMatchObject({ code: "MODEL_POLICY_CONFLICT" });
      expect(loaderCalls).toBe(0);
    } finally {
      await server.close();
    }
  });

  it("orchestrates one claimed refresh batch outside database work", async () => {
    const order: string[] = [];
    const secondSnapshot = Object.freeze({ ...snapshot, modelId: "approved/second-model" });
    const server = createServer({
      actor: actor("admin"),
      loader: async (modelIds) => {
        order.push("load");
        expect(modelIds).toEqual([snapshot.modelId, secondSnapshot.modelId]);
        return [snapshot, secondSnapshot];
      },
      store: createStore({
        claimAdminCatalogRefresh: async (_workspaceId, gatewayMode, ownerId, cursor) => {
          order.push("claim");
          expect(gatewayMode).toBe("openrouter");
          expect(ownerId).toBe(refreshOwnerId);
          expect(cursor).toBeNull();
          return {
            modelIds: [snapshot.modelId, secondSnapshot.modelId],
            nextCursor: "next.refresh",
            ownerId,
          };
        },
        completeCatalogRefresh: async (_claim, snapshots) => {
          order.push("complete");
          expect(snapshots).toEqual([snapshot, secondSnapshot]);
          return { available: 2, unavailable: 0, updated: 2 };
        },
      }),
    });
    try {
      const response = await server.inject({
        method: "POST",
        payload: { cursor: null },
        url: "/api/admin/model-catalog/refresh",
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        available: 2,
        claimed: 2,
        nextCursor: "next.refresh",
        unavailable: 0,
        updated: 2,
      });
      expect(order).toEqual(["claim", "load", "complete"]);
    } finally {
      await server.close();
    }
  });

  it("releases a refresh lease and sanitizes provider failure", async () => {
    let releaseCalls = 0;
    const server = createServer({
      actor: actor("admin"),
      loader: async () => {
        throw new Error("raw upstream payload must not escape");
      },
      store: createStore({
        claimAdminCatalogRefresh: async (_workspaceId, _mode, ownerId) => ({
          modelIds: [snapshot.modelId],
          nextCursor: null,
          ownerId,
        }),
        releaseCatalogRefresh: async () => {
          releaseCalls += 1;
          return 1;
        },
      }),
    });
    try {
      const response = await server.inject({
        method: "POST",
        payload: { cursor: null },
        url: "/api/admin/model-catalog/refresh",
      });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({
        code: "MODEL_VALIDATION_FAILED",
        message: "No se pudo validar el modelo solicitado con los requisitos de Capstone.",
      });
      expect(response.body).not.toContain("raw upstream");
      expect(releaseCalls).toBe(1);
    } finally {
      await server.close();
    }
  });

  it("reports a live catalog lease without calling the provider", async () => {
    let loaderCalls = 0;
    const server = createServer({
      actor: actor("admin"),
      loader: async () => {
        loaderCalls += 1;
        return [snapshot];
      },
      store: createStore({
        claimAdminCatalogRefresh: async () => {
          throw new CatalogRefreshActiveError();
        },
      }),
    });
    try {
      const response = await server.inject({
        method: "POST",
        payload: { cursor: null },
        url: "/api/admin/model-catalog/refresh",
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ code: "CATALOG_REFRESH_ACTIVE" });
      expect(loaderCalls).toBe(0);
    } finally {
      await server.close();
    }
  });

  it("reads and atomically replaces the complete policy contract", async () => {
    const updated = { ...policy, monthlyBudgetUsd: "101", revision: 2 };
    const received: AdminUpdateModelPolicyRequest[] = [];
    const server = createServer({
      actor: actor("admin"),
      store: createStore({
        replaceAdminPolicy: async (_workspaceId, gatewayMode, receivedActor, input) => {
          expect(gatewayMode).toBe("openrouter");
          expect(receivedActor.employee.id).toBe("admin-user");
          received.push(input);
          return updated;
        },
      }),
    });
    try {
      const read = await server.inject({ method: "GET", url: "/api/admin/model-policy" });
      const replace = await server.inject({
        method: "PUT",
        payload: policyUpdate,
        url: "/api/admin/model-policy",
      });
      expect(read.statusCode).toBe(200);
      expect(read.json()).toEqual(policy);
      expect(replace.statusCode).toBe(200);
      expect(replace.json()).toEqual(updated);
      expect(received).toEqual([policyUpdate]);
    } finally {
      await server.close();
    }
  });

  it("reads complete policy history and appends actor-attributed reverts", async () => {
    const listAdminPolicyHistory = vi.fn<ModelPolicyStore["listAdminPolicyHistory"]>(async () => ({
      items: [policy],
      nextCursor: null,
    }));
    const revertAdminPolicy = vi.fn<ModelPolicyStore["revertAdminPolicy"]>(async () => ({
      ...policy,
      actor: {
        displayName: "Administradora",
        kind: "user",
        userId: "admin-user",
      },
      changeKind: "revert",
      revertedFromRevision: 1,
      revision: 2,
    }));
    const requestActor = actor("admin");
    const server = createServer({
      actor: requestActor,
      store: createStore({ listAdminPolicyHistory, revertAdminPolicy }),
    });
    try {
      const history = await server.inject({
        method: "GET",
        url: "/api/admin/model-policy/revisions",
      });
      const revert = await server.inject({
        method: "POST",
        payload: { observedRevision: 1 },
        url: "/api/admin/model-policy/revisions/1/revert",
      });

      expect(history.statusCode).toBe(200);
      expect(history.json()).toEqual({ items: [policy], nextCursor: null });
      expect(listAdminPolicyHistory).toHaveBeenCalledExactlyOnceWith(
        workspaceId,
        "openrouter",
        undefined,
      );
      expect(revert.statusCode).toBe(200);
      expect(revertAdminPolicy).toHaveBeenCalledExactlyOnceWith(
        workspaceId,
        "openrouter",
        requestActor,
        1,
        1,
      );
    } finally {
      await server.close();
    }
  });

  it.each([
    [new ModelPolicyChangedError(), "MODEL_POLICY_CHANGED"],
    [new ModelPolicyConflictError("conflict"), "MODEL_POLICY_CONFLICT"],
    [new ModelPolicyUnavailableError("unavailable"), "MODEL_POLICY_CONFLICT"],
  ])("maps policy service errors to stable API envelopes", async (error, code) => {
    const server = createServer({
      actor: actor("admin"),
      store: createStore({
        replaceAdminPolicy: async () => {
          throw error;
        },
      }),
    });
    try {
      const response = await server.inject({
        method: "PUT",
        payload: policyUpdate,
        url: "/api/admin/model-policy",
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ code });
    } finally {
      await server.close();
    }
  });
});

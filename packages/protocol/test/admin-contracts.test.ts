import Value from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  ADMIN_LIST_PAGE_SIZE,
  AdminAddModelCatalogRequestSchema,
  AdminApproveEmployeeRequestSchema,
  AdminApproveEmployeeResponseSchema,
  AdminDeactivateEmployeeResponseSchema,
  AdminEmployeeListQuerySchema,
  AdminEmployeeListResponseSchema,
  AdminEmployeeParamsSchema,
  AdminEmployeeSoftBudgetRequestSchema,
  AdminEmployeeSoftBudgetResponseSchema,
  AdminEmptyRequestSchema,
  AdminModelCatalogItemSchema,
  AdminModelCatalogListQuerySchema,
  AdminModelCatalogListResponseSchema,
  AdminModelPolicyResponseSchema,
  AdminRefreshModelCatalogRequestSchema,
  AdminRefreshModelCatalogResponseSchema,
  AdminSessionRevocationResponseSchema,
  AdminUpdateModelPolicyRequestSchema,
  AdminUsageQuerySchema,
  AdminUsageResponseSchema,
  AdminUsdSchema,
  API_ERROR_CODES,
} from "../src/index.js";

const approvalId = "729a8ef5-35d8-458f-9e14-86a2e7598e67";
const fastCatalogId = "166b3dde-6308-4126-a312-0a83c6c006af";
const balancedCatalogId = "240a43c1-aab5-49ea-b105-6d21f6abfbe6";
const proCatalogId = "fa02d905-9b0f-46c6-933f-fd722d16f2d7";
const cursor = "eyJrIjoiZW1wbG95ZWUifQ.signature_1";

const pendingEmployee = {
  approvalId,
  userId: null,
  name: null,
  email: "employee@example.com",
  role: "member",
  status: "pending",
  monthlySoftBudgetUsd: null,
} as const;

const activeEmployee = {
  ...pendingEmployee,
  userId: "better-auth-user-1",
  name: "Andrea Pérez",
  status: "active",
  monthlySoftBudgetUsd: "25.000000000000000000",
} as const;

const catalogItems = [
  {
    catalogId: fastCatalogId,
    modelId: "provider/fast-model",
    displayName: "Fast model",
    available: true,
    contextLength: 131_072,
    maximumOutputTokens: 32_768,
    validatedAt: "2026-08-08T00:00:00.000Z",
  },
  {
    catalogId: balancedCatalogId,
    modelId: "provider/balanced-model",
    displayName: "Balanced model",
    available: true,
    contextLength: 131_072,
    maximumOutputTokens: 32_768,
    validatedAt: "2026-08-08T00:00:00.000Z",
  },
  {
    catalogId: proCatalogId,
    modelId: "provider/pro-model",
    displayName: "Pro model",
    available: false,
    contextLength: 131_072,
    maximumOutputTokens: 32_768,
    validatedAt: "2026-08-08T00:00:00.000Z",
  },
] as const;

const policyResponse = {
  revision: 2,
  currency: "USD",
  defaultTier: "balanced",
  monthlyBudgetUsd: "100.000000000000000000",
  tiers: [
    {
      tier: "fast",
      catalogId: fastCatalogId,
      enabled: true,
      available: true,
      maximumOutputTokens: 4_096,
      catalog: {
        modelId: catalogItems[0].modelId,
        displayName: catalogItems[0].displayName,
        available: catalogItems[0].available,
        contextLength: catalogItems[0].contextLength,
        maximumOutputTokens: catalogItems[0].maximumOutputTokens,
        validatedAt: catalogItems[0].validatedAt,
      },
    },
    {
      tier: "balanced",
      catalogId: balancedCatalogId,
      enabled: true,
      available: true,
      maximumOutputTokens: 8_192,
      catalog: {
        modelId: catalogItems[1].modelId,
        displayName: catalogItems[1].displayName,
        available: catalogItems[1].available,
        contextLength: catalogItems[1].contextLength,
        maximumOutputTokens: catalogItems[1].maximumOutputTokens,
        validatedAt: catalogItems[1].validatedAt,
      },
    },
    {
      tier: "pro",
      catalogId: proCatalogId,
      enabled: true,
      available: false,
      maximumOutputTokens: 16_384,
      catalog: {
        modelId: catalogItems[2].modelId,
        displayName: catalogItems[2].displayName,
        available: catalogItems[2].available,
        contextLength: catalogItems[2].contextLength,
        maximumOutputTokens: catalogItems[2].maximumOutputTokens,
        validatedAt: catalogItems[2].validatedAt,
      },
    },
  ],
} as const;

const policyRequest = {
  observedRevision: 2,
  defaultTier: "balanced",
  monthlyBudgetUsd: "100",
  tiers: policyResponse.tiers.map(({ available: _available, catalog: _catalog, ...tier }) => tier),
};

const usageResponse = {
  period: {
    start: "2026-08-01T05:00:00.000Z",
    end: "2026-09-01T05:00:00.000Z",
    timezone: "America/Guayaquil",
  },
  budget: {
    monthlyBudgetUsd: "100.000000000000000000",
    actualCostUsd: "12.000000000000000000",
    estimatedCostUsd: "1.000000000000000000",
    reservedCostUsd: "2.000000000000000000",
    remainingUsd: "85.000000000000000000",
  },
  items: [
    {
      employee: {
        id: "better-auth-user-1",
        name: "Andrea Pérez",
        email: "employee@example.com",
      },
      softBudget: {
        monthlyBudgetUsd: "25.000000000000000000",
        consumedUsd: "12.120000000000000000",
        warning: false,
      },
      groups: [
        {
          tier: "balanced",
          purpose: "chat",
          generationCount: 4,
          promptTokens: "9007199254740992",
          completionTokens: "500",
          reasoningTokens: "0",
          cachedTokens: "0",
          actualCostUsd: "0.120000000000000000",
          estimatedCostUsd: "0.000000000000000000",
        },
        {
          tier: "fast",
          purpose: "compaction",
          generationCount: 1,
          promptTokens: "100",
          completionTokens: "20",
          reasoningTokens: "0",
          cachedTokens: "0",
          actualCostUsd: "0.010000000000000000",
          estimatedCostUsd: "0",
        },
      ],
    },
  ],
  nextCursor: null,
} as const;

describe("Phase 7 administrator error codes", () => {
  it.each([
    "CATALOG_REFRESH_ACTIVE",
    "EMPLOYEE_APPROVAL_CONFLICT",
    "EMPLOYEE_DEACTIVATION_INCOMPLETE",
    "INVITATION_DELIVERY_FAILED",
    "MODEL_POLICY_CHANGED",
    "MODEL_POLICY_CONFLICT",
    "SESSION_REVOCATION_FAILED",
  ] as const)("exports %s", (code) => {
    expect(API_ERROR_CODES[code]).toBe(code);
  });
});

describe("administrator employee contracts", () => {
  it("accepts closed employee pages, params, approvals, and nullable identities", () => {
    expect(Value.Check(AdminEmployeeParamsSchema, { approvalId })).toBe(true);
    expect(Value.Check(AdminEmployeeListQuerySchema, {})).toBe(true);
    expect(Value.Check(AdminEmployeeListQuerySchema, { cursor })).toBe(true);
    expect(
      Value.Check(AdminEmployeeListResponseSchema, {
        items: [pendingEmployee, activeEmployee],
        nextCursor: cursor,
      }),
    ).toBe(true);
    expect(
      Value.Check(AdminApproveEmployeeRequestSchema, {
        email: pendingEmployee.email,
        role: "admin",
      }),
    ).toBe(true);
    expect(
      Value.Check(AdminApproveEmployeeResponseSchema, {
        employee: pendingEmployee,
        invitation: "sent",
        repeated: false,
      }),
    ).toBe(true);
  });

  it("rejects unsafe identifiers, invalid roles, oversized pages, and extra fields", () => {
    expect(Value.Check(AdminEmployeeParamsSchema, { approvalId: "not-a-uuid" })).toBe(false);
    expect(Value.Check(AdminEmployeeListQuerySchema, { cursor: "not-opaque" })).toBe(false);
    expect(Value.Check(AdminEmployeeListQuerySchema, { cursor, status: "active" })).toBe(false);
    expect(
      Value.Check(AdminApproveEmployeeRequestSchema, {
        email: "not-an-email",
        role: "owner",
      }),
    ).toBe(false);
    expect(
      Value.Check(AdminEmployeeListResponseSchema, {
        items: Array.from({ length: ADMIN_LIST_PAGE_SIZE + 1 }, () => pendingEmployee),
        nextCursor: null,
      }),
    ).toBe(false);
    expect(
      Value.Check(AdminApproveEmployeeResponseSchema, {
        employee: pendingEmployee,
        invitation: "sent",
        repeated: false,
        token: "secret",
      }),
    ).toBe(false);
  });

  it("covers empty mutations, deactivation, session revocation, and soft budgets", () => {
    expect(Value.Check(AdminEmptyRequestSchema, {})).toBe(true);
    expect(Value.Check(AdminEmptyRequestSchema, { reason: "cleanup" })).toBe(false);
    expect(
      Value.Check(AdminDeactivateEmployeeResponseSchema, {
        employee: { ...activeEmployee, status: "deactivated" },
        activeGenerationsCancelled: true,
        sessionsRevoked: true,
        repeated: false,
      }),
    ).toBe(true);
    expect(Value.Check(AdminSessionRevocationResponseSchema, null)).toBe(true);
    expect(Value.Check(AdminSessionRevocationResponseSchema, {})).toBe(false);
    expect(
      Value.Check(AdminEmployeeSoftBudgetRequestSchema, {
        monthlySoftBudgetUsd: "25.000000000000000000",
      }),
    ).toBe(true);
    expect(Value.Check(AdminEmployeeSoftBudgetRequestSchema, { monthlySoftBudgetUsd: null })).toBe(
      true,
    );
    expect(Value.Check(AdminEmployeeSoftBudgetResponseSchema, activeEmployee)).toBe(true);
  });
});

describe("canonical administrator money", () => {
  it.each(["0", "25", "25.0", "25.000000000000000000", "99999999999999999999"])(
    "accepts %s",
    (value) => {
      expect(Value.Check(AdminUsdSchema, value)).toBe(true);
    },
  );

  it.each([
    "",
    "-1",
    "+1",
    "01",
    ".5",
    "1.",
    "1e3",
    "1.0000000000000000000",
    "100000000000000000000",
  ])("rejects %s", (value) => {
    expect(Value.Check(AdminUsdSchema, value)).toBe(false);
  });
});

describe("administrator catalog contracts", () => {
  it("accepts paginated sanitized catalog rows and exact model IDs", () => {
    expect(Value.Check(AdminModelCatalogListQuerySchema, { cursor })).toBe(true);
    expect(Value.Check(AdminModelCatalogItemSchema, catalogItems[0])).toBe(true);
    expect(
      Value.Check(AdminModelCatalogListResponseSchema, {
        items: catalogItems,
        nextCursor: null,
      }),
    ).toBe(true);
    expect(
      Value.Check(AdminAddModelCatalogRequestSchema, { modelId: "moonshotai/kimi-k2.5" }),
    ).toBe(true);
  });

  it("rejects raw provider detail, whitespace, and malformed model IDs", () => {
    expect(
      Value.Check(AdminModelCatalogItemSchema, {
        ...catalogItems[0],
        endpoints: [{ provider: "private" }],
      }),
    ).toBe(false);
    expect(Value.Check(AdminAddModelCatalogRequestSchema, { modelId: "no-slash" })).toBe(false);
    expect(Value.Check(AdminAddModelCatalogRequestSchema, { modelId: "provider/model id" })).toBe(
      false,
    );
  });

  it("requires explicit cursor-bounded refresh requests and bounded aggregate responses", () => {
    expect(Value.Check(AdminRefreshModelCatalogRequestSchema, { cursor: null })).toBe(true);
    expect(Value.Check(AdminRefreshModelCatalogRequestSchema, { cursor })).toBe(true);
    expect(Value.Check(AdminRefreshModelCatalogRequestSchema, {})).toBe(false);
    expect(
      Value.Check(AdminRefreshModelCatalogResponseSchema, {
        available: 3,
        claimed: 3,
        unavailable: 0,
        updated: 3,
        nextCursor: cursor,
      }),
    ).toBe(true);
    expect(
      Value.Check(AdminRefreshModelCatalogResponseSchema, {
        available: 0,
        claimed: ADMIN_LIST_PAGE_SIZE + 1,
        unavailable: 0,
        updated: 0,
        nextCursor: null,
      }),
    ).toBe(false);
  });
});

describe("administrator model-policy contracts", () => {
  it("accepts backend-computed availability and mapped catalog metadata", () => {
    expect(Value.Check(AdminModelPolicyResponseSchema, policyResponse)).toBe(true);
    expect(Value.Check(AdminUpdateModelPolicyRequestSchema, policyRequest)).toBe(true);
  });

  it("requires canonical tier order and keeps derived fields response-only", () => {
    expect(
      Value.Check(AdminModelPolicyResponseSchema, {
        ...policyResponse,
        tiers: [...policyResponse.tiers].reverse(),
      }),
    ).toBe(false);
    expect(
      Value.Check(AdminUpdateModelPolicyRequestSchema, {
        ...policyRequest,
        tiers: policyRequest.tiers.map((tier) => ({ ...tier, available: true })),
      }),
    ).toBe(false);
    expect(
      Value.Check(AdminUpdateModelPolicyRequestSchema, {
        ...policyRequest,
        observedRevision: 0,
      }),
    ).toBe(false);
  });
});

describe("administrator usage contracts", () => {
  it("accepts employee-paginated usage with nested groups and large token strings", () => {
    expect(Value.Check(AdminUsageQuerySchema, {})).toBe(true);
    expect(Value.Check(AdminUsageQuerySchema, { cursor })).toBe(true);
    expect(Value.Check(AdminUsageResponseSchema, usageResponse)).toBe(true);
    expect(
      Value.Check(AdminUsageResponseSchema, {
        ...usageResponse,
        items: [
          {
            ...usageResponse.items[0],
            softBudget: {
              monthlyBudgetUsd: null,
              consumedUsd: "0",
              warning: false,
            },
            groups: [],
          },
        ],
      }),
    ).toBe(true);
  });

  it("accepts all nine tier-purpose groups and rejects a tenth", () => {
    const group = usageResponse.items[0].groups[0];
    const groups = (["fast", "balanced", "pro"] as const).flatMap((tier) =>
      (["chat", "compaction", "title"] as const).map((purpose) => ({
        ...group,
        purpose,
        tier,
      })),
    );
    const responseWithGroups = (boundedGroups: readonly unknown[]) => ({
      ...usageResponse,
      items: [{ ...usageResponse.items[0], groups: boundedGroups }],
    });

    expect(Value.Check(AdminUsageResponseSchema, responseWithGroups(groups))).toBe(true);
    expect(Value.Check(AdminUsageResponseSchema, responseWithGroups([...groups, group]))).toBe(
      false,
    );
  });

  it("rejects numeric token totals, unsupported purposes, and content-bearing extras", () => {
    expect(
      Value.Check(AdminUsageResponseSchema, {
        ...usageResponse,
        items: [
          {
            ...usageResponse.items[0],
            groups: [{ ...usageResponse.items[0].groups[0], promptTokens: 1_000 }],
          },
        ],
      }),
    ).toBe(false);
    expect(
      Value.Check(AdminUsageResponseSchema, {
        ...usageResponse,
        items: [
          {
            ...usageResponse.items[0],
            groups: [{ ...usageResponse.items[0].groups[0], purpose: "embedding" }],
          },
        ],
      }),
    ).toBe(false);
    expect(
      Value.Check(AdminUsageResponseSchema, {
        ...usageResponse,
        items: [{ ...usageResponse.items[0], conversationTitle: "Private content" }],
      }),
    ).toBe(false);
  });
});

import Type from "typebox";
import { OpaqueCursorSchema } from "./conversation.js";
import { GenerationModelTierSchema } from "./generation.js";

export const ADMIN_LIST_PAGE_SIZE = 50;
export const ADMIN_POLICY_HISTORY_PAGE_SIZE = 20;
export const ADMIN_POLICY_REVISION_MAX = 2_147_483_647;

const DatabaseIdentifierSchema = Type.String({ format: "uuid" });
const IdentityIdSchema = Type.String({
  minLength: 1,
  maxLength: 255,
  pattern: "^[^\\u0000-\\u001f\\u007f]+$",
});
const PersonNameSchema = Type.String({
  minLength: 1,
  maxLength: 255,
  pattern: "^(?=.*\\S)[^\\u0000-\\u001f\\u007f]+$",
});
const EmailSchema = Type.String({ format: "email", maxLength: 320 });
const PositiveDatabaseIntegerSchema = Type.Integer({ minimum: 1, maximum: 2_147_483_647 });

export const AdminRevisionActorSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("system"),
      label: Type.Literal("Sistema"),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("user"),
      userId: IdentityIdSchema,
      displayName: PersonNameSchema,
    },
    { additionalProperties: false },
  ),
]);
export type AdminRevisionActor = Type.Static<typeof AdminRevisionActorSchema>;

export const AdminUsdSchema = Type.String({
  minLength: 1,
  maxLength: 39,
  pattern: "^(?:0|[1-9][0-9]{0,19})(?:\\.[0-9]{1,18})?$",
});
export type AdminUsd = Type.Static<typeof AdminUsdSchema>;

export const AdminTokenTotalSchema = Type.String({
  minLength: 1,
  maxLength: 40,
  pattern: "^(?:0|[1-9][0-9]*)$",
});
export type AdminTokenTotal = Type.Static<typeof AdminTokenTotalSchema>;

export const AdminEmployeeRoleSchema = Type.Union([Type.Literal("member"), Type.Literal("admin")]);
export type AdminEmployeeRole = Type.Static<typeof AdminEmployeeRoleSchema>;

export const AdminEmployeeStatusSchema = Type.Union([
  Type.Literal("pending"),
  Type.Literal("active"),
  Type.Literal("deactivated"),
]);
export type AdminEmployeeStatus = Type.Static<typeof AdminEmployeeStatusSchema>;

export const AdminEmployeeSchema = Type.Object(
  {
    approvalId: DatabaseIdentifierSchema,
    userId: Type.Union([IdentityIdSchema, Type.Null()]),
    name: Type.Union([PersonNameSchema, Type.Null()]),
    email: EmailSchema,
    role: AdminEmployeeRoleSchema,
    status: AdminEmployeeStatusSchema,
    monthlySoftBudgetUsd: Type.Union([AdminUsdSchema, Type.Null()]),
  },
  { additionalProperties: false },
);
export type AdminEmployee = Type.Static<typeof AdminEmployeeSchema>;

export const AdminEmployeeParamsSchema = Type.Object(
  { approvalId: DatabaseIdentifierSchema },
  { additionalProperties: false },
);
export type AdminEmployeeParams = Type.Static<typeof AdminEmployeeParamsSchema>;

export const AdminCursorQuerySchema = Type.Object(
  { cursor: Type.Optional(OpaqueCursorSchema) },
  { additionalProperties: false },
);
export type AdminCursorQuery = Type.Static<typeof AdminCursorQuerySchema>;

export const AdminEmployeeListQuerySchema = AdminCursorQuerySchema;
export type AdminEmployeeListQuery = Type.Static<typeof AdminEmployeeListQuerySchema>;

export const AdminModelCatalogListQuerySchema = AdminCursorQuerySchema;
export type AdminModelCatalogListQuery = Type.Static<typeof AdminModelCatalogListQuerySchema>;

export const AdminUsageQuerySchema = AdminCursorQuerySchema;
export type AdminUsageQuery = Type.Static<typeof AdminUsageQuerySchema>;

export const AdminEmployeeListResponseSchema = Type.Object(
  {
    items: Type.Array(AdminEmployeeSchema, { maxItems: ADMIN_LIST_PAGE_SIZE }),
    nextCursor: Type.Union([OpaqueCursorSchema, Type.Null()]),
  },
  { additionalProperties: false },
);
export type AdminEmployeeListResponse = Type.Static<typeof AdminEmployeeListResponseSchema>;

export const AdminApproveEmployeeRequestSchema = Type.Object(
  {
    email: EmailSchema,
    role: AdminEmployeeRoleSchema,
  },
  { additionalProperties: false },
);
export type AdminApproveEmployeeRequest = Type.Static<typeof AdminApproveEmployeeRequestSchema>;

export const AdminApproveEmployeeResponseSchema = Type.Object(
  {
    employee: AdminEmployeeSchema,
    invitation: Type.Literal("sent"),
    repeated: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type AdminApproveEmployeeResponse = Type.Static<typeof AdminApproveEmployeeResponseSchema>;

export const AdminEmptyRequestSchema = Type.Object({}, { additionalProperties: false });
export type AdminEmptyRequest = Type.Static<typeof AdminEmptyRequestSchema>;

export const AdminInvitationResponseSchema = Type.Null();
export type AdminInvitationResponse = Type.Static<typeof AdminInvitationResponseSchema>;

export const AdminSessionRevocationResponseSchema = Type.Null();
export type AdminSessionRevocationResponse = Type.Static<
  typeof AdminSessionRevocationResponseSchema
>;

export const AdminDeactivateEmployeeResponseSchema = Type.Object(
  {
    employee: AdminEmployeeSchema,
    activeGenerationsCancelled: Type.Boolean(),
    sessionsRevoked: Type.Boolean(),
    repeated: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type AdminDeactivateEmployeeResponse = Type.Static<
  typeof AdminDeactivateEmployeeResponseSchema
>;

export const AdminEmployeeSoftBudgetRequestSchema = Type.Object(
  { monthlySoftBudgetUsd: Type.Union([AdminUsdSchema, Type.Null()]) },
  { additionalProperties: false },
);
export type AdminEmployeeSoftBudgetRequest = Type.Static<
  typeof AdminEmployeeSoftBudgetRequestSchema
>;

export const AdminEmployeeSoftBudgetResponseSchema = AdminEmployeeSchema;
export type AdminEmployeeSoftBudgetResponse = Type.Static<
  typeof AdminEmployeeSoftBudgetResponseSchema
>;

export const AdminModelIdSchema = Type.String({
  minLength: 3,
  maxLength: 512,
  pattern: "^[^\\s/\\u0000-\\u001f\\u007f]+/[^\\s\\u0000-\\u001f\\u007f]+$",
});
export type AdminModelId = Type.Static<typeof AdminModelIdSchema>;

const CatalogDisplayNameSchema = Type.String({
  minLength: 1,
  maxLength: 255,
  pattern: "^(?=.*\\S)[^\\u0000-\\u001f\\u007f]+$",
});

export const AdminGatewayEffortSchema = Type.Union([
  Type.Literal("none"),
  Type.Literal("minimal"),
  Type.Literal("low"),
  Type.Literal("medium"),
  Type.Literal("high"),
  Type.Literal("xhigh"),
  Type.Literal("max"),
]);
export type AdminGatewayEffort = Type.Static<typeof AdminGatewayEffortSchema>;

export const AdminReasoningEffortSchema = Type.Union([
  Type.Literal("off"),
  Type.Literal("low"),
  Type.Literal("medium"),
  Type.Literal("high"),
]);
export type AdminReasoningEffort = Type.Static<typeof AdminReasoningEffortSchema>;

export const AdminReasoningBudgetTokensSchema = Type.Union([
  Type.Literal(0),
  Type.Literal(1_024),
  Type.Literal(2_048),
  Type.Literal(4_096),
  Type.Literal(8_192),
]);
export type AdminReasoningBudgetTokens = Type.Static<typeof AdminReasoningBudgetTokensSchema>;

export const AdminTemperaturePresetSchema = Type.Union([
  Type.Literal("precise"),
  Type.Literal("balanced"),
  Type.Literal("flexible"),
  Type.Literal("creative"),
]);
export type AdminTemperaturePreset = Type.Static<typeof AdminTemperaturePresetSchema>;

export const AdminReasoningCapabilitySchema = Type.Object(
  {
    kind: Type.Union([
      Type.Literal("none"),
      Type.Literal("optional"),
      Type.Literal("mandatory"),
      Type.Literal("unverified"),
    ]),
    effortSupport: Type.Union([
      Type.Object({ kind: Type.Literal("none") }, { additionalProperties: false }),
      Type.Object({ kind: Type.Literal("all") }, { additionalProperties: false }),
      Type.Object(
        {
          kind: Type.Literal("listed"),
          values: Type.Array(AdminGatewayEffortSchema, { maxItems: 7, minItems: 1 }),
        },
        { additionalProperties: false },
      ),
    ]),
    maxTokensAccepted: Type.Boolean(),
    defaultEffort: Type.Union([AdminGatewayEffortSchema, Type.Null()]),
    defaultEnabled: Type.Union([Type.Boolean(), Type.Null()]),
    traceSafety: Type.Union([
      Type.Literal("non_reasoning"),
      Type.Literal("provider_excluded"),
      Type.Literal("unverified"),
    ]),
  },
  { additionalProperties: false },
);
export type AdminReasoningCapability = Type.Static<typeof AdminReasoningCapabilitySchema>;

export const AdminModelCapabilitySchema = Type.Object(
  {
    temperatureSupported: Type.Boolean(),
    reasoning: AdminReasoningCapabilitySchema,
  },
  { additionalProperties: false },
);
export type AdminModelCapability = Type.Static<typeof AdminModelCapabilitySchema>;

export const AdminParameterSupportKindSchema = Type.Union([
  Type.Literal("exact"),
  Type.Literal("translated"),
  Type.Literal("unsupported"),
  Type.Literal("mandatory"),
]);
export type AdminParameterSupportKind = Type.Static<typeof AdminParameterSupportKindSchema>;

export const AdminParameterSupportReasonSchema = Type.Union([
  Type.Literal("supported"),
  Type.Literal("temperature_unsupported"),
  Type.Literal("non_reasoning_model"),
  Type.Literal("reasoning_disabled"),
  Type.Literal("mandatory_reasoning"),
  Type.Literal("max_tokens_precision_unverified"),
  Type.Literal("effort_nearest_supported"),
  Type.Literal("effort_control_unavailable"),
  Type.Literal("budget_control_unavailable"),
  Type.Literal("provider_default_strength"),
  Type.Literal("capability_unverified"),
]);
export type AdminParameterSupportReason = Type.Static<typeof AdminParameterSupportReasonSchema>;

export const AdminParameterSupportSchema = Type.Object(
  {
    kind: AdminParameterSupportKindSchema,
    reason: AdminParameterSupportReasonSchema,
  },
  { additionalProperties: false },
);
export type AdminParameterSupport = Type.Static<typeof AdminParameterSupportSchema>;

export const AdminModelCatalogItemSchema = Type.Object(
  {
    catalogId: DatabaseIdentifierSchema,
    modelId: AdminModelIdSchema,
    displayName: CatalogDisplayNameSchema,
    available: Type.Boolean(),
    contextLength: PositiveDatabaseIntegerSchema,
    maximumOutputTokens: PositiveDatabaseIntegerSchema,
    capability: AdminModelCapabilitySchema,
    validatedAt: Type.String({ format: "date-time" }),
  },
  { additionalProperties: false },
);
export type AdminModelCatalogItem = Type.Static<typeof AdminModelCatalogItemSchema>;

export const AdminModelCatalogListResponseSchema = Type.Object(
  {
    items: Type.Array(AdminModelCatalogItemSchema, { maxItems: ADMIN_LIST_PAGE_SIZE }),
    nextCursor: Type.Union([OpaqueCursorSchema, Type.Null()]),
  },
  { additionalProperties: false },
);
export type AdminModelCatalogListResponse = Type.Static<typeof AdminModelCatalogListResponseSchema>;

export const AdminAddModelCatalogRequestSchema = Type.Object(
  { modelId: AdminModelIdSchema },
  { additionalProperties: false },
);
export type AdminAddModelCatalogRequest = Type.Static<typeof AdminAddModelCatalogRequestSchema>;

export const AdminAddModelCatalogResponseSchema = AdminModelCatalogItemSchema;
export type AdminAddModelCatalogResponse = Type.Static<typeof AdminAddModelCatalogResponseSchema>;

export const AdminRefreshModelCatalogRequestSchema = Type.Object(
  { cursor: Type.Union([OpaqueCursorSchema, Type.Null()]) },
  { additionalProperties: false },
);
export type AdminRefreshModelCatalogRequest = Type.Static<
  typeof AdminRefreshModelCatalogRequestSchema
>;

export const AdminRefreshModelCatalogResponseSchema = Type.Object(
  {
    available: Type.Integer({ minimum: 0, maximum: ADMIN_LIST_PAGE_SIZE }),
    claimed: Type.Integer({ minimum: 0, maximum: ADMIN_LIST_PAGE_SIZE }),
    unavailable: Type.Integer({ minimum: 0, maximum: ADMIN_LIST_PAGE_SIZE }),
    updated: Type.Integer({ minimum: 0, maximum: ADMIN_LIST_PAGE_SIZE }),
    nextCursor: Type.Union([OpaqueCursorSchema, Type.Null()]),
  },
  { additionalProperties: false },
);
export type AdminRefreshModelCatalogResponse = Type.Static<
  typeof AdminRefreshModelCatalogResponseSchema
>;

const AdminMappedCatalogSchema = Type.Object(
  {
    modelId: AdminModelIdSchema,
    displayName: CatalogDisplayNameSchema,
    available: Type.Boolean(),
    contextLength: PositiveDatabaseIntegerSchema,
    maximumOutputTokens: PositiveDatabaseIntegerSchema,
    capability: AdminModelCapabilitySchema,
    validatedAt: Type.String({ format: "date-time" }),
  },
  { additionalProperties: false },
);

const adminModelPolicyTierResponse = (tier: "fast" | "balanced" | "pro") =>
  Type.Object(
    {
      tier: Type.Literal(tier),
      catalogId: DatabaseIdentifierSchema,
      enabled: Type.Boolean(),
      available: Type.Boolean(),
      maximumOutputTokens: PositiveDatabaseIntegerSchema,
      reasoningEffort: AdminReasoningEffortSchema,
      reasoningBudgetTokens: AdminReasoningBudgetTokensSchema,
      temperaturePreset: AdminTemperaturePresetSchema,
      temperatureStatus: AdminParameterSupportSchema,
      effortStatus: AdminParameterSupportSchema,
      budgetStatus: AdminParameterSupportSchema,
      catalog: AdminMappedCatalogSchema,
    },
    { additionalProperties: false },
  );

const adminModelPolicyTierRequest = (tier: "fast" | "balanced" | "pro") =>
  Type.Object(
    {
      tier: Type.Literal(tier),
      catalogId: DatabaseIdentifierSchema,
      enabled: Type.Boolean(),
      maximumOutputTokens: PositiveDatabaseIntegerSchema,
      reasoningEffort: AdminReasoningEffortSchema,
      reasoningBudgetTokens: AdminReasoningBudgetTokensSchema,
      temperaturePreset: AdminTemperaturePresetSchema,
    },
    { additionalProperties: false },
  );

export const AdminModelPolicyResponseSchema = Type.Object(
  {
    revision: Type.Integer({ minimum: 1, maximum: ADMIN_POLICY_REVISION_MAX }),
    currency: Type.Literal("USD"),
    defaultTier: GenerationModelTierSchema,
    monthlyBudgetUsd: AdminUsdSchema,
    actor: AdminRevisionActorSchema,
    changeKind: Type.Union([
      Type.Literal("bootstrap"),
      Type.Literal("migration"),
      Type.Literal("update"),
      Type.Literal("revert"),
    ]),
    revertedFromRevision: Type.Union([
      Type.Integer({ minimum: 1, maximum: ADMIN_POLICY_REVISION_MAX }),
      Type.Null(),
    ]),
    updatedAt: Type.String({ format: "date-time" }),
    tiers: Type.Tuple([
      adminModelPolicyTierResponse("fast"),
      adminModelPolicyTierResponse("balanced"),
      adminModelPolicyTierResponse("pro"),
    ]),
  },
  { additionalProperties: false },
);
export type AdminModelPolicyResponse = Type.Static<typeof AdminModelPolicyResponseSchema>;

export const AdminUpdateModelPolicyRequestSchema = Type.Object(
  {
    observedRevision: Type.Integer({ minimum: 1, maximum: ADMIN_POLICY_REVISION_MAX }),
    defaultTier: GenerationModelTierSchema,
    monthlyBudgetUsd: AdminUsdSchema,
    tiers: Type.Tuple([
      adminModelPolicyTierRequest("fast"),
      adminModelPolicyTierRequest("balanced"),
      adminModelPolicyTierRequest("pro"),
    ]),
  },
  { additionalProperties: false },
);
export type AdminUpdateModelPolicyRequest = Type.Static<typeof AdminUpdateModelPolicyRequestSchema>;

export const AdminUpdateModelPolicyResponseSchema = AdminModelPolicyResponseSchema;
export type AdminUpdateModelPolicyResponse = Type.Static<
  typeof AdminUpdateModelPolicyResponseSchema
>;

export const AdminModelPolicyHistoryQuerySchema = AdminCursorQuerySchema;
export type AdminModelPolicyHistoryQuery = Type.Static<typeof AdminModelPolicyHistoryQuerySchema>;

export const AdminModelPolicyHistoryResponseSchema = Type.Object(
  {
    items: Type.Array(AdminModelPolicyResponseSchema, {
      maxItems: ADMIN_POLICY_HISTORY_PAGE_SIZE,
    }),
    nextCursor: Type.Union([OpaqueCursorSchema, Type.Null()]),
  },
  { additionalProperties: false },
);
export type AdminModelPolicyHistoryResponse = Type.Static<
  typeof AdminModelPolicyHistoryResponseSchema
>;

export const AdminModelPolicyRevisionParamsSchema = Type.Object(
  {
    revision: Type.Integer({ minimum: 1, maximum: ADMIN_POLICY_REVISION_MAX }),
  },
  { additionalProperties: false },
);
export type AdminModelPolicyRevisionParams = Type.Static<
  typeof AdminModelPolicyRevisionParamsSchema
>;

export const AdminRevertModelPolicyRequestSchema = Type.Object(
  {
    observedRevision: Type.Integer({ minimum: 1, maximum: ADMIN_POLICY_REVISION_MAX }),
  },
  { additionalProperties: false },
);
export type AdminRevertModelPolicyRequest = Type.Static<typeof AdminRevertModelPolicyRequestSchema>;

export const AdminUsagePurposeSchema = Type.Union([
  Type.Literal("chat"),
  Type.Literal("compaction"),
  Type.Literal("title"),
]);
export type AdminUsagePurpose = Type.Static<typeof AdminUsagePurposeSchema>;

export const AdminUsageGroupSchema = Type.Object(
  {
    tier: GenerationModelTierSchema,
    purpose: AdminUsagePurposeSchema,
    generationCount: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    promptTokens: AdminTokenTotalSchema,
    completionTokens: AdminTokenTotalSchema,
    reasoningTokens: AdminTokenTotalSchema,
    cachedTokens: AdminTokenTotalSchema,
    actualCostUsd: AdminUsdSchema,
    estimatedCostUsd: AdminUsdSchema,
  },
  { additionalProperties: false },
);
export type AdminUsageGroup = Type.Static<typeof AdminUsageGroupSchema>;

const AdminUsageEmployeeSchema = Type.Object(
  {
    id: IdentityIdSchema,
    name: PersonNameSchema,
    email: EmailSchema,
  },
  { additionalProperties: false },
);

export const AdminEmployeeSoftBudgetUsageSchema = Type.Object(
  {
    monthlyBudgetUsd: Type.Union([AdminUsdSchema, Type.Null()]),
    consumedUsd: AdminUsdSchema,
    warning: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type AdminEmployeeSoftBudgetUsage = Type.Static<typeof AdminEmployeeSoftBudgetUsageSchema>;

export const AdminEmployeeUsageSchema = Type.Object(
  {
    employee: AdminUsageEmployeeSchema,
    softBudget: AdminEmployeeSoftBudgetUsageSchema,
    groups: Type.Array(AdminUsageGroupSchema, { maxItems: 9 }),
  },
  { additionalProperties: false },
);
export type AdminEmployeeUsage = Type.Static<typeof AdminEmployeeUsageSchema>;

const AdminUsagePeriodSchema = Type.Object(
  {
    start: Type.String({ format: "date-time" }),
    end: Type.String({ format: "date-time" }),
    timezone: Type.String({ minLength: 1, maxLength: 255 }),
  },
  { additionalProperties: false },
);

const AdminWorkspaceBudgetUsageSchema = Type.Object(
  {
    monthlyBudgetUsd: AdminUsdSchema,
    actualCostUsd: AdminUsdSchema,
    estimatedCostUsd: AdminUsdSchema,
    reservedCostUsd: AdminUsdSchema,
    remainingUsd: AdminUsdSchema,
  },
  { additionalProperties: false },
);

export const AdminUsageResponseSchema = Type.Object(
  {
    period: AdminUsagePeriodSchema,
    budget: AdminWorkspaceBudgetUsageSchema,
    items: Type.Array(AdminEmployeeUsageSchema, { maxItems: ADMIN_LIST_PAGE_SIZE }),
    nextCursor: Type.Union([OpaqueCursorSchema, Type.Null()]),
  },
  { additionalProperties: false },
);
export type AdminUsageResponse = Type.Static<typeof AdminUsageResponseSchema>;

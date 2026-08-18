import Type from "typebox";
import { OpaqueCursorSchema } from "./conversation.js";

export const ASSISTANT_RULES_MAX_CODE_POINTS = 3_200;
export const ASSISTANT_RULES_MAX_UTF8_BYTES = 12_800;
export const ASSISTANT_RULES_HTTP_BODY_LIMIT_BYTES = 20 * 1_024;
export const ASSISTANT_RULES_HISTORY_PAGE_SIZE = 20;
export const ASSISTANT_RULES_REVISION_MAX = 2_147_483_647;

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
const RevisionSchema = Type.Integer({ minimum: 1, maximum: ASSISTANT_RULES_REVISION_MAX });
const WorkspaceTextSchema = Type.String({ maxLength: ASSISTANT_RULES_MAX_UTF8_BYTES });
const PromptTextSchema = Type.String({ minLength: 1 });
const NullablePercentageSchema = Type.Union([
  Type.String({
    minLength: 1,
    maxLength: 64,
    pattern: "^(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?$",
  }),
  Type.Null(),
]);

export const AssistantRulesActorSchema = Type.Union([
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
export type AssistantRulesActor = Type.Static<typeof AssistantRulesActorSchema>;

export const AssistantRulesChangeKindSchema = Type.Union([
  Type.Literal("bootstrap"),
  Type.Literal("save"),
  Type.Literal("reset"),
  Type.Literal("revert"),
]);
export type AssistantRulesChangeKind = Type.Static<typeof AssistantRulesChangeKindSchema>;

export const AssistantRulesCountsSchema = Type.Object(
  {
    codePoints: Type.Integer({ minimum: 0, maximum: ASSISTANT_RULES_MAX_CODE_POINTS }),
    utf8Bytes: Type.Integer({ minimum: 0, maximum: ASSISTANT_RULES_MAX_UTF8_BYTES }),
    approximateInputTokens: Type.Integer({ minimum: 0, maximum: ASSISTANT_RULES_MAX_UTF8_BYTES }),
  },
  { additionalProperties: false },
);
export type AssistantRulesCounts = Type.Static<typeof AssistantRulesCountsSchema>;

export const AssistantRulesEstimateSchema = Type.Object(
  {
    counts: AssistantRulesCountsSchema,
    balancedMaximumResponseCostPercent: NullablePercentageSchema,
  },
  { additionalProperties: false },
);
export type AssistantRulesEstimate = Type.Static<typeof AssistantRulesEstimateSchema>;

export const AssistantRulesLimitsSchema = Type.Object(
  {
    maximumCodePoints: Type.Literal(ASSISTANT_RULES_MAX_CODE_POINTS),
    maximumUtf8Bytes: Type.Literal(ASSISTANT_RULES_MAX_UTF8_BYTES),
  },
  { additionalProperties: false },
);
export type AssistantRulesLimits = Type.Static<typeof AssistantRulesLimitsSchema>;

export const AssistantRulesDisclosureSchema = Type.Object(
  {
    visibleToActiveMembers: Type.Literal(true),
    sentToConfiguredZdrProvider: Type.Literal(true),
    retainedInImmutableHistory: Type.Literal(true),
  },
  { additionalProperties: false },
);
export type AssistantRulesDisclosure = Type.Static<typeof AssistantRulesDisclosureSchema>;

export const MemberAssistantRulesResponseSchema = Type.Object(
  {
    baseVersion: Type.String({ minLength: 1, maxLength: 255 }),
    baseText: PromptTextSchema,
    workspaceText: WorkspaceTextSchema,
    effectivePrompt: PromptTextSchema,
    updatedAt: Type.String({ format: "date-time" }),
  },
  { additionalProperties: false },
);
export type MemberAssistantRulesResponse = Type.Static<typeof MemberAssistantRulesResponseSchema>;

export const AdminAssistantRulesResponseSchema = Type.Object(
  {
    revision: RevisionSchema,
    baseVersion: Type.String({ minLength: 1, maxLength: 255 }),
    baseText: PromptTextSchema,
    workspaceText: WorkspaceTextSchema,
    effectivePrompt: PromptTextSchema,
    actor: AssistantRulesActorSchema,
    changeKind: AssistantRulesChangeKindSchema,
    revertedFromRevision: Type.Union([RevisionSchema, Type.Null()]),
    updatedAt: Type.String({ format: "date-time" }),
    limits: AssistantRulesLimitsSchema,
    disclosure: AssistantRulesDisclosureSchema,
    estimate: AssistantRulesEstimateSchema,
  },
  { additionalProperties: false },
);
export type AdminAssistantRulesResponse = Type.Static<typeof AdminAssistantRulesResponseSchema>;

export const PreviewAssistantRulesRequestSchema = Type.Object(
  { workspaceText: WorkspaceTextSchema },
  { additionalProperties: false },
);
export type PreviewAssistantRulesRequest = Type.Static<typeof PreviewAssistantRulesRequestSchema>;

export const PreviewAssistantRulesResponseSchema = Type.Object(
  {
    normalizedWorkspaceText: WorkspaceTextSchema,
    effectivePrompt: PromptTextSchema,
    estimate: AssistantRulesEstimateSchema,
  },
  { additionalProperties: false },
);
export type PreviewAssistantRulesResponse = Type.Static<typeof PreviewAssistantRulesResponseSchema>;

export const UpdateAssistantRulesRequestSchema = Type.Object(
  {
    observedRevision: RevisionSchema,
    workspaceText: WorkspaceTextSchema,
  },
  { additionalProperties: false },
);
export type UpdateAssistantRulesRequest = Type.Static<typeof UpdateAssistantRulesRequestSchema>;

export const ResetAssistantRulesRequestSchema = Type.Object(
  { observedRevision: RevisionSchema },
  { additionalProperties: false },
);
export type ResetAssistantRulesRequest = Type.Static<typeof ResetAssistantRulesRequestSchema>;

export const AssistantRulesHistoryQuerySchema = Type.Object(
  { cursor: Type.Optional(OpaqueCursorSchema) },
  { additionalProperties: false },
);
export type AssistantRulesHistoryQuery = Type.Static<typeof AssistantRulesHistoryQuerySchema>;

export const AssistantRulesRevisionSchema = Type.Object(
  {
    revision: RevisionSchema,
    workspaceText: WorkspaceTextSchema,
    actor: AssistantRulesActorSchema,
    changeKind: AssistantRulesChangeKindSchema,
    revertedFromRevision: Type.Union([RevisionSchema, Type.Null()]),
    createdAt: Type.String({ format: "date-time" }),
  },
  { additionalProperties: false },
);
export type AssistantRulesRevision = Type.Static<typeof AssistantRulesRevisionSchema>;

export const AssistantRulesHistoryResponseSchema = Type.Object(
  {
    items: Type.Array(AssistantRulesRevisionSchema, {
      maxItems: ASSISTANT_RULES_HISTORY_PAGE_SIZE,
    }),
    nextCursor: Type.Union([OpaqueCursorSchema, Type.Null()]),
  },
  { additionalProperties: false },
);
export type AssistantRulesHistoryResponse = Type.Static<typeof AssistantRulesHistoryResponseSchema>;

export const AssistantRulesRevisionParamsSchema = Type.Object(
  { revision: RevisionSchema },
  { additionalProperties: false },
);
export type AssistantRulesRevisionParams = Type.Static<typeof AssistantRulesRevisionParamsSchema>;

export const RevertAssistantRulesRequestSchema = ResetAssistantRulesRequestSchema;
export type RevertAssistantRulesRequest = Type.Static<typeof RevertAssistantRulesRequestSchema>;

import Type from "typebox";
import {
  ConversationIdSchema,
  ConversationRevisionSchema,
  MessageIdSchema,
  UserMessageContentSchema,
} from "./conversation.js";

export const GenerationIdSchema = Type.String({ format: "uuid" });
export type GenerationId = Type.Static<typeof GenerationIdSchema>;

export const GenerationModelTierSchema = Type.Literal("balanced");
export type GenerationModelTier = Type.Static<typeof GenerationModelTierSchema>;

export const GenerationStatusSchema = Type.Enum([
  "active",
  "completed",
  "cancelled",
  "incomplete",
  "failed",
] as const);
export type GenerationStatus = Type.Static<typeof GenerationStatusSchema>;

export const GenerationTerminalReasonSchema = Type.Enum([
  "stop",
  "length",
  "refusal",
  "content_filter",
  "cancelled",
  "error",
] as const);
export type GenerationTerminalReason = Type.Static<typeof GenerationTerminalReasonSchema>;

export const CompletedGenerationReasonSchema = Type.Enum([
  "stop",
  "length",
  "refusal",
  "content_filter",
] as const);
export type CompletedGenerationReason = Type.Static<typeof CompletedGenerationReasonSchema>;

export const StreamFailureErrorCodeSchema = Type.Enum([
  "EMPTY_RESPONSE",
  "GENERATION_FAILED",
  "GENERATION_TIMEOUT",
  "MODEL_UNAVAILABLE",
] as const);
export type StreamFailureErrorCode = Type.Static<typeof StreamFailureErrorCodeSchema>;

export const StoredGenerationErrorCodeSchema = Type.Enum([
  "EMPTY_RESPONSE",
  "GENERATION_FAILED",
  "GENERATION_TIMEOUT",
  "MODEL_UNAVAILABLE",
  "STREAM_INTERRUPTED",
] as const);
export type StoredGenerationErrorCode = Type.Static<typeof StoredGenerationErrorCodeSchema>;

export const IdempotencyKeySchema = Type.String({
  pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
});
export type IdempotencyKey = Type.Static<typeof IdempotencyKeySchema>;

export const CreateResponseRequestHeadersSchema = Type.Object(
  {
    accept: Type.Literal("application/x-ndjson"),
    "idempotency-key": IdempotencyKeySchema,
  },
  { additionalProperties: true },
);
export type CreateResponseRequestHeaders = Type.Static<typeof CreateResponseRequestHeadersSchema>;

export const CreateDraftResponseRequestSchema = Type.Object(
  {
    source: Type.Literal("draft"),
    parentMessageId: Type.Union([MessageIdSchema, Type.Null()]),
    content: UserMessageContentSchema,
    modelTier: GenerationModelTierSchema,
    observedRevision: ConversationRevisionSchema,
    draftRevision: ConversationRevisionSchema,
  },
  { additionalProperties: false },
);
export type CreateDraftResponseRequest = Type.Static<typeof CreateDraftResponseRequestSchema>;

export const CreateContinueResponseRequestSchema = Type.Object(
  {
    source: Type.Literal("continue"),
    parentMessageId: MessageIdSchema,
    modelTier: GenerationModelTierSchema,
    observedRevision: ConversationRevisionSchema,
  },
  { additionalProperties: false },
);
export type CreateContinueResponseRequest = Type.Static<typeof CreateContinueResponseRequestSchema>;

export const CreateEditResponseRequestSchema = Type.Object(
  {
    source: Type.Literal("edit"),
    targetMessageId: MessageIdSchema,
    parentMessageId: Type.Union([MessageIdSchema, Type.Null()]),
    content: UserMessageContentSchema,
    modelTier: GenerationModelTierSchema,
    observedRevision: ConversationRevisionSchema,
  },
  { additionalProperties: false },
);
export type CreateEditResponseRequest = Type.Static<typeof CreateEditResponseRequestSchema>;

export const CreateRetryResponseRequestSchema = Type.Object(
  {
    source: Type.Literal("retry"),
    targetMessageId: MessageIdSchema,
    parentMessageId: MessageIdSchema,
    modelTier: GenerationModelTierSchema,
    observedRevision: ConversationRevisionSchema,
  },
  { additionalProperties: false },
);
export type CreateRetryResponseRequest = Type.Static<typeof CreateRetryResponseRequestSchema>;

export const CreateResponseRequestSchema = Type.Union([
  CreateDraftResponseRequestSchema,
  CreateContinueResponseRequestSchema,
  CreateEditResponseRequestSchema,
  CreateRetryResponseRequestSchema,
]);
export type CreateResponseRequest = Type.Static<typeof CreateResponseRequestSchema>;

export const CancelGenerationParamsSchema = Type.Object(
  {
    conversationId: ConversationIdSchema,
    generationId: GenerationIdSchema,
  },
  { additionalProperties: false },
);
export type CancelGenerationParams = Type.Static<typeof CancelGenerationParamsSchema>;

export const CancelGenerationRequestSchema = Type.Object({}, { additionalProperties: false });
export type CancelGenerationRequest = Type.Static<typeof CancelGenerationRequestSchema>;

export const CancelGenerationResponseSchema = Type.Null();
export type CancelGenerationResponse = Type.Static<typeof CancelGenerationResponseSchema>;

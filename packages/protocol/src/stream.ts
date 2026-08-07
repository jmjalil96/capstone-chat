import Type from "typebox";
import {
  ConversationIdSchema,
  ConversationRevisionSchema,
  MessageIdSchema,
} from "./conversation.js";
import {
  CompletedGenerationReasonSchema,
  GenerationIdSchema,
  StreamFailureErrorCodeSchema,
} from "./generation.js";

function isValidUnicode(value: string): boolean {
  return value.isWellFormed();
}

export const GenerationUsageSchema = Type.Object(
  {
    inputTokens: Type.Integer({ minimum: 0 }),
    outputTokens: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);
export type GenerationUsage = Type.Static<typeof GenerationUsageSchema>;

export const ResponseStartedEventSchema = Type.Object(
  {
    type: Type.Literal("response.started"),
    conversationId: ConversationIdSchema,
    generationId: GenerationIdSchema,
    userMessageId: MessageIdSchema,
    messageId: MessageIdSchema,
    revision: ConversationRevisionSchema,
  },
  { additionalProperties: false },
);
export type ResponseStartedEvent = Type.Static<typeof ResponseStartedEventSchema>;

export const ContextCompactingEventSchema = Type.Object(
  { type: Type.Literal("context.compacting") },
  { additionalProperties: false },
);
export type ContextCompactingEvent = Type.Static<typeof ContextCompactingEventSchema>;

export const ContextCompactedEventSchema = Type.Object(
  { type: Type.Literal("context.compacted") },
  { additionalProperties: false },
);
export type ContextCompactedEvent = Type.Static<typeof ContextCompactedEventSchema>;

export const ContextWarningEventSchema = Type.Object(
  {
    type: Type.Literal("context.warning"),
    code: Type.Literal("CONTEXT_COMPACTION_FALLBACK"),
  },
  { additionalProperties: false },
);
export type ContextWarningEvent = Type.Static<typeof ContextWarningEventSchema>;

export const ContentDeltaEventSchema = Type.Object(
  {
    type: Type.Literal("content.delta"),
    text: Type.Refine(Type.String({ minLength: 1 }), isValidUnicode),
  },
  { additionalProperties: false },
);
export type ContentDeltaEvent = Type.Static<typeof ContentDeltaEventSchema>;

export const ResponseCompletedEventSchema = Type.Object(
  {
    type: Type.Literal("response.completed"),
    messageId: MessageIdSchema,
    revision: ConversationRevisionSchema,
    reason: CompletedGenerationReasonSchema,
    usage: GenerationUsageSchema,
  },
  { additionalProperties: false },
);
export type ResponseCompletedEvent = Type.Static<typeof ResponseCompletedEventSchema>;

export const ResponseCancelledEventSchema = Type.Object(
  {
    type: Type.Literal("response.cancelled"),
    messageId: MessageIdSchema,
    revision: ConversationRevisionSchema,
    usage: Type.Optional(GenerationUsageSchema),
  },
  { additionalProperties: false },
);
export type ResponseCancelledEvent = Type.Static<typeof ResponseCancelledEventSchema>;

export const ResponseFailedEventSchema = Type.Object(
  {
    type: Type.Literal("response.failed"),
    messageId: MessageIdSchema,
    revision: ConversationRevisionSchema,
    errorCode: StreamFailureErrorCodeSchema,
    partial: Type.Boolean(),
    usage: Type.Optional(GenerationUsageSchema),
  },
  { additionalProperties: false },
);
export type ResponseFailedEvent = Type.Static<typeof ResponseFailedEventSchema>;

export const StreamEventSchema = Type.Union([
  ResponseStartedEventSchema,
  ContextCompactingEventSchema,
  ContextCompactedEventSchema,
  ContextWarningEventSchema,
  ContentDeltaEventSchema,
  ResponseCompletedEventSchema,
  ResponseCancelledEventSchema,
  ResponseFailedEventSchema,
]);
export type StreamEvent = Type.Static<typeof StreamEventSchema>;

import Type from "typebox";
import {
  CONVERSATION_MESSAGE_PAGE_SIZE,
  ConversationIdSchema,
  ConversationRevisionSchema,
  MessageIdSchema,
} from "./conversation.js";
import {
  CompletedGenerationReasonSchema,
  GenerationIdSchema,
  StoredGenerationErrorCodeSchema,
} from "./generation.js";

export const ResponseStateRequestSchema = Type.Object(
  {
    messageIds: Type.Array(MessageIdSchema, {
      maxItems: CONVERSATION_MESSAGE_PAGE_SIZE,
      uniqueItems: true,
    }),
  },
  { additionalProperties: false },
);
export type ResponseStateRequest = Type.Static<typeof ResponseStateRequestSchema>;

const responseStateIdentity = {
  generationId: GenerationIdSchema,
  messageId: MessageIdSchema,
};

export const ActiveResponseStateSchema = Type.Object(
  {
    ...responseStateIdentity,
    status: Type.Literal("active"),
    reason: Type.Null(),
    errorCode: Type.Null(),
  },
  { additionalProperties: false },
);

export const CompletedResponseStateSchema = Type.Object(
  {
    ...responseStateIdentity,
    status: Type.Literal("completed"),
    reason: CompletedGenerationReasonSchema,
    errorCode: Type.Null(),
  },
  { additionalProperties: false },
);

export const CancelledResponseStateSchema = Type.Object(
  {
    ...responseStateIdentity,
    status: Type.Literal("cancelled"),
    reason: Type.Literal("cancelled"),
    errorCode: Type.Null(),
  },
  { additionalProperties: false },
);

export const FailedResponseStateSchema = Type.Object(
  {
    ...responseStateIdentity,
    status: Type.Enum(["incomplete", "failed"] as const),
    reason: Type.Literal("error"),
    errorCode: StoredGenerationErrorCodeSchema,
  },
  { additionalProperties: false },
);

export const ResponseStateSchema = Type.Union([
  ActiveResponseStateSchema,
  CompletedResponseStateSchema,
  CancelledResponseStateSchema,
  FailedResponseStateSchema,
]);
export type ResponseState = Type.Static<typeof ResponseStateSchema>;

export const ResponseStateResponseSchema = Type.Object(
  {
    conversationId: ConversationIdSchema,
    revision: ConversationRevisionSchema,
    responses: Type.Array(ResponseStateSchema, {
      maxItems: CONVERSATION_MESSAGE_PAGE_SIZE,
    }),
  },
  { additionalProperties: false },
);
export type ResponseStateResponse = Type.Static<typeof ResponseStateResponseSchema>;

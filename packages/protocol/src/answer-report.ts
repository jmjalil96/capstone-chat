import Type from "typebox";
import {
  CONVERSATION_MESSAGE_PAGE_SIZE,
  ConversationIdSchema,
  MessageIdSchema,
  OpaqueCursorSchema,
} from "./conversation.js";

export const ANSWER_REPORT_NOTE_MAX_CODE_POINTS = 1_000;
export const ANSWER_REPORT_STATE_MAX_MESSAGE_IDS = CONVERSATION_MESSAGE_PAGE_SIZE;
export const ADMIN_ANSWER_REPORT_PAGE_SIZE = 50;

function hasUnsupportedControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint !== undefined &&
      ((codePoint <= 0x1f && codePoint !== 0x09 && codePoint !== 0x0a) ||
        (codePoint >= 0x7f && codePoint <= 0x9f))
    ) {
      return true;
    }
  }
  return false;
}

function noteIsValid(value: string): boolean {
  if (!value.isWellFormed()) {
    return true;
  }
  const normalized = value.normalize("NFC").replace(/\r\n?/gu, "\n").trim();
  return normalized.length > 0 && !hasUnsupportedControlCharacter(normalized);
}

function noteFitsLimit(value: string): boolean {
  if (!value.isWellFormed()) {
    return true;
  }
  const normalized = value.normalize("NFC").replace(/\r\n?/gu, "\n").trim();
  return [...normalized].length <= ANSWER_REPORT_NOTE_MAX_CODE_POINTS;
}

function isValidUnicode(value: string): boolean {
  return value.isWellFormed();
}

export const AnswerReportReasonSchema = Type.Union([
  Type.Literal("incorrect"),
  Type.Literal("outdated"),
  Type.Literal("incomplete"),
  Type.Literal("instructions_not_followed"),
  Type.Literal("unsafe"),
  Type.Literal("other"),
]);
export type AnswerReportReason = Type.Static<typeof AnswerReportReasonSchema>;

export const AnswerReportIdSchema = Type.String({ format: "uuid" });
export type AnswerReportId = Type.Static<typeof AnswerReportIdSchema>;

export const AnswerReportNoteSchema = Type.Refine(
  Type.Refine(
    Type.Refine(
      Type.String({ minLength: 1, maxLength: ANSWER_REPORT_NOTE_MAX_CODE_POINTS * 8 }),
      isValidUnicode,
    ),
    noteIsValid,
  ),
  noteFitsLimit,
);
export type AnswerReportNote = Type.Static<typeof AnswerReportNoteSchema>;

export const AnswerReportParamsSchema = Type.Object(
  {
    conversationId: ConversationIdSchema,
    messageId: MessageIdSchema,
  },
  { additionalProperties: false },
);
export type AnswerReportParams = Type.Static<typeof AnswerReportParamsSchema>;

export const CreateAnswerReportRequestSchema = Type.Object(
  {
    reason: AnswerReportReasonSchema,
    note: Type.Optional(AnswerReportNoteSchema),
    sharePromptAndAnswer: Type.Literal(true),
  },
  { additionalProperties: false },
);
export type CreateAnswerReportRequest = Type.Static<typeof CreateAnswerReportRequestSchema>;

export const CreateAnswerReportResponseSchema = Type.Object(
  {
    id: AnswerReportIdSchema,
    messageId: MessageIdSchema,
    createdAt: Type.String({ format: "date-time" }),
    repeated: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type CreateAnswerReportResponse = Type.Static<typeof CreateAnswerReportResponseSchema>;

export const AnswerReportStateRequestSchema = Type.Object(
  {
    messageIds: Type.Array(MessageIdSchema, {
      minItems: 1,
      maxItems: ANSWER_REPORT_STATE_MAX_MESSAGE_IDS,
      uniqueItems: true,
    }),
  },
  { additionalProperties: false },
);
export type AnswerReportStateRequest = Type.Static<typeof AnswerReportStateRequestSchema>;

export const AnswerReportStateResponseSchema = Type.Object(
  {
    conversationId: ConversationIdSchema,
    reportedMessageIds: Type.Array(MessageIdSchema, {
      maxItems: ANSWER_REPORT_STATE_MAX_MESSAGE_IDS,
      uniqueItems: true,
    }),
  },
  { additionalProperties: false },
);
export type AnswerReportStateResponse = Type.Static<typeof AnswerReportStateResponseSchema>;

const ReporterSchema = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 255 }),
    email: Type.String({ format: "email", maxLength: 320 }),
  },
  { additionalProperties: false },
);

export const AdminAnswerReportListQuerySchema = Type.Object(
  { cursor: Type.Optional(OpaqueCursorSchema) },
  { additionalProperties: false },
);
export type AdminAnswerReportListQuery = Type.Static<typeof AdminAnswerReportListQuerySchema>;

export const AdminAnswerReportParamsSchema = Type.Object(
  { reportId: AnswerReportIdSchema },
  { additionalProperties: false },
);
export type AdminAnswerReportParams = Type.Static<typeof AdminAnswerReportParamsSchema>;

// Deliberately excludes conversation, message, generation, title, and model identity.
export const AdminAnswerReportSchema = Type.Object(
  {
    id: AnswerReportIdSchema,
    reporter: ReporterSchema,
    reason: AnswerReportReasonSchema,
    note: Type.Union([AnswerReportNoteSchema, Type.Null()]),
    createdAt: Type.String({ format: "date-time" }),
  },
  { additionalProperties: false },
);
export type AdminAnswerReport = Type.Static<typeof AdminAnswerReportSchema>;

export const AdminAnswerReportListResponseSchema = Type.Object(
  {
    items: Type.Array(AdminAnswerReportSchema, { maxItems: ADMIN_ANSWER_REPORT_PAGE_SIZE }),
    nextCursor: Type.Union([OpaqueCursorSchema, Type.Null()]),
  },
  { additionalProperties: false },
);
export type AdminAnswerReportListResponse = Type.Static<typeof AdminAnswerReportListResponseSchema>;

export const AdminAnswerReportExchangeSchema = Type.Object(
  {
    prompt: Type.Refine(Type.String({ minLength: 1 }), isValidUnicode),
    answer: Type.Refine(Type.String({ minLength: 1 }), isValidUnicode),
  },
  { additionalProperties: false },
);
export type AdminAnswerReportExchange = Type.Static<typeof AdminAnswerReportExchangeSchema>;

export const AdminAnswerReportDetailSchema = Type.Object(
  {
    ...AdminAnswerReportSchema.properties,
    exchange: AdminAnswerReportExchangeSchema,
  },
  { additionalProperties: false },
);
export type AdminAnswerReportDetail = Type.Static<typeof AdminAnswerReportDetailSchema>;

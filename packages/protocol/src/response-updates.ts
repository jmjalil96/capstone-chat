import Type from "typebox";
import {
  ConversationIdSchema,
  ConversationRevisionSchema,
  OpaqueCursorSchema,
} from "./conversation.js";
import { GenerationIdSchema } from "./generation.js";
import { ResponseStateSchema } from "./response-state.js";

export const RESPONSE_UPDATES_MAX_TEXT_UTF8_BYTES = 1_048_576;

function utf8Length(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
  }
  return bytes;
}

function isValidUnicode(value: string): boolean {
  return value.isWellFormed() && utf8Length(value) <= RESPONSE_UPDATES_MAX_TEXT_UTF8_BYTES;
}

export const ResponseUpdatesParamsSchema = Type.Object(
  {
    conversationId: ConversationIdSchema,
    generationId: GenerationIdSchema,
  },
  { additionalProperties: false },
);
export type ResponseUpdatesParams = Type.Static<typeof ResponseUpdatesParamsSchema>;

export const ResponseUpdatesRequestSchema = Type.Object(
  {
    cursor: Type.Union([OpaqueCursorSchema, Type.Null()]),
  },
  { additionalProperties: false },
);
export type ResponseUpdatesRequest = Type.Static<typeof ResponseUpdatesRequestSchema>;

export const ResponseUpdatesPhaseSchema = Type.Union([
  Type.Literal("responding"),
  Type.Literal("naming"),
]);
export type ResponseUpdatesPhase = Type.Static<typeof ResponseUpdatesPhaseSchema>;

const durableText = Type.Refine(Type.String(), isValidUnicode);

export const ResponseUpdatesContentSchema = Type.Union([
  Type.Object(
    { mode: Type.Literal("replace"), text: durableText },
    { additionalProperties: false },
  ),
  Type.Object({ mode: Type.Literal("append"), text: durableText }, { additionalProperties: false }),
]);
export type ResponseUpdatesContent = Type.Static<typeof ResponseUpdatesContentSchema>;

export const ResponseUpdatesResponseSchema = Type.Object(
  {
    conversationId: ConversationIdSchema,
    revision: ConversationRevisionSchema,
    phase: ResponseUpdatesPhaseSchema,
    response: ResponseStateSchema,
    content: ResponseUpdatesContentSchema,
    nextCursor: Type.Union([OpaqueCursorSchema, Type.Null()]),
  },
  { additionalProperties: false },
);
export type ResponseUpdatesResponse = Type.Static<typeof ResponseUpdatesResponseSchema>;

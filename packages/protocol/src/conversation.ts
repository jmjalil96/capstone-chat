import Type from "typebox";

export const CONVERSATION_PAGE_SIZE = 20;
export const CONVERSATION_MESSAGE_PAGE_SIZE = 40;
export const CONVERSATION_SEARCH_PAGE_SIZE = 20;
export const CONVERSATION_TITLE_MAX_CODE_POINTS = 120;
export const CONVERSATION_SEARCH_QUERY_MAX_UTF8_BYTES = 256;
export const CONVERSATION_SEARCH_SNIPPET_MAX_CODE_POINTS = 162;
export const CONVERSATION_DRAFT_MAX_UTF8_BYTES = 32_768;
export const CONVERSATION_REVISION_MAX = 2_147_483_647;

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

function utf8Length(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
  }
  return bytes;
}

function isValidUnicode(value: string): boolean {
  return value.isWellFormed();
}

function titleFitsLimit(value: string): boolean {
  if (!value.isWellFormed()) {
    return true;
  }
  const normalized = value.normalize("NFC").replace(/\s+/gu, " ").trim();
  return [...normalized].length <= CONVERSATION_TITLE_MAX_CODE_POINTS;
}

function titleInputIsValid(value: string): boolean {
  if (!value.isWellFormed()) {
    return true;
  }
  const normalized = value.normalize("NFC").replace(/\s+/gu, " ").trim();
  return normalized.length > 0 && !hasUnsupportedControlCharacter(normalized);
}

function draftContentIsValid(value: string): boolean {
  return !value.isWellFormed() || !hasUnsupportedControlCharacter(value.replace(/\r\n?/gu, "\n"));
}

function draftFitsLimit(value: string): boolean {
  if (!value.isWellFormed()) {
    return true;
  }
  const normalized = value.replace(/\r\n?/gu, "\n");
  return (
    hasUnsupportedControlCharacter(normalized) ||
    utf8Length(normalized) <= CONVERSATION_DRAFT_MAX_UTF8_BYTES
  );
}

function normalizeSearchInput(value: string): string {
  return value.normalize("NFC").toLocaleLowerCase("und").replace(/\s+/gu, " ").trim();
}

function searchInputIsValid(value: string): boolean {
  if (!value.isWellFormed()) {
    return true;
  }
  const normalized = normalizeSearchInput(value);
  return normalized.length > 0 && !hasUnsupportedControlCharacter(normalized);
}

function searchFitsLimit(value: string): boolean {
  if (!value.isWellFormed()) {
    return true;
  }
  const normalized = normalizeSearchInput(value);
  return (
    normalized.length === 0 ||
    hasUnsupportedControlCharacter(normalized) ||
    utf8Length(normalized) <= CONVERSATION_SEARCH_QUERY_MAX_UTF8_BYTES
  );
}

function codePointLengthFits(value: string, maximum: number): boolean {
  return !value.isWellFormed() || [...value].length <= maximum;
}

export const ConversationIdSchema = Type.String({ format: "uuid" });
export type ConversationId = Type.Static<typeof ConversationIdSchema>;

export const MessageIdSchema = Type.String({ format: "uuid" });
export type MessageId = Type.Static<typeof MessageIdSchema>;

export const OpaqueCursorSchema = Type.String({
  minLength: 1,
  maxLength: 2_048,
  pattern: "^[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$",
});
export type OpaqueCursor = Type.Static<typeof OpaqueCursorSchema>;

export const ConversationRevisionSchema = Type.Integer({
  minimum: 0,
  maximum: CONVERSATION_REVISION_MAX,
});
export type ConversationRevision = Type.Static<typeof ConversationRevisionSchema>;

export const ConversationTitleSchema = Type.Refine(
  Type.Refine(
    Type.Refine(
      Type.String({
        minLength: 1,
        pattern: "^(?=.*\\S)[^\\r\\n\\u0085\\u2028\\u2029]*$",
      }),
      isValidUnicode,
    ),
    titleInputIsValid,
  ),
  titleFitsLimit,
);
export type ConversationTitle = Type.Static<typeof ConversationTitleSchema>;

export const TextContentBlockSchema = Type.Object(
  {
    type: Type.Literal("text"),
    text: Type.String(),
  },
  { additionalProperties: false },
);
export type TextContentBlock = Type.Static<typeof TextContentBlockSchema>;

export const MessageContentSchema = Type.Array(TextContentBlockSchema, {
  minItems: 1,
  maxItems: 1,
});
export type MessageContent = Type.Static<typeof MessageContentSchema>;

export const ConversationSummarySchema = Type.Object(
  {
    id: ConversationIdSchema,
    title: Type.Union([ConversationTitleSchema, Type.Null()]),
    isArchived: Type.Boolean(),
    revision: ConversationRevisionSchema,
    createdAt: Type.String({ format: "date-time" }),
    updatedAt: Type.String({ format: "date-time" }),
  },
  { additionalProperties: false },
);
export type ConversationSummary = Type.Static<typeof ConversationSummarySchema>;

export const ConversationMessageSchema = Type.Object(
  {
    id: MessageIdSchema,
    parentMessageId: Type.Union([MessageIdSchema, Type.Null()]),
    role: Type.Union([Type.Literal("user"), Type.Literal("assistant")]),
    content: MessageContentSchema,
    createdAt: Type.String({ format: "date-time" }),
    siblingCount: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);
export type ConversationMessage = Type.Static<typeof ConversationMessageSchema>;

export const ConversationViewSchema = Type.Union([
  Type.Literal("active"),
  Type.Literal("archived"),
]);
export type ConversationView = Type.Static<typeof ConversationViewSchema>;

export const ConversationListQuerySchema = Type.Object(
  {
    view: ConversationViewSchema,
    cursor: Type.Optional(OpaqueCursorSchema),
  },
  { additionalProperties: false },
);
export type ConversationListQuery = Type.Static<typeof ConversationListQuerySchema>;

export const ConversationListResponseSchema = Type.Object(
  {
    conversations: Type.Array(ConversationSummarySchema, {
      maxItems: CONVERSATION_PAGE_SIZE,
    }),
    nextCursor: Type.Union([OpaqueCursorSchema, Type.Null()]),
  },
  { additionalProperties: false },
);
export type ConversationListResponse = Type.Static<typeof ConversationListResponseSchema>;

export const CreateConversationRequestSchema = Type.Object({}, { additionalProperties: false });
export type CreateConversationRequest = Type.Static<typeof CreateConversationRequestSchema>;

export const CreateConversationResponseSchema = ConversationSummarySchema;
export type CreateConversationResponse = Type.Static<typeof CreateConversationResponseSchema>;

export const ConversationParamsSchema = Type.Object(
  {
    conversationId: ConversationIdSchema,
  },
  { additionalProperties: false },
);
export type ConversationParams = Type.Static<typeof ConversationParamsSchema>;

export const ConversationDetailQuerySchema = Type.Object(
  {
    cursor: Type.Optional(OpaqueCursorSchema),
  },
  { additionalProperties: false },
);
export type ConversationDetailQuery = Type.Static<typeof ConversationDetailQuerySchema>;

export const ConversationDetailResponseSchema = Type.Object(
  {
    conversation: ConversationSummarySchema,
    selectedLeafId: Type.Union([MessageIdSchema, Type.Null()]),
    messages: Type.Array(ConversationMessageSchema, {
      maxItems: CONVERSATION_MESSAGE_PAGE_SIZE,
    }),
    nextCursor: Type.Union([OpaqueCursorSchema, Type.Null()]),
  },
  { additionalProperties: false },
);
export type ConversationDetailResponse = Type.Static<typeof ConversationDetailResponseSchema>;

export const RenameConversationRequestSchema = Type.Object(
  {
    title: ConversationTitleSchema,
    observedRevision: ConversationRevisionSchema,
  },
  { additionalProperties: false },
);
export type RenameConversationRequest = Type.Static<typeof RenameConversationRequestSchema>;

export const SelectConversationLeafRequestSchema = Type.Object(
  {
    leafMessageId: MessageIdSchema,
    observedRevision: ConversationRevisionSchema,
  },
  { additionalProperties: false },
);
export type SelectConversationLeafRequest = Type.Static<typeof SelectConversationLeafRequestSchema>;

export const ConversationSelectionResponseSchema = Type.Object(
  {
    conversation: ConversationSummarySchema,
    selectedLeafId: MessageIdSchema,
  },
  { additionalProperties: false },
);
export type ConversationSelectionResponse = Type.Static<typeof ConversationSelectionResponseSchema>;

export const ConversationRevisionRequestSchema = Type.Object(
  {
    observedRevision: ConversationRevisionSchema,
  },
  { additionalProperties: false },
);
export type ConversationRevisionRequest = Type.Static<typeof ConversationRevisionRequestSchema>;

export const ArchiveConversationRequestSchema = ConversationRevisionRequestSchema;
export type ArchiveConversationRequest = Type.Static<typeof ArchiveConversationRequestSchema>;

export const UnarchiveConversationRequestSchema = ConversationRevisionRequestSchema;
export type UnarchiveConversationRequest = Type.Static<typeof UnarchiveConversationRequestSchema>;

export const DeleteConversationRequestSchema = ConversationRevisionRequestSchema;
export type DeleteConversationRequest = Type.Static<typeof DeleteConversationRequestSchema>;

export const DeleteConversationResponseSchema = Type.Null();
export type DeleteConversationResponse = Type.Static<typeof DeleteConversationResponseSchema>;

export const ConversationMutationResponseSchema = ConversationSummarySchema;
export type ConversationMutationResponse = Type.Static<typeof ConversationMutationResponseSchema>;

export const RenameConversationResponseSchema = ConversationMutationResponseSchema;
export type RenameConversationResponse = Type.Static<typeof RenameConversationResponseSchema>;

export const ArchiveConversationResponseSchema = ConversationMutationResponseSchema;
export type ArchiveConversationResponse = Type.Static<typeof ArchiveConversationResponseSchema>;

export const UnarchiveConversationResponseSchema = ConversationMutationResponseSchema;
export type UnarchiveConversationResponse = Type.Static<typeof UnarchiveConversationResponseSchema>;

export const NewDraftScopeSchema = Type.Object(
  {
    kind: Type.Literal("new"),
  },
  { additionalProperties: false },
);
export type NewDraftScope = Type.Static<typeof NewDraftScopeSchema>;

export const ConversationDraftScopeSchema = Type.Object(
  {
    kind: Type.Literal("conversation"),
    conversationId: ConversationIdSchema,
  },
  { additionalProperties: false },
);
export type ConversationDraftScope = Type.Static<typeof ConversationDraftScopeSchema>;

export const DraftScopeSchema = Type.Union([NewDraftScopeSchema, ConversationDraftScopeSchema]);
export type DraftScope = Type.Static<typeof DraftScopeSchema>;

const DraftContentSchema = Type.Refine(
  Type.Refine(Type.Refine(Type.String(), isValidUnicode), draftContentIsValid),
  draftFitsLimit,
  () => "PAYLOAD_TOO_LARGE",
);

export const DraftStateSchema = Type.Object(
  {
    scope: DraftScopeSchema,
    content: DraftContentSchema,
    revision: ConversationRevisionSchema,
    updatedAt: Type.Union([Type.String({ format: "date-time" }), Type.Null()]),
  },
  { additionalProperties: false },
);
export type DraftState = Type.Static<typeof DraftStateSchema>;

export const SaveDraftRequestSchema = Type.Object(
  {
    content: DraftContentSchema,
    observedRevision: ConversationRevisionSchema,
  },
  { additionalProperties: false },
);
export type SaveDraftRequest = Type.Static<typeof SaveDraftRequestSchema>;

export const SearchSnippetSegmentSchema = Type.Object(
  {
    text: Type.Refine(Type.Refine(Type.String({ minLength: 1 }), isValidUnicode), (value) =>
      codePointLengthFits(value, CONVERSATION_SEARCH_SNIPPET_MAX_CODE_POINTS),
    ),
    highlighted: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type SearchSnippetSegment = Type.Static<typeof SearchSnippetSegmentSchema>;

export const ConversationSearchRequestSchema = Type.Object(
  {
    query: Type.Refine(
      Type.Refine(Type.Refine(Type.String({ minLength: 1 }), isValidUnicode), searchInputIsValid),
      searchFitsLimit,
      () => "PAYLOAD_TOO_LARGE",
    ),
    cursor: Type.Optional(OpaqueCursorSchema),
  },
  { additionalProperties: false },
);
export type ConversationSearchRequest = Type.Static<typeof ConversationSearchRequestSchema>;

const conversationSearchResultFields = {
  conversation: ConversationSummarySchema,
  leafMessageId: MessageIdSchema,
  snippet: Type.Array(SearchSnippetSegmentSchema, { minItems: 1, maxItems: 3 }),
};

export const ConversationSearchResultSchema = Type.Union([
  Type.Object(
    {
      ...conversationSearchResultFields,
      matchedMessageId: Type.Null(),
      matchKind: Type.Literal("title"),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...conversationSearchResultFields,
      matchedMessageId: MessageIdSchema,
      matchKind: Type.Literal("message"),
    },
    { additionalProperties: false },
  ),
]);
export type ConversationSearchResult = Type.Static<typeof ConversationSearchResultSchema>;

export const ConversationSearchResponseSchema = Type.Object(
  {
    results: Type.Array(ConversationSearchResultSchema, {
      maxItems: CONVERSATION_SEARCH_PAGE_SIZE,
    }),
    nextCursor: Type.Union([OpaqueCursorSchema, Type.Null()]),
  },
  { additionalProperties: false },
);
export type ConversationSearchResponse = Type.Static<typeof ConversationSearchResponseSchema>;

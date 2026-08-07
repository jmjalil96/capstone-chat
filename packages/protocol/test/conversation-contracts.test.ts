import Value from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  API_ERROR_CODES,
  ApiErrorSchema,
  CONVERSATION_DRAFT_MAX_UTF8_BYTES,
  CONVERSATION_MESSAGE_PAGE_SIZE,
  CONVERSATION_PAGE_SIZE,
  CONVERSATION_REVISION_MAX,
  CONVERSATION_SEARCH_PAGE_SIZE,
  CONVERSATION_SEARCH_QUERY_MAX_UTF8_BYTES,
  CONVERSATION_SEARCH_SNIPPET_MAX_CODE_POINTS,
  CONVERSATION_TITLE_MAX_CODE_POINTS,
  ConversationDetailResponseSchema,
  ConversationListQuerySchema,
  ConversationListResponseSchema,
  ConversationSearchRequestSchema,
  ConversationSearchResponseSchema,
  ConversationSummarySchema,
  CreateConversationRequestSchema,
  DraftStateSchema,
  MessageContentSchema,
  OpaqueCursorSchema,
  RenameConversationRequestSchema,
  SaveDraftRequestSchema,
  SelectConversationLeafRequestSchema,
} from "../src/index.js";

const conversationId = "aaedb175-c593-4d66-87d6-636fca2aa4fa";
const messageId = "7c917de8-79f1-4787-a752-71ff2c1f7d96";
const parentMessageId = "ca40adf0-8ee4-4805-bceb-d69a0da23b55";
const cursor = "eyJ2IjoxLCJraW5kIjoiaGlzdG9yeSJ9.c2lnbmF0dXJl";
const createdAt = "2026-08-06T12:00:00.000Z";
const updatedAt = "2026-08-06T12:30:00.000Z";

const conversationSummary = {
  id: conversationId,
  title: "Análisis trimestral",
  isArchived: false,
  revision: 3,
  createdAt,
  updatedAt,
};

const conversationMessage = {
  id: messageId,
  parentMessageId,
  role: "assistant",
  content: [{ type: "text", text: "Aquí está el análisis." }],
  createdAt,
  siblingCount: 2,
};

describe("message content contracts", () => {
  it("accepts exactly one typed text block", () => {
    expect(Value.Check(MessageContentSchema, [{ type: "text", text: "Texto" }])).toBe(true);
  });

  it.each([
    { content: [] },
    {
      content: [
        { type: "text", text: "Uno" },
        { type: "text", text: "Dos" },
      ],
    },
    { content: [{ type: "image", url: "https://example.invalid/image.png" }] },
    { content: [{ type: "text", text: "Texto", html: "<p>Texto</p>" }] },
  ])("rejects content outside the Phase 3 text-block boundary", ({ content }) => {
    expect(Value.Check(MessageContentSchema, content)).toBe(false);
  });
});

describe("conversation summary contracts", () => {
  it.each([
    conversationSummary,
    { ...conversationSummary, title: null, revision: 0 },
    { ...conversationSummary, title: "🙂".repeat(CONVERSATION_TITLE_MAX_CODE_POINTS) },
    { ...conversationSummary, title: "e\u0301".repeat(CONVERSATION_TITLE_MAX_CODE_POINTS) },
  ])("accepts canonical conversation metadata", (summary) => {
    expect(Value.Check(ConversationSummarySchema, summary)).toBe(true);
  });

  it.each([
    { ...conversationSummary, id: "conversation-1" },
    { ...conversationSummary, title: "" },
    { ...conversationSummary, title: " \t\u00a0" },
    { ...conversationSummary, title: "Primera línea\nSegunda línea" },
    { ...conversationSummary, title: "Primera línea\u2028Segunda línea" },
    { ...conversationSummary, title: "🙂".repeat(CONVERSATION_TITLE_MAX_CODE_POINTS + 1) },
    { ...conversationSummary, title: "e\u0301".repeat(CONVERSATION_TITLE_MAX_CODE_POINTS + 1) },
    { ...conversationSummary, title: `Título${String.fromCharCode(0)}` },
    { ...conversationSummary, title: String.fromCharCode(0xd800) },
    { ...conversationSummary, revision: -1 },
    { ...conversationSummary, revision: CONVERSATION_REVISION_MAX + 1 },
    { ...conversationSummary, revision: 1.5 },
    { ...conversationSummary, archivedAt: updatedAt },
    { ...conversationSummary, selectedLeafId: messageId },
  ])("rejects invalid or content-bearing summary metadata", (summary) => {
    expect(Value.Check(ConversationSummarySchema, summary)).toBe(false);
  });
});

describe("opaque pagination contracts", () => {
  it.each([cursor, "a.b", "abc_DEF-123.signature_456"])(
    "accepts a signed payload-and-signature base64url cursor",
    (value) => {
      expect(Value.Check(OpaqueCursorSchema, value)).toBe(true);
    },
  );

  it.each([
    "",
    "unsigned-cursor",
    ".signature",
    "payload.",
    "payload.signature.extra",
    "payload=.=signature",
    "payload signature",
    `${"a".repeat(2_047)}.b`,
  ])("rejects a malformed or unbounded cursor", (value) => {
    expect(Value.Check(OpaqueCursorSchema, value)).toBe(false);
  });

  it.each([{ view: "active" }, { view: "archived", cursor }])(
    "accepts the server-owned conversation-list query",
    (query) => {
      expect(Value.Check(ConversationListQuerySchema, query)).toBe(true);
    },
  );

  it.each([
    {},
    { view: "all" },
    { view: "active", cursor: "not valid" },
    { view: "active", pageSize: 100 },
  ])("rejects unsupported list filters and client-owned page sizes", (query) => {
    expect(Value.Check(ConversationListQuerySchema, query)).toBe(false);
  });

  it("bounds conversation pages and uses a nullable continuation cursor", () => {
    expect(
      Value.Check(ConversationListResponseSchema, {
        conversations: Array.from({ length: CONVERSATION_PAGE_SIZE }, () => conversationSummary),
        nextCursor: cursor,
      }),
    ).toBe(true);
    expect(
      Value.Check(ConversationListResponseSchema, {
        conversations: [],
        nextCursor: null,
      }),
    ).toBe(true);
    expect(
      Value.Check(ConversationListResponseSchema, {
        conversations: Array.from(
          { length: CONVERSATION_PAGE_SIZE + 1 },
          () => conversationSummary,
        ),
        nextCursor: null,
      }),
    ).toBe(false);
  });
});

describe("conversation detail contracts", () => {
  it("accepts a bounded selected-branch page in reading order", () => {
    expect(
      Value.Check(ConversationDetailResponseSchema, {
        conversation: conversationSummary,
        selectedLeafId: messageId,
        messages: [conversationMessage],
        nextCursor: cursor,
      }),
    ).toBe(true);
  });

  it("accepts the canonical empty-conversation detail", () => {
    expect(
      Value.Check(ConversationDetailResponseSchema, {
        conversation: { ...conversationSummary, title: null, revision: 0 },
        selectedLeafId: null,
        messages: [],
        nextCursor: null,
      }),
    ).toBe(true);
  });

  it.each([
    {
      conversation: conversationSummary,
      selectedLeafId: messageId,
      messages: [{ ...conversationMessage, role: "system" }],
      nextCursor: null,
    },
    {
      conversation: conversationSummary,
      selectedLeafId: messageId,
      messages: [{ ...conversationMessage, siblingCount: -1 }],
      nextCursor: null,
    },
    {
      conversation: conversationSummary,
      selectedLeafId: messageId,
      messages: Array.from(
        { length: CONVERSATION_MESSAGE_PAGE_SIZE + 1 },
        () => conversationMessage,
      ),
      nextCursor: null,
    },
    {
      conversation: conversationSummary,
      selectedLeafId: messageId,
      messages: [conversationMessage],
      nextCursor: null,
      completeTree: [],
    },
  ])("rejects invalid or over-broad detail responses", (response) => {
    expect(Value.Check(ConversationDetailResponseSchema, response)).toBe(false);
  });
});

describe("conversation mutation contracts", () => {
  it("accepts optional new-draft adoption without widening conversation creation", () => {
    expect(Value.Check(CreateConversationRequestSchema, {})).toBe(true);
    expect(Value.Check(CreateConversationRequestSchema, { adoptNewDraftRevision: 4 })).toBe(true);
    expect(Value.Check(CreateConversationRequestSchema, { adoptNewDraftRevision: -1 })).toBe(false);
    expect(Value.Check(CreateConversationRequestSchema, { title: "Título" })).toBe(false);
  });

  it("accepts normalized revision-bearing rename and selection requests", () => {
    expect(
      Value.Check(RenameConversationRequestSchema, {
        title: "Nuevo título",
        observedRevision: 4,
      }),
    ).toBe(true);
    expect(
      Value.Check(SelectConversationLeafRequestSchema, {
        leafMessageId: messageId,
        observedRevision: 4,
      }),
    ).toBe(true);
  });

  it.each([
    { title: "", observedRevision: 4 },
    { title: "Título\r\nsecundario", observedRevision: 4 },
    { title: "Título", observedRevision: -1 },
    { title: "Título", observedRevision: CONVERSATION_REVISION_MAX + 1 },
    { title: "Título", observedRevision: 4, force: true },
  ])("rejects invalid rename requests and revision bypasses", (request) => {
    expect(Value.Check(RenameConversationRequestSchema, request)).toBe(false);
  });

  it.each([
    { leafMessageId: "message-1", observedRevision: 4 },
    { leafMessageId: messageId, observedRevision: -1 },
    { leafMessageId: messageId, observedRevision: 4, conversationId },
  ])("rejects invalid selection requests and scope widening", (request) => {
    expect(Value.Check(SelectConversationLeafRequestSchema, request)).toBe(false);
  });
});

describe("draft contracts", () => {
  it.each([
    {
      scope: { kind: "new" },
      content: "",
      revision: 0,
      updatedAt: null,
    },
    {
      scope: { kind: "conversation", conversationId },
      content: "Texto con\n saltos y espacios ",
      revision: 2,
      updatedAt,
    },
  ])("accepts canonical new-chat and conversation draft states", (draft) => {
    expect(Value.Check(DraftStateSchema, draft)).toBe(true);
  });

  it.each([
    {
      scope: { kind: "new", conversationId },
      content: "Texto",
      revision: 1,
      updatedAt,
    },
    {
      scope: { kind: "conversation", conversationId: "conversation-1" },
      content: "Texto",
      revision: 1,
      updatedAt,
    },
    {
      scope: { kind: "new" },
      content: "Texto",
      revision: 0,
      updatedAt: "hoy",
    },
  ])("rejects invalid draft state or scope", (draft) => {
    expect(Value.Check(DraftStateSchema, draft)).toBe(false);
  });

  it("bounds CAS draft writes while allowing empty content", () => {
    expect(
      Value.Check(SaveDraftRequestSchema, {
        content: "",
        observedRevision: 0,
      }),
    ).toBe(true);
    expect(
      Value.Check(SaveDraftRequestSchema, {
        content: "🙂".repeat(CONVERSATION_DRAFT_MAX_UTF8_BYTES / 4),
        observedRevision: 0,
      }),
    ).toBe(true);
    expect(
      Value.Check(SaveDraftRequestSchema, {
        content: "🙂".repeat(CONVERSATION_DRAFT_MAX_UTF8_BYTES / 4 + 1),
        observedRevision: 0,
      }),
    ).toBe(false);
    expect(
      Value.Check(SaveDraftRequestSchema, {
        content: "\r\n".repeat(CONVERSATION_DRAFT_MAX_UTF8_BYTES / 2),
        observedRevision: 0,
      }),
    ).toBe(true);
    expect(
      Value.Check(SaveDraftRequestSchema, {
        content: String.fromCharCode(0),
        observedRevision: 0,
      }),
    ).toBe(false);
    expect(
      Value.Check(SaveDraftRequestSchema, {
        content: String.fromCharCode(0xd800),
        observedRevision: 0,
      }),
    ).toBe(false);
    expect(
      Value.Check(SaveDraftRequestSchema, {
        content: "Texto",
        observedRevision: 1,
        overwrite: true,
      }),
    ).toBe(false);
  });
});

describe("conversation search contracts", () => {
  const snippet = [
    { text: "Análisis ", highlighted: false },
    { text: "trimestral", highlighted: true },
  ];

  it("keeps the bounded query in the JSON request body", () => {
    expect(Value.Check(ConversationSearchRequestSchema, { query: "análisis" })).toBe(true);
    expect(
      Value.Check(ConversationSearchRequestSchema, {
        query: "análisis",
        cursor,
      }),
    ).toBe(true);
    expect(Value.Check(ConversationSearchRequestSchema, { query: "" })).toBe(false);
    expect(Value.Check(ConversationSearchRequestSchema, { query: " \t " })).toBe(false);
    expect(
      Value.Check(ConversationSearchRequestSchema, {
        query: "ñ".repeat(CONVERSATION_SEARCH_QUERY_MAX_UTF8_BYTES / 2),
      }),
    ).toBe(true);
    expect(
      Value.Check(ConversationSearchRequestSchema, {
        query: "ñ".repeat(CONVERSATION_SEARCH_QUERY_MAX_UTF8_BYTES / 2 + 1),
      }),
    ).toBe(false);
    expect(
      Value.Check(ConversationSearchRequestSchema, {
        query: `${" ".repeat(CONVERSATION_SEARCH_QUERY_MAX_UTF8_BYTES + 1)}a`,
      }),
    ).toBe(true);
    expect(Value.Check(ConversationSearchRequestSchema, { query: String.fromCharCode(0) })).toBe(
      false,
    );
    expect(
      Value.Check(ConversationSearchRequestSchema, { query: String.fromCharCode(0xd800) }),
    ).toBe(false);
    expect(Value.Check(ConversationSearchRequestSchema, { query: "análisis", pageSize: 100 })).toBe(
      false,
    );
  });

  it("accepts typed title and message matches with plain-text segments", () => {
    expect(
      Value.Check(ConversationSearchResponseSchema, {
        results: [
          {
            conversation: conversationSummary,
            leafMessageId: messageId,
            matchedMessageId: null,
            matchKind: "title",
            snippet,
          },
          {
            conversation: { ...conversationSummary, isArchived: true },
            leafMessageId: messageId,
            matchedMessageId: parentMessageId,
            matchKind: "message",
            snippet,
          },
        ],
        nextCursor: cursor,
      }),
    ).toBe(true);
  });

  it.each([
    {
      conversation: conversationSummary,
      leafMessageId: messageId,
      matchedMessageId: messageId,
      matchKind: "title",
      snippet: [{ text: "Título", highlighted: true }],
    },
    {
      conversation: conversationSummary,
      leafMessageId: messageId,
      matchedMessageId: null,
      matchKind: "message",
      snippet: [{ text: "Mensaje", highlighted: true }],
    },
    {
      conversation: conversationSummary,
      leafMessageId: messageId,
      matchedMessageId: null,
      matchKind: "title",
      snippet: [],
    },
    {
      conversation: conversationSummary,
      leafMessageId: messageId,
      matchedMessageId: null,
      matchKind: "title",
      snippet: [
        { text: "Uno", highlighted: false },
        { text: "Dos", highlighted: true },
        { text: "Tres", highlighted: false },
        { text: "Cuatro", highlighted: true },
      ],
    },
    {
      conversation: conversationSummary,
      leafMessageId: messageId,
      matchedMessageId: null,
      matchKind: "title",
      snippet: [
        {
          text: "x".repeat(CONVERSATION_SEARCH_SNIPPET_MAX_CODE_POINTS + 1),
          highlighted: false,
        },
      ],
    },
    {
      conversation: conversationSummary,
      leafMessageId: messageId,
      matchedMessageId: null,
      matchKind: "title",
      snippet: [
        {
          text: "e\u0301".repeat(CONVERSATION_SEARCH_SNIPPET_MAX_CODE_POINTS / 2 + 1),
          highlighted: false,
        },
      ],
    },
  ])("rejects inconsistent or empty search matches", (result) => {
    expect(
      Value.Check(ConversationSearchResponseSchema, {
        results: [result],
        nextCursor: null,
      }),
    ).toBe(false);
  });

  it("bounds search result pages", () => {
    const result = {
      conversation: conversationSummary,
      leafMessageId: messageId,
      matchedMessageId: null,
      matchKind: "title",
      snippet: [{ text: "Título", highlighted: true }],
    };

    expect(
      Value.Check(ConversationSearchResponseSchema, {
        results: Array.from({ length: CONVERSATION_SEARCH_PAGE_SIZE + 1 }, () => result),
        nextCursor: null,
      }),
    ).toBe(false);
  });
});

describe("stable API error codes", () => {
  it("centralizes implemented foundation, identity, and conversation codes", () => {
    expect(API_ERROR_CODES).toMatchObject({
      BAD_REQUEST: "BAD_REQUEST",
      NOT_FOUND: "NOT_FOUND",
      AUTHENTICATION_REQUIRED: "AUTHENTICATION_REQUIRED",
      WORKSPACE_ACCESS_DENIED: "WORKSPACE_ACCESS_DENIED",
      CONVERSATION_CHANGED: "CONVERSATION_CHANGED",
      DRAFT_CHANGED: "DRAFT_CHANGED",
      INVALID_CURSOR: "INVALID_CURSOR",
      PAYLOAD_TOO_LARGE: "PAYLOAD_TOO_LARGE",
    });
  });

  it("closes the ordinary envelope over the approved v1 catalog", () => {
    expect(
      Value.Check(ApiErrorSchema, {
        code: "A_FUTURE_STABLE_CODE",
        message: "Mensaje seguro.",
        requestId: "request-123",
      }),
    ).toBe(false);
  });
});

import Value from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  API_ERROR_CODES,
  ApiErrorSchema,
  CancelGenerationParamsSchema,
  CancelGenerationRequestSchema,
  CancelGenerationResponseSchema,
  CONVERSATION_MESSAGE_PAGE_SIZE,
  ContentDeltaEventSchema,
  CreateEditResponseRequestSchema,
  CreateResponseRequestHeadersSchema,
  CreateResponseRequestSchema,
  CreateRetryResponseRequestSchema,
  GenerationModelTierSchema,
  GenerationUsageSchema,
  ResponseStateRequestSchema,
  ResponseStateResponseSchema,
  StreamEventSchema,
  USER_MESSAGE_MAX_UTF8_BYTES,
} from "../src/index.js";

const conversationId = "aaedb175-c593-4d66-87d6-636fca2aa4fa";
const generationId = "f8741fd0-6cf9-4da1-b08a-d69efb33dc4f";
const userMessageId = "7c917de8-79f1-4787-a752-71ff2c1f7d96";
const assistantMessageId = "ca40adf0-8ee4-4805-bceb-d69a0da23b55";
const idempotencyKey = "7ef3eaf2-765d-43db-9590-e234b7d0ea8d";

const expectedErrorCodes = [
  "ADMIN_ACCESS_REQUIRED",
  "AUTHENTICATION_REQUIRED",
  "BAD_REQUEST",
  "CATALOG_REFRESH_ACTIVE",
  "CONTEXT_COMPACTION_FALLBACK",
  "CONVERSATION_ARCHIVED",
  "CONVERSATION_CHANGED",
  "DEVELOPMENT_MAILBOX_DENIED",
  "DRAFT_CHANGED",
  "EMPTY_RESPONSE",
  "EMPLOYEE_APPROVAL_CONFLICT",
  "EMPLOYEE_DEACTIVATION_INCOMPLETE",
  "EMPLOYEE_GENERATION_LIMIT_REACHED",
  "GENERATION_ACTIVE",
  "GENERATION_ALREADY_EXISTS",
  "GENERATION_FAILED",
  "GENERATION_TIMEOUT",
  "IDEMPOTENCY_KEY_INVALID",
  "IDEMPOTENCY_KEY_REQUIRED",
  "INTERNAL_ERROR",
  "INVALID_CURSOR",
  "INVALID_EMAIL_OR_PASSWORD",
  "INVITATION_DELIVERY_FAILED",
  "JSON_REQUIRED",
  "MEMBERSHIP_ACTIVATION_FAILED",
  "MESSAGE_TOO_LARGE",
  "MODEL_POLICY_CHANGED",
  "MODEL_POLICY_CONFLICT",
  "MODEL_UNAVAILABLE",
  "MODEL_VALIDATION_FAILED",
  "NAME_REQUIRED",
  "NOT_FOUND",
  "ORIGIN_NOT_ALLOWED",
  "PASSWORD_TOO_LONG",
  "PASSWORD_TOO_SHORT",
  "PAYLOAD_TOO_LARGE",
  "SESSION_REFRESH_REQUIRED",
  "SESSION_REVOCATION_FAILED",
  "STREAM_INTERRUPTED",
  "STREAM_PROTOCOL_ERROR",
  "TIER_UNAVAILABLE",
  "WORKSPACE_ACCESS_DENIED",
  "WORKSPACE_BUDGET_EXCEEDED",
] as const;

describe("complete stable error catalog", () => {
  it("contains exactly the approved v1 codes and validates each one", () => {
    expect(Object.values(API_ERROR_CODES).sort()).toEqual([...expectedErrorCodes].sort());
    for (const code of expectedErrorCodes) {
      expect(
        Value.Check(ApiErrorSchema, {
          code,
          message: "Mensaje seguro.",
          requestId: "request-123",
        }),
      ).toBe(true);
    }
  });

  it("rejects undeclared error codes", () => {
    expect(
      Value.Check(ApiErrorSchema, {
        code: "PROVIDER_RAW_ERROR",
        message: "Mensaje seguro.",
        requestId: "request-123",
      }),
    ).toBe(false);
  });
});

describe("generation request contracts", () => {
  it.each(["fast", "balanced", "pro"])("accepts the approved %s tier", (modelTier) => {
    expect(Value.Check(GenerationModelTierSchema, modelTier)).toBe(true);
    expect(
      Value.Check(CreateResponseRequestSchema, {
        source: "continue",
        parentMessageId: assistantMessageId,
        modelTier,
        observedRevision: 9,
      }),
    ).toBe(true);
  });

  it.each(["deepseek/deepseek-v4-pro", "premium", "FAST", ""])(
    "rejects a raw or unsupported tier value: %s",
    (modelTier) => {
      expect(Value.Check(GenerationModelTierSchema, modelTier)).toBe(false);
    },
  );

  it("accepts one bounded normalized text block for draft sends", () => {
    expect(
      Value.Check(CreateResponseRequestSchema, {
        source: "draft",
        parentMessageId: null,
        content: [{ type: "text", text: "Primera línea\r\nSegunda línea" }],
        modelTier: "balanced",
        observedRevision: 0,
        draftRevision: 3,
      }),
    ).toBe(true);
    expect(
      Value.Check(CreateResponseRequestSchema, {
        source: "draft",
        parentMessageId: assistantMessageId,
        content: [{ type: "text", text: "🙂".repeat(USER_MESSAGE_MAX_UTF8_BYTES / 4) }],
        modelTier: "balanced",
        observedRevision: 7,
        draftRevision: 3,
      }),
    ).toBe(true);
  });

  it.each([
    "",
    " \n\t ",
    String.fromCharCode(0),
    String.fromCharCode(0xd800),
    "🙂".repeat(USER_MESSAGE_MAX_UTF8_BYTES / 4 + 1),
  ])("rejects invalid draft-send text", (text) => {
    expect(
      Value.Check(CreateResponseRequestSchema, {
        source: "draft",
        parentMessageId: assistantMessageId,
        content: [{ type: "text", text }],
        modelTier: "balanced",
        observedRevision: 7,
        draftRevision: 3,
      }),
    ).toBe(false);
  });

  it("accepts Continue without browser-owned content or a draft revision", () => {
    expect(
      Value.Check(CreateResponseRequestSchema, {
        source: "continue",
        parentMessageId: assistantMessageId,
        modelTier: "balanced",
        observedRevision: 9,
      }),
    ).toBe(true);
  });

  it("accepts edit with one bounded text block and an observed branch anchor", () => {
    const request = {
      source: "edit",
      targetMessageId: userMessageId,
      parentMessageId: null,
      content: [{ type: "text", text: "Texto editado\r\ncon contexto" }],
      modelTier: "balanced",
      observedRevision: 9,
    };
    expect(Value.Check(CreateEditResponseRequestSchema, request)).toBe(true);
    expect(Value.Check(CreateResponseRequestSchema, request)).toBe(true);
    expect(
      Value.Check(CreateEditResponseRequestSchema, {
        ...request,
        parentMessageId: assistantMessageId,
      }),
    ).toBe(true);
  });

  it.each([
    "",
    " \n\t ",
    String.fromCharCode(0),
    String.fromCharCode(0xd800),
    "🙂".repeat(USER_MESSAGE_MAX_UTF8_BYTES / 4 + 1),
  ])("rejects invalid edit text", (text) => {
    expect(
      Value.Check(CreateEditResponseRequestSchema, {
        source: "edit",
        targetMessageId: userMessageId,
        parentMessageId: null,
        content: [{ type: "text", text }],
        modelTier: "balanced",
        observedRevision: 9,
      }),
    ).toBe(false);
  });

  it("rejects malformed edit and retry identifiers", () => {
    expect(
      Value.Check(CreateEditResponseRequestSchema, {
        source: "edit",
        targetMessageId: "user-message",
        parentMessageId: null,
        content: [{ type: "text", text: "Texto editado" }],
        modelTier: "balanced",
        observedRevision: 9,
      }),
    ).toBe(false);
    expect(
      Value.Check(CreateRetryResponseRequestSchema, {
        source: "retry",
        targetMessageId: assistantMessageId,
        parentMessageId: "user-message",
        modelTier: "balanced",
        observedRevision: 9,
      }),
    ).toBe(false);
  });

  it("accepts retry without browser-owned message content", () => {
    const request = {
      source: "retry",
      targetMessageId: assistantMessageId,
      parentMessageId: userMessageId,
      modelTier: "balanced",
      observedRevision: 9,
    };
    expect(Value.Check(CreateRetryResponseRequestSchema, request)).toBe(true);
    expect(Value.Check(CreateResponseRequestSchema, request)).toBe(true);
  });

  it.each([
    {
      source: "continue",
      parentMessageId: null,
      modelTier: "balanced",
      observedRevision: 9,
    },
    {
      source: "continue",
      parentMessageId: assistantMessageId,
      content: [{ type: "text", text: "Browser copy" }],
      modelTier: "balanced",
      observedRevision: 9,
    },
    {
      source: "edit",
      targetMessageId: userMessageId,
      parentMessageId: null,
      content: [{ type: "text", text: "Texto" }],
      modelTier: "balanced",
      observedRevision: 9,
      draftRevision: 3,
    },
    {
      source: "retry",
      targetMessageId: assistantMessageId,
      parentMessageId: null,
      modelTier: "balanced",
      observedRevision: 9,
    },
    {
      source: "retry",
      targetMessageId: assistantMessageId,
      parentMessageId: userMessageId,
      content: [{ type: "text", text: "Browser copy" }],
      modelTier: "balanced",
      observedRevision: 9,
    },
  ])("rejects unsupported request variants", (request) => {
    expect(Value.Check(CreateResponseRequestSchema, request)).toBe(false);
  });

  it("requires the exact stream accept value and a canonical random UUID", () => {
    expect(
      Value.Check(CreateResponseRequestHeadersSchema, {
        accept: "application/x-ndjson",
        "idempotency-key": idempotencyKey,
        origin: "http://localhost:5173",
      }),
    ).toBe(true);
    expect(
      Value.Check(CreateResponseRequestHeadersSchema, {
        accept: "application/x-ndjson",
        "idempotency-key": idempotencyKey.toUpperCase(),
      }),
    ).toBe(false);
    expect(
      Value.Check(CreateResponseRequestHeadersSchema, {
        accept: "application/json",
        "idempotency-key": idempotencyKey,
      }),
    ).toBe(false);
    expect(
      Value.Check(CreateResponseRequestHeadersSchema, {
        accept: "application/x-ndjson",
      }),
    ).toBe(false);
  });

  it("keeps cancellation scoped and bodyless", () => {
    expect(Value.Check(CancelGenerationParamsSchema, { conversationId, generationId })).toBe(true);
    expect(Value.Check(CancelGenerationRequestSchema, {})).toBe(true);
    expect(Value.Check(CancelGenerationRequestSchema, { force: true })).toBe(false);
    expect(Value.Check(CancelGenerationResponseSchema, null)).toBe(true);
  });
});

describe("response-state contracts", () => {
  const responseIdentity = { generationId, messageId: assistantMessageId };

  it("accepts each correlated durable lifecycle shape", () => {
    const responses = [
      { ...responseIdentity, status: "active", reason: null, errorCode: null },
      { ...responseIdentity, status: "completed", reason: "length", errorCode: null },
      { ...responseIdentity, status: "cancelled", reason: "cancelled", errorCode: null },
      {
        ...responseIdentity,
        status: "incomplete",
        reason: "error",
        errorCode: "STREAM_INTERRUPTED",
      },
      {
        ...responseIdentity,
        status: "failed",
        reason: "error",
        errorCode: "EMPTY_RESPONSE",
      },
    ];
    for (const response of responses) {
      expect(
        Value.Check(ResponseStateResponseSchema, {
          conversationId,
          revision: 9,
          responses: [response],
        }),
      ).toBe(true);
    }
  });

  it.each([
    { ...responseIdentity, status: "active", reason: "stop", errorCode: null },
    { ...responseIdentity, status: "completed", reason: "error", errorCode: null },
    {
      ...responseIdentity,
      status: "cancelled",
      reason: "cancelled",
      errorCode: "GENERATION_FAILED",
    },
    { ...responseIdentity, status: "failed", reason: "error", errorCode: null },
  ])("rejects inconsistent lifecycle fields", (response) => {
    expect(
      Value.Check(ResponseStateResponseSchema, {
        conversationId,
        revision: 9,
        responses: [response],
      }),
    ).toBe(false);
  });

  it("bounds and deduplicates requested assistant identifiers", () => {
    expect(Value.Check(ResponseStateRequestSchema, { messageIds: [assistantMessageId] })).toBe(
      true,
    );
    expect(Value.Check(ResponseStateRequestSchema, { messageIds: [] })).toBe(true);
    expect(
      Value.Check(ResponseStateRequestSchema, {
        messageIds: [assistantMessageId, assistantMessageId],
      }),
    ).toBe(false);
    expect(
      Value.Check(ResponseStateRequestSchema, {
        messageIds: Array.from({ length: CONVERSATION_MESSAGE_PAGE_SIZE + 1 }, (_, index) =>
          index === 0
            ? assistantMessageId
            : `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
        ),
      }),
    ).toBe(false);
  });
});

describe("complete v1 stream event catalog", () => {
  const usage = { inputTokens: 200, outputTokens: 80 };
  const events = [
    {
      type: "response.started",
      conversationId,
      generationId,
      userMessageId,
      messageId: assistantMessageId,
      revision: 8,
    },
    { type: "context.compacting" },
    { type: "context.compacted" },
    { type: "context.warning", code: "CONTEXT_COMPACTION_FALLBACK" },
    { type: "stream.heartbeat" },
    { type: "content.delta", text: "Respuesta" },
    {
      type: "response.completed",
      messageId: assistantMessageId,
      revision: 9,
      reason: "stop",
      usage,
    },
    { type: "response.cancelled", messageId: assistantMessageId, revision: 9 },
    {
      type: "response.failed",
      messageId: assistantMessageId,
      revision: 9,
      errorCode: "GENERATION_FAILED",
      partial: true,
      usage,
    },
  ];

  it("validates all nine approved known event types", () => {
    expect(events.map((event) => event.type)).toHaveLength(9);
    for (const event of events) {
      expect(Value.Check(StreamEventSchema, event)).toBe(true);
    }
  });

  it("keeps known events closed while leaving unknown handling to the parser", () => {
    expect(Value.Check(StreamEventSchema, { type: "response.future", safe: true })).toBe(false);
    expect(Value.Check(ContentDeltaEventSchema, { type: "content.delta", text: "" })).toBe(false);
    expect(
      Value.Check(ContentDeltaEventSchema, {
        type: "content.delta",
        text: String.fromCharCode(0xd800),
      }),
    ).toBe(false);
    expect(
      Value.Check(ContentDeltaEventSchema, {
        type: "content.delta",
        text: "Respuesta",
        sequence: 1,
      }),
    ).toBe(false);
  });

  it("requires non-negative integer usage", () => {
    expect(Value.Check(GenerationUsageSchema, { inputTokens: 0, outputTokens: 0 })).toBe(true);
    expect(Value.Check(GenerationUsageSchema, { inputTokens: -1, outputTokens: 0 })).toBe(false);
    expect(Value.Check(GenerationUsageSchema, { inputTokens: 1.5, outputTokens: 0 })).toBe(false);
  });
});

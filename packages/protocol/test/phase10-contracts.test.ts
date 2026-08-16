import Value from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  ADMIN_ANSWER_REPORT_PAGE_SIZE,
  AdminAnswerReportDetailSchema,
  AdminAnswerReportListResponseSchema,
  AdminUsagePurposeSchema,
  ANSWER_REPORT_NOTE_MAX_CODE_POINTS,
  ANSWER_REPORT_STATE_MAX_MESSAGE_IDS,
  AnswerReportStateRequestSchema,
  AnswerReportStateResponseSchema,
  ConversationNamingEventSchema,
  CreateAnswerReportRequestSchema,
  CreateAnswerReportResponseSchema,
  RESPONSE_UPDATES_MAX_TEXT_UTF8_BYTES,
  ResponseUpdatesRequestSchema,
  ResponseUpdatesResponseSchema,
  StreamEventSchema,
} from "../src/index.js";

const conversationId = "aaedb175-c593-4d66-87d6-636fca2aa4fa";
const generationId = "f8741fd0-6cf9-4da1-b08a-d69efb33dc4f";
const messageId = "ca40adf0-8ee4-4805-bceb-d69a0da23b55";
const reportId = "3f6c1a1e-6d7c-4a1c-9d2e-6b2f6f0f5c11";
const cursor = "eyJrIjoidXBkYXRlcyJ9.signature_1";

describe("Phase 10 contracts", () => {
  it("adds the additive naming event to the closed stream union", () => {
    expect(Value.Check(ConversationNamingEventSchema, { type: "conversation.naming" })).toBe(true);
    expect(Value.Check(StreamEventSchema, { type: "conversation.naming" })).toBe(true);
    expect(Value.Check(StreamEventSchema, { type: "conversation.naming", text: "x" })).toBe(false);
  });

  it("accepts the title usage purpose", () => {
    for (const purpose of ["chat", "compaction", "title"]) {
      expect(Value.Check(AdminUsagePurposeSchema, purpose)).toBe(true);
    }
    expect(Value.Check(AdminUsagePurposeSchema, "naming")).toBe(false);
  });

  it("validates response update requests and responses", () => {
    expect(Value.Check(ResponseUpdatesRequestSchema, { cursor: null })).toBe(true);
    expect(Value.Check(ResponseUpdatesRequestSchema, { cursor })).toBe(true);
    expect(Value.Check(ResponseUpdatesRequestSchema, {})).toBe(false);
    expect(Value.Check(ResponseUpdatesRequestSchema, { cursor: "not a cursor" })).toBe(false);

    const active = {
      conversationId,
      revision: 4,
      phase: "responding",
      response: {
        generationId,
        messageId,
        status: "active",
        reason: null,
        errorCode: null,
      },
      content: { mode: "replace", text: "durable" },
      nextCursor: cursor,
    };
    expect(Value.Check(ResponseUpdatesResponseSchema, active)).toBe(true);
    expect(
      Value.Check(ResponseUpdatesResponseSchema, {
        ...active,
        phase: "naming",
        content: { mode: "append", text: "" },
      }),
    ).toBe(true);
    expect(
      Value.Check(ResponseUpdatesResponseSchema, {
        ...active,
        response: {
          generationId,
          messageId,
          status: "completed",
          reason: "stop",
          errorCode: null,
        },
        nextCursor: null,
      }),
    ).toBe(true);
    expect(Value.Check(ResponseUpdatesResponseSchema, { ...active, phase: "finalizing" })).toBe(
      false,
    );
    expect(
      Value.Check(ResponseUpdatesResponseSchema, {
        ...active,
        content: { mode: "replace", text: "\ud800" },
      }),
    ).toBe(false);
    expect(
      Value.Check(ResponseUpdatesResponseSchema, {
        ...active,
        content: { mode: "replace", text: "a".repeat(RESPONSE_UPDATES_MAX_TEXT_UTF8_BYTES) },
      }),
    ).toBe(true);
    expect(
      Value.Check(ResponseUpdatesResponseSchema, {
        ...active,
        content: {
          mode: "replace",
          text: `${"a".repeat(RESPONSE_UPDATES_MAX_TEXT_UTF8_BYTES - 1)}ñ`,
        },
      }),
    ).toBe(false);
  });

  it("validates answer report creation and state contracts", () => {
    expect(
      Value.Check(CreateAnswerReportRequestSchema, {
        reason: "incorrect",
        sharePromptAndAnswer: true,
      }),
    ).toBe(true);
    expect(
      Value.Check(CreateAnswerReportRequestSchema, {
        reason: "other",
        note: "La cifra citada no coincide.",
        sharePromptAndAnswer: true,
      }),
    ).toBe(true);
    expect(
      Value.Check(CreateAnswerReportRequestSchema, {
        reason: "other",
        sharePromptAndAnswer: false,
      }),
    ).toBe(false);
    expect(
      Value.Check(CreateAnswerReportRequestSchema, {
        reason: "spam",
        sharePromptAndAnswer: true,
      }),
    ).toBe(false);
    expect(
      Value.Check(CreateAnswerReportRequestSchema, {
        reason: "other",
        note: "   ",
        sharePromptAndAnswer: true,
      }),
    ).toBe(false);
    expect(
      Value.Check(CreateAnswerReportRequestSchema, {
        reason: "other",
        note: "a\u0000b",
        sharePromptAndAnswer: true,
      }),
    ).toBe(false);
    expect(
      Value.Check(CreateAnswerReportRequestSchema, {
        reason: "other",
        note: "é".repeat(ANSWER_REPORT_NOTE_MAX_CODE_POINTS),
        sharePromptAndAnswer: true,
      }),
    ).toBe(true);
    expect(
      Value.Check(CreateAnswerReportRequestSchema, {
        reason: "other",
        note: "é".repeat(ANSWER_REPORT_NOTE_MAX_CODE_POINTS + 1),
        sharePromptAndAnswer: true,
      }),
    ).toBe(false);
    expect(
      Value.Check(CreateAnswerReportResponseSchema, {
        id: reportId,
        messageId,
        createdAt: "2026-08-15T12:00:00.000Z",
        repeated: false,
      }),
    ).toBe(true);

    expect(ANSWER_REPORT_STATE_MAX_MESSAGE_IDS).toBe(40);
    expect(Value.Check(AnswerReportStateRequestSchema, { messageIds: [messageId] })).toBe(true);
    expect(Value.Check(AnswerReportStateRequestSchema, { messageIds: [] })).toBe(false);
    expect(
      Value.Check(AnswerReportStateRequestSchema, { messageIds: [messageId, messageId] }),
    ).toBe(false);
    expect(
      Value.Check(AnswerReportStateResponseSchema, {
        conversationId,
        reportedMessageIds: [messageId],
      }),
    ).toBe(true);
  });

  it("keeps administrator report contracts free of conversation identity", () => {
    const item = {
      id: reportId,
      reporter: { name: "Persona", email: "persona@example.com" },
      reason: "outdated",
      note: null,
      createdAt: "2026-08-15T12:00:00.000Z",
    };
    expect(ADMIN_ANSWER_REPORT_PAGE_SIZE).toBe(50);
    expect(
      Value.Check(AdminAnswerReportListResponseSchema, { items: [item], nextCursor: null }),
    ).toBe(true);
    expect(
      Value.Check(AdminAnswerReportListResponseSchema, {
        items: [{ ...item, conversationId }],
        nextCursor: null,
      }),
    ).toBe(false);
    expect(
      Value.Check(AdminAnswerReportDetailSchema, {
        ...item,
        exchange: { prompt: "¿Cuál es la prima?", answer: "La prima es…" },
      }),
    ).toBe(true);
    expect(
      Value.Check(AdminAnswerReportDetailSchema, {
        ...item,
        exchange: { prompt: "¿Cuál es la prima?", answer: "La prima es…", messageId },
      }),
    ).toBe(false);
  });
});

import Value from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  ApiErrorSchema,
  DevelopmentMailboxResponseSchema,
  LivenessResponseSchema,
  ReadinessResponseSchema,
  SessionResponseSchema,
} from "../src/index.js";

describe("LivenessResponseSchema", () => {
  it("accepts the liveness response", () => {
    expect(Value.Check(LivenessResponseSchema, { status: "live" })).toBe(true);
  });

  it("rejects other statuses and extra properties", () => {
    expect(Value.Check(LivenessResponseSchema, { status: "ready" })).toBe(false);
    expect(Value.Check(LivenessResponseSchema, { status: "live", database: "up" })).toBe(false);
  });
});

describe("ReadinessResponseSchema", () => {
  it.each([
    { status: "ready", database: "up" },
    { status: "unavailable", database: "down" },
    { status: "unavailable", database: "unknown" },
  ])("accepts a supported readiness response", (response) => {
    expect(Value.Check(ReadinessResponseSchema, response)).toBe(true);
  });

  it.each([
    { status: "live", database: "up" },
    { status: "ready", database: "unknown-service" },
    { status: "ready", database: "down" },
    { status: "unavailable", database: "up" },
    { status: "unavailable" },
    { status: "ready", database: "up", cache: "up" },
  ])("rejects an invalid readiness response", (response) => {
    expect(Value.Check(ReadinessResponseSchema, response)).toBe(false);
  });
});

describe("ApiErrorSchema", () => {
  it("accepts the common API error envelope", () => {
    expect(
      Value.Check(ApiErrorSchema, {
        code: "INTERNAL_ERROR",
        message: "Service unavailable",
        requestId: "request-123",
      }),
    ).toBe(true);
  });

  it.each([
    { code: "INTERNAL_ERROR", message: "Service unavailable" },
    { code: "", message: "Service unavailable", requestId: "request-123" },
    {
      code: "SERVICE_UNAVAILABLE",
      message: "Service unavailable",
      requestId: "request-123",
      cause: "database",
    },
    {
      code: "SERVICE_UNAVAILABLE",
      message: "Service unavailable",
      requestId: "request-123",
    },
  ])("rejects an invalid API error envelope", (response) => {
    expect(Value.Check(ApiErrorSchema, response)).toBe(false);
  });
});

const validSessionResponse = {
  employee: {
    id: "employee-123",
    name: "Alex Rivera",
    email: "alex.rivera@example.com",
  },
  workspace: {
    id: "workspace-123",
    identity: "capstone",
    name: "Capstone",
    role: "member",
  },
  session: {
    createdAt: "2026-08-06T12:00:00.000Z",
    expiresAt: "2026-08-13T12:00:00.000Z",
  },
};

describe("SessionResponseSchema", () => {
  it("accepts the authenticated employee, workspace, and session view", () => {
    expect(Value.Check(SessionResponseSchema, validSessionResponse)).toBe(true);
  });

  it.each([
    {
      ...validSessionResponse,
      workspace: { ...validSessionResponse.workspace, role: "owner" },
    },
    {
      ...validSessionResponse,
      employee: { ...validSessionResponse.employee, email: "not-an-email" },
    },
    {
      ...validSessionResponse,
      session: { ...validSessionResponse.session, expiresAt: "next Thursday" },
    },
    {
      employee: validSessionResponse.employee,
      workspace: validSessionResponse.workspace,
    },
  ])("rejects an invalid session response", (response) => {
    expect(Value.Check(SessionResponseSchema, response)).toBe(false);
  });

  it.each([
    { ...validSessionResponse, approvalStatus: "activated" },
    {
      ...validSessionResponse,
      employee: { ...validSessionResponse.employee, emailVerified: true },
    },
    {
      ...validSessionResponse,
      workspace: { ...validSessionResponse.workspace, timezone: "America/Guayaquil" },
    },
    {
      ...validSessionResponse,
      session: { ...validSessionResponse.session, token: "secret" },
    },
  ])("rejects extra session properties", (response) => {
    expect(Value.Check(SessionResponseSchema, response)).toBe(false);
  });
});

const validMailboxMessage = {
  html: "<p>Confirma que este correo te pertenece.</p>",
  id: "b95e1b4f-f48b-427f-b923-4f0588cfac25",
  purpose: "verification",
  to: "employee@example.com",
  subject: "Verifica tu correo de Capstone Chat",
  text: "Confirma que este correo te pertenece.",
  createdAt: "2026-08-06T12:00:00.000Z",
};

describe("DevelopmentMailboxResponseSchema", () => {
  it.each([{ messages: [] }, { messages: [validMailboxMessage] }])(
    "accepts a bounded development mailbox response",
    (response) => {
      expect(Value.Check(DevelopmentMailboxResponseSchema, response)).toBe(true);
    },
  );

  it.each([
    {
      messages: [{ ...validMailboxMessage, purpose: "marketing" }],
    },
    {
      messages: [{ ...validMailboxMessage, id: "not-a-uuid" }],
    },
    {
      messages: [{ ...validMailboxMessage, createdAt: "today" }],
    },
    {
      messages: Array.from({ length: 101 }, () => validMailboxMessage),
    },
    {},
  ])("rejects an invalid development mailbox response", (response) => {
    expect(Value.Check(DevelopmentMailboxResponseSchema, response)).toBe(false);
  });

  it.each([
    { messages: [validMailboxMessage], retained: 1 },
    { messages: [{ ...validMailboxMessage, providerId: "provider-secret" }] },
  ])("rejects extra development mailbox properties", (response) => {
    expect(Value.Check(DevelopmentMailboxResponseSchema, response)).toBe(false);
  });
});

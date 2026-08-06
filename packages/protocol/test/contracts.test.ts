import Value from "typebox/value";
import { describe, expect, it } from "vitest";
import { ApiErrorSchema, LivenessResponseSchema, ReadinessResponseSchema } from "../src/index.js";

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
        code: "SERVICE_UNAVAILABLE",
        message: "Service unavailable",
        requestId: "request-123",
      }),
    ).toBe(true);
  });

  it.each([
    { code: "SERVICE_UNAVAILABLE", message: "Service unavailable" },
    { code: "", message: "Service unavailable", requestId: "request-123" },
    {
      code: "SERVICE_UNAVAILABLE",
      message: "Service unavailable",
      requestId: "request-123",
      cause: "database",
    },
  ])("rejects an invalid API error envelope", (response) => {
    expect(Value.Check(ApiErrorSchema, response)).toBe(false);
  });
});

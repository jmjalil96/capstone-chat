import Value from "typebox/value";
import { describe, expect, it } from "vitest";
import { CLIENT_ERROR_REPORT_MAX_POSITION, ClientErrorReportSchema } from "../src/index.js";

describe("ClientErrorReportSchema", () => {
  it.each([
    { kind: "render", route: "chat", release: "abc123" },
    {
      asset: "application-ABC_123.js",
      column: 14,
      kind: "resource",
      line: 21,
      release: "abc123",
      route: "identity",
    },
    { kind: "unhandled_error", route: "admin", release: "unknown" },
    { kind: "unhandled_rejection", route: "unknown", release: "local-dev" },
  ])("accepts closed, content-free metadata", (report) => {
    expect(Value.Check(ClientErrorReportSchema, report)).toBe(true);
  });

  it.each([
    { kind: "message", route: "chat", release: "abc123" },
    { kind: "render", route: "/c/conversation-id", release: "abc123" },
    { kind: "render", route: "chat", release: "https://release.example" },
    { kind: "render", route: "chat", release: "abc123", message: "private text" },
    { kind: "render", route: "chat", release: "abc123", stack: "private stack" },
    { kind: "render", route: "chat", release: "abc123", reason: "private reason" },
    { kind: "render", route: "chat", release: "abc123", url: "/c/private-id?query" },
    { kind: "resource", route: "chat", release: "abc123", asset: "/assets/app.js" },
    { kind: "resource", route: "chat", release: "abc123", asset: "app.js?token=value" },
    { kind: "resource", route: "chat", release: "abc123", asset: "private.txt" },
    { kind: "render", route: "chat", release: "abc123", line: -1 },
    {
      kind: "render",
      route: "chat",
      release: "abc123",
      column: CLIENT_ERROR_REPORT_MAX_POSITION + 1,
    },
  ])("rejects content, identifiers, URLs, or unbounded metadata", (report) => {
    expect(Value.Check(ClientErrorReportSchema, report)).toBe(false);
  });
});

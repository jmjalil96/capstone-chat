import type { ClientErrorReport } from "@capstone/protocol";
import { cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clientErrorRoute,
  createClientErrorReporter,
  installClientErrorListeners,
} from "./client-errors";

afterEach(() => {
  cleanup();
  document.head.replaceChildren();
  vi.restoreAllMocks();
});

describe("client error reporting", () => {
  it.each([
    ["/sign-in", "identity"],
    ["/reset-password", "identity"],
    ["/c/private-conversation-id", "chat"],
    ["/search", "chat"],
    ["/admin/employees/private-employee-id", "admin"],
    ["/not-found/private-id", "unknown"],
  ] as const)("maps %s to the closed %s category", (pathname, category) => {
    expect(clientErrorRoute(pathname)).toBe(category);
  });

  it("sends only closed metadata and deduplicates each route and kind", () => {
    let pathname = "/c/private-conversation-id";
    const reports: ClientErrorReport[] = [];
    const reporter = createClientErrorReporter({
      pathname: () => pathname,
      release: "release-abc123",
      send: (report) => {
        reports.push(report);
      },
    });

    reporter.report({ column: 5, kind: "unhandled_error", line: 4 });
    reporter.report({ column: 9, kind: "unhandled_error", line: 8 });
    pathname = "/admin/employees/private-employee-id";
    reporter.report({ kind: "unhandled_error" });

    expect(reports).toEqual([
      {
        column: 5,
        kind: "unhandled_error",
        line: 4,
        release: "release-abc123",
        route: "chat",
      },
      {
        kind: "unhandled_error",
        release: "release-abc123",
        route: "admin",
      },
    ]);
    expect(JSON.stringify(reports)).not.toContain("private-conversation-id");
    expect(JSON.stringify(reports)).not.toContain("private-employee-id");
  });

  it("maps global failures without reading message, reason, stack, filename, or URL", () => {
    const reports: ClientErrorReport[] = [];
    const reporter = createClientErrorReporter({
      pathname: () => "/",
      release: "abc123",
      send: (report) => {
        reports.push(report);
      },
    });
    const removeListeners = installClientErrorListeners(reporter);

    window.dispatchEvent(
      new ErrorEvent("error", {
        colno: 17,
        error: new Error("PRIVATE_STACK_CANARY"),
        filename: "https://example.test/private.js?credential=CANARY",
        lineno: 13,
        message: "PRIVATE_MESSAGE_CANARY",
      }),
    );
    const rejection = new Event("unhandledrejection");
    Object.defineProperty(rejection, "reason", { value: "PRIVATE_REASON_CANARY" });
    window.dispatchEvent(rejection);
    removeListeners();

    expect(reports).toEqual([
      {
        column: 17,
        kind: "unhandled_error",
        line: 13,
        release: "abc123",
        route: "chat",
      },
      { kind: "unhandled_rejection", release: "abc123", route: "chat" },
    ]);
    expect(JSON.stringify(reports)).not.toMatch(/PRIVATE_|https:|credential/iu);
  });

  it("keeps only the basename of an application-owned fingerprinted resource", () => {
    const reports: ClientErrorReport[] = [];
    const reporter = createClientErrorReporter({
      pathname: () => "/sign-in",
      release: "abc123",
      send: (report) => {
        reports.push(report);
      },
    });
    const removeListeners = installClientErrorListeners(reporter);
    const script = document.createElement("script");
    script.src = `${window.location.origin}/assets/application-ABC_123.js`;
    document.head.append(script);

    script.dispatchEvent(new Event("error"));
    removeListeners();

    expect(reports).toEqual([
      {
        asset: "application-ABC_123.js",
        kind: "resource",
        release: "abc123",
        route: "identity",
      },
    ]);
    expect(JSON.stringify(reports)).not.toContain(window.location.origin);
  });

  it("drops unsafe optional metadata and normalizes an invalid release", () => {
    const reports: ClientErrorReport[] = [];
    const reporter = createClientErrorReporter({
      pathname: () => "/",
      release: "https://deployment.example/private",
      send: (report) => {
        reports.push(report);
      },
    });

    reporter.report({
      asset: "https://example.test/assets/application-ABC_123.js?secret",
      column: Number.MAX_SAFE_INTEGER,
      kind: "resource",
      line: -1,
    });

    expect(reports).toEqual([{ kind: "resource", release: "unknown", route: "chat" }]);
  });

  it("ignores synchronous and asynchronous transport failures", async () => {
    const synchronous = createClientErrorReporter({
      pathname: () => "/",
      release: "abc123",
      send: () => {
        throw new Error("transport unavailable");
      },
    });
    const asynchronous = createClientErrorReporter({
      pathname: () => "/",
      release: "abc123",
      send: () => Promise.reject(new Error("transport unavailable")),
    });

    expect(() => synchronous.report({ kind: "render" })).not.toThrow();
    expect(() => asynchronous.report({ kind: "render" })).not.toThrow();
    await Promise.resolve();
  });
});

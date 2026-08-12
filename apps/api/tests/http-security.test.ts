import type { FastifyReply, FastifyRequest } from "fastify";
import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { ApplicationError } from "../src/errors.js";
import { applySecurityHeaders, enforceCapstoneMutationBoundary } from "../src/security/http.js";

const config = loadConfig({ NODE_ENV: "test" });

function request(input: {
  contentType?: string | undefined;
  method: string;
  origin?: string | undefined;
  url: string;
}): FastifyRequest {
  const headers: Record<string, string> = {};
  if (input.contentType !== undefined) {
    headers["content-type"] = input.contentType;
  }
  if (input.origin !== undefined) {
    headers.origin = input.origin;
  }

  return {
    headers,
    method: input.method,
    url: input.url,
  } as unknown as FastifyRequest;
}

function expectApplicationError(
  action: () => unknown,
  expected: { code: string; message: string; statusCode: number },
): void {
  try {
    action();
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(ApplicationError);
    expect(error).toMatchObject(expected);
    return;
  }

  throw new Error("Expected an ApplicationError");
}

describe("applySecurityHeaders", () => {
  it("sets the complete application-side security header policy", () => {
    const captured = new Map<string, string>();
    const reply = {
      header: vi.fn((name: string, value: string) => {
        captured.set(name, value);
        return reply;
      }),
    } as unknown as FastifyReply;

    applySecurityHeaders(reply);

    expect(Object.fromEntries(captured)).toEqual({
      "content-security-policy": [
        "default-src 'self'",
        "base-uri 'self'",
        "connect-src 'self'",
        "font-src 'self'",
        "form-action 'self'",
        "frame-ancestors 'none'",
        "img-src 'self' data:",
        "object-src 'none'",
        "script-src 'self'",
        "style-src 'self'",
      ].join("; "),
      "permissions-policy": "camera=(), geolocation=(), microphone=()",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    });
    expect(reply.header).toHaveBeenCalledTimes(4);
  });

  it("adds HSTS only for the production HTTPS deployment", () => {
    const captured = new Map<string, string>();
    const reply = {
      header: vi.fn((name: string, value: string) => {
        captured.set(name, value);
        return reply;
      }),
    } as unknown as FastifyReply;

    applySecurityHeaders(reply, "production");

    expect(captured.get("strict-transport-security")).toBe("max-age=31536000");
    expect(captured.get("strict-transport-security")).not.toContain("includeSubDomains");
    expect(captured.get("strict-transport-security")).not.toContain("preload");
  });

  it("adds the same HSTS policy for the managed HTTPS rehearsal", () => {
    const captured = new Map<string, string>();
    const reply = {
      header: vi.fn((name: string, value: string) => {
        captured.set(name, value);
        return reply;
      }),
    } as unknown as FastifyReply;

    applySecurityHeaders(reply, "test", "managed-rehearsal");

    expect(captured.get("strict-transport-security")).toBe("max-age=31536000");
  });
});

describe("enforceCapstoneMutationBoundary", () => {
  it.each([
    { method: "GET", url: "/api/session" },
    { method: "POST", url: "/not-api" },
    { method: "POST", url: "/api/auth/sign-in/email" },
  ])("does not apply to $method $url", ({ method, url }) => {
    expect(() => enforceCapstoneMutationBoundary(request({ method, url }), config)).not.toThrow();
  });

  it.each(["DELETE", "PATCH", "POST", "PUT"])(
    "allows %s from the exact public origin with JSON",
    (method) => {
      expect(() =>
        enforceCapstoneMutationBoundary(
          request({
            contentType: "Application/JSON; charset=utf-8",
            method,
            origin: config.publicOrigin,
            url: "/api/example",
          }),
          config,
        ),
      ).not.toThrow();
    },
  );

  it.each([undefined, "https://other.capstone.example", `${config.publicOrigin}/`])(
    "rejects a non-matching Origin value: %s",
    (origin) => {
      expectApplicationError(
        () =>
          enforceCapstoneMutationBoundary(
            request({
              contentType: "application/json",
              method: "POST",
              origin,
              url: "/api/example",
            }),
            config,
          ),
        {
          code: "ORIGIN_NOT_ALLOWED",
          message: "La solicitud no proviene del origen permitido.",
          statusCode: 403,
        },
      );
    },
  );

  it.each([
    undefined,
    "text/plain",
    "application/json-patch+json",
    "application/x-www-form-urlencoded",
  ])("rejects a non-JSON Content-Type value: %s", (contentType) => {
    expectApplicationError(
      () =>
        enforceCapstoneMutationBoundary(
          request({
            contentType,
            method: "POST",
            origin: config.publicOrigin,
            url: "/api/example",
          }),
          config,
        ),
      {
        code: "JSON_REQUIRED",
        message: "Esta operaci\u00f3n requiere contenido JSON.",
        statusCode: 415,
      },
    );
  });

  it("does not exempt an auth-like Capstone route", () => {
    expectApplicationError(
      () =>
        enforceCapstoneMutationBoundary(
          request({
            contentType: "application/json",
            method: "POST",
            origin: "https://other.capstone.example",
            url: "/api/authentication/check",
          }),
          config,
        ),
      {
        code: "ORIGIN_NOT_ALLOWED",
        message: "La solicitud no proviene del origen permitido.",
        statusCode: 403,
      },
    );
  });
});

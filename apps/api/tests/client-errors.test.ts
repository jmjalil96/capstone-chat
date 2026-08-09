import { TypeBoxValidatorCompiler } from "@fastify/type-provider-typebox";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerErrorHandling } from "../src/errors.js";
import type { ClientErrorRateLimiter } from "../src/observability/client-error-rate-limit.js";
import {
  type AcceptedClientErrorReport,
  CLIENT_ERROR_REPORT_BODY_LIMIT_BYTES,
  registerClientErrorRoute,
} from "../src/routes/client-errors.js";

const servers: ReturnType<typeof Fastify>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

function createServer(input?: {
  readonly allow?: boolean | undefined;
  readonly isKnownAsset?: ((asset: string) => boolean) | undefined;
  readonly onReport?: ((report: AcceptedClientErrorReport) => void) | undefined;
}) {
  const server = Fastify({ logger: false }).setValidatorCompiler(TypeBoxValidatorCompiler);
  const allow = vi.fn(async () => input?.allow ?? true);
  registerErrorHandling(server);
  registerClientErrorRoute(server, {
    isKnownAsset: input?.isKnownAsset ?? (() => false),
    onReport: input?.onReport ?? (() => undefined),
    rateLimiter: { allow } satisfies ClientErrorRateLimiter,
    release: "release-abc123",
  });
  servers.push(server);
  return { allow, server };
}

describe("POST /api/client-errors", () => {
  it("accepts a closed report without echoing it and normalizes a mismatched release", async () => {
    const reports: AcceptedClientErrorReport[] = [];
    const { allow, server } = createServer({ onReport: (report) => reports.push(report) });

    const response = await server.inject({
      method: "POST",
      payload: { column: 4, kind: "unhandled_error", line: 3, release: "old", route: "chat" },
      url: "/api/client-errors",
    });

    expect(response.statusCode).toBe(204);
    expect(response.body).toBe("");
    expect(allow).toHaveBeenCalledWith("127.0.0.1");
    expect(reports).toEqual([
      {
        column: 4,
        kind: "unhandled_error",
        line: 3,
        release: "unknown",
        route: "chat",
      },
    ]);
  });

  it("accepts only an emitted application asset basename", async () => {
    const reports: AcceptedClientErrorReport[] = [];
    const { server } = createServer({
      isKnownAsset: (asset) => asset === "application-ABC_123.js",
      onReport: (report) => reports.push(report),
    });

    const accepted = await server.inject({
      method: "POST",
      payload: {
        asset: "application-ABC_123.js",
        kind: "resource",
        release: "release-abc123",
        route: "identity",
      },
      url: "/api/client-errors",
    });
    const rejected = await server.inject({
      method: "POST",
      payload: {
        asset: "unlisted-ABC_123.js",
        kind: "resource",
        release: "release-abc123",
        route: "identity",
      },
      url: "/api/client-errors",
    });

    expect(accepted.statusCode).toBe(204);
    expect(rejected.statusCode).toBe(400);
    expect(reports).toHaveLength(1);
  });

  it.each([
    { kind: "render", message: "PRIVATE", release: "release-abc123", route: "chat" },
    { kind: "render", release: "release-abc123", route: "chat", stack: "PRIVATE" },
    { kind: "render", reason: "PRIVATE", release: "release-abc123", route: "chat" },
    { kind: "render", release: "release-abc123", route: "chat", url: "/c/private" },
    { kind: "render", line: -1, release: "release-abc123", route: "chat" },
    { kind: "render", release: "release-abc123", route: "/c/private" },
  ])("rejects content-bearing or unbounded payloads", async (payload) => {
    const { server } = createServer();
    const response = await server.inject({
      method: "POST",
      payload,
      url: "/api/client-errors",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "BAD_REQUEST" });
  });

  it("silently drops a valid report once its database authority denies it", async () => {
    const onReport = vi.fn();
    const { server } = createServer({ allow: false, onReport });

    const response = await server.inject({
      method: "POST",
      payload: { kind: "render", release: "release-abc123", route: "chat" },
      url: "/api/client-errors",
    });

    expect(response.statusCode).toBe(204);
    expect(response.body).toBe("");
    expect(onReport).not.toHaveBeenCalled();
  });

  it("enforces the route-specific small body limit", async () => {
    const { server } = createServer();
    const response = await server.inject({
      headers: { "content-type": "application/json" },
      method: "POST",
      payload: JSON.stringify({
        kind: "render",
        padding: "x".repeat(CLIENT_ERROR_REPORT_BODY_LIMIT_BYTES),
        release: "release-abc123",
        route: "chat",
      }),
      url: "/api/client-errors",
    });

    expect(response.statusCode).toBe(413);
    expect(response.json()).toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
  });
});

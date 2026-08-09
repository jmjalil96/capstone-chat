import type { FastifyReply, FastifyRequest } from "fastify";
import type { ApiConfig, RuntimeMode } from "../config.js";
import { ApplicationError } from "../errors.js";

const mutationMethods = new Set(["DELETE", "PATCH", "POST", "PUT"]);

export const httpServerTuning = Object.freeze({
  incomingRequestTimeoutMilliseconds: 15_000,
  ordinaryDrainMilliseconds: 5_000,
  shutdownCleanupMilliseconds: 30_000,
});

const securityHeaders = Object.freeze({
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
} as const);

export function applySecurityHeaders(
  reply: FastifyReply,
  runtimeMode: RuntimeMode = "development",
): void {
  for (const [name, value] of Object.entries(securityHeaders)) {
    void reply.header(name, value);
  }

  if (runtimeMode === "production") {
    void reply.header("strict-transport-security", "max-age=31536000");
  }
}

export function enforceCapstoneMutationBoundary(request: FastifyRequest, config: ApiConfig): void {
  if (
    !mutationMethods.has(request.method) ||
    !request.url.startsWith("/api/") ||
    request.url.startsWith("/api/auth/")
  ) {
    return;
  }

  if (request.headers.origin !== config.publicOrigin) {
    throw new ApplicationError(
      403,
      "ORIGIN_NOT_ALLOWED",
      "La solicitud no proviene del origen permitido.",
    );
  }

  const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new ApplicationError(415, "JSON_REQUIRED", "Esta operación requiere contenido JSON.");
  }
}

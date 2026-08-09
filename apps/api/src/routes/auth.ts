import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Authentication } from "../auth/authentication.js";
import { createTrustedAuthHeaders } from "../auth/request-headers.js";
import type { ApiConfig } from "../config.js";
import { ApplicationError } from "../errors.js";
import { normalizeEmail } from "../identity/email-normalization.js";
import { identitySecurity } from "../identity/security.js";

interface AuthRequestBody {
  callbackURL?: unknown;
  email?: unknown;
  name?: unknown;
  password?: unknown;
  rememberMe?: unknown;
  token?: unknown;
}

const maximumCredentialCharacters = 4_096;

function asAuthRequestBody(body: unknown): AuthRequestBody | undefined {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return undefined;
  }

  return body as AuthRequestBody;
}

function authPath(request: FastifyRequest, config: ApiConfig): URL {
  const rawUrl = request.raw.url ?? request.url;
  const parsed = new URL(rawUrl, config.publicOrigin);

  if (!parsed.pathname.startsWith("/api/auth/")) {
    throw new Error("Authentication route escaped its configured path");
  }

  return new URL(`${parsed.pathname}${parsed.search}`, config.publicOrigin);
}

function forwardedHeaders(request: FastifyRequest, config: ApiConfig): Headers {
  const headers = createTrustedAuthHeaders(request);
  headers.delete("content-length");
  headers.set("host", new URL(config.publicOrigin).host);
  return headers;
}

async function sendBetterAuthResponse(response: Response, reply: FastifyReply): Promise<unknown> {
  reply.code(response.status);

  for (const [name, value] of response.headers.entries()) {
    if (name.toLowerCase() !== "set-cookie") {
      void reply.header(name, value);
    }
  }

  const cookies = response.headers.getSetCookie();
  if (cookies.length > 0) {
    void reply.header("set-cookie", cookies);
  }
  if (!response.headers.has("cache-control")) {
    void reply.header("cache-control", "no-store");
  }

  const body = await response.arrayBuffer();
  return body.byteLength === 0 ? reply.send() : reply.send(Buffer.from(body));
}

async function sendVerificationResult(response: Response, reply: FastifyReply): Promise<unknown> {
  reply.code(response.ok ? 204 : response.status);

  for (const [name, value] of response.headers.entries()) {
    const normalizedName = name.toLowerCase();
    if (
      normalizedName !== "content-length" &&
      normalizedName !== "content-type" &&
      normalizedName !== "set-cookie"
    ) {
      void reply.header(name, value);
    }
  }

  const cookies = response.headers.getSetCookie();
  if (cookies.length > 0) {
    void reply.header("set-cookie", cookies);
  }
  void reply.header("cache-control", "no-store");
  await response.body?.cancel();
  return reply.send();
}

function verificationToken(request: FastifyRequest, config: ApiConfig): string {
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

  const body = asAuthRequestBody(request.body);
  const keys = body === undefined ? [] : Object.keys(body);
  if (
    body === undefined ||
    keys.length !== 1 ||
    keys[0] !== "token" ||
    typeof body.token !== "string" ||
    body.token.length === 0 ||
    body.token.length > maximumCredentialCharacters
  ) {
    throw new ApplicationError(400, "BAD_REQUEST", "El enlace de verificación no es válido.");
  }

  return body.token;
}

function sanitizedSignupBody(body: AuthRequestBody): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {
    email: typeof body.email === "string" ? normalizeEmail(body.email) : body.email,
    name: typeof body.name === "string" ? body.name.trim() : body.name,
    password: body.password,
  };

  if (typeof body.callbackURL === "string") {
    sanitized.callbackURL = body.callbackURL;
  }
  if (typeof body.rememberMe === "boolean") {
    sanitized.rememberMe = body.rememberMe;
  }

  return sanitized;
}

export function registerAuthRoutes(
  fastify: FastifyInstance,
  input: { authentication: Authentication; config: ApiConfig },
): void {
  const { authentication, config } = input;

  fastify.route({
    bodyLimit: identitySecurity.authBodyLimitBytes,
    method: ["GET", "POST"],
    url: "/api/auth/*",
    async handler(request, reply) {
      const url = authPath(request, config);
      const isVerification = url.pathname === "/api/auth/verify-email";
      const isResetMutation = url.pathname === "/api/auth/reset-password";
      const isLegacyResetCallback = url.pathname.startsWith("/api/auth/reset-password/");

      if (request.method === "GET" && (isVerification || isLegacyResetCallback)) {
        throw new ApplicationError(404, "NOT_FOUND", "No se encontró el recurso solicitado.");
      }
      if (
        request.method === "POST" &&
        (isVerification || isResetMutation) &&
        url.search.length > 0
      ) {
        throw new ApplicationError(400, "BAD_REQUEST", "El enlace de identidad no es válido.");
      }

      if (request.method === "POST" && isVerification) {
        const token = verificationToken(request, config);
        const internalUrl = new URL("/api/auth/verify-email", config.publicOrigin);
        internalUrl.searchParams.set("token", token);
        const headers = forwardedHeaders(request, config);
        headers.delete("content-type");
        const response = await authentication.auth.handler(
          new Request(internalUrl, { headers, method: "GET" }),
        );
        return sendVerificationResult(response, reply);
      }

      const body = asAuthRequestBody(request.body);
      let forwardedBody: unknown = request.body;

      if (url.pathname === "/api/auth/sign-up/email" && body !== undefined) {
        forwardedBody = sanitizedSignupBody(body);
      }

      if (url.pathname === "/api/auth/sign-in/email" && body !== undefined) {
        const email = typeof body.email === "string" ? body.email : "";
        forwardedBody = { ...body, email: normalizeEmail(email) };
      }

      const requestBody =
        request.method === "GET" || forwardedBody === undefined
          ? undefined
          : JSON.stringify(forwardedBody);
      const authRequest = new Request(url, {
        ...(requestBody === undefined ? {} : { body: requestBody }),
        headers: forwardedHeaders(request, config),
        method: request.method,
      });
      const response = await authentication.auth.handler(authRequest);

      return sendBetterAuthResponse(response, reply);
    },
  });
}

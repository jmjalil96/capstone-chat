import { fromNodeHeaders } from "better-auth/node";
import type { FastifyReply, FastifyRequest } from "fastify";
import { resolveTrustedClientAddress } from "../security/client-address.js";

export function createTrustedAuthHeaders(request: FastifyRequest): Headers {
  const headers = fromNodeHeaders(request.headers);
  for (const header of [
    "cf-connecting-ip",
    "forwarded",
    "x-capstone-client-ip",
    "x-forwarded-for",
    "x-forwarded-host",
    "x-forwarded-port",
    "x-forwarded-proto",
    "x-real-ip",
  ]) {
    headers.delete(header);
  }
  headers.set("x-capstone-client-ip", resolveTrustedClientAddress(request, request.ip));
  return headers;
}

export function forwardAuthenticationCookies(headers: Headers, reply: FastifyReply): void {
  const cookies = headers.getSetCookie();
  if (cookies.length > 0) {
    void reply.header("set-cookie", cookies);
  }
}

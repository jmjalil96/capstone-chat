import { isIP } from "node:net";
import type { FastifyRequest } from "fastify";
import type { ClientAddressSource } from "../config.js";
import { ApplicationError } from "../errors.js";

const capturedAddresses = new WeakMap<FastifyRequest, string | null>();
const healthRoutes = new Set(["/api/health/live", "/api/health/ready"]);

function invalidClientAddress(): ApplicationError {
  return new ApplicationError(
    400,
    "BAD_REQUEST",
    "No se pudo validar el origen de red de la solicitud.",
  );
}

function normalizedEdgeAddress(value: string | string[] | undefined): string | null {
  if (typeof value !== "string" || value.includes(",")) {
    return null;
  }

  const address = value.trim();
  const version = isIP(address);
  if (version === 4) {
    return address;
  }
  if (version !== 6) {
    return null;
  }

  try {
    const hostname = new URL(`http://[${address}]/`).hostname;
    return hostname.slice(1, -1).toLowerCase();
  } catch {
    return null;
  }
}

function normalizedAppPlatformAddress(value: string | string[] | undefined): string | null {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    /\s/u.test(value) ||
    value.includes(",")
  ) {
    return null;
  }
  return normalizedEdgeAddress(value);
}

function stripForwardingHeaders(request: FastifyRequest): void {
  for (const header of Object.keys(request.headers)) {
    if (
      header === "cf-connecting-ip" ||
      header === "do-connecting-ip" ||
      header === "forwarded" ||
      header === "x-capstone-client-ip" ||
      header === "x-real-ip" ||
      header.startsWith("x-forwarded-")
    ) {
      delete request.headers[header];
    }
  }
}

export function captureTrustedClientAddress(
  request: FastifyRequest,
  source: ClientAddressSource,
): void {
  const caddyAddress = request.headers["x-capstone-client-ip"];
  const appPlatformAddress = request.headers["do-connecting-ip"];
  stripForwardingHeaders(request);

  if (source === "digitalocean-app-platform") {
    if (appPlatformAddress === undefined) {
      capturedAddresses.set(request, null);
      if (healthRoutes.has(request.url)) {
        return;
      }
      throw invalidClientAddress();
    }

    const address = normalizedAppPlatformAddress(appPlatformAddress);
    capturedAddresses.set(request, address);
    if (address === null) {
      throw invalidClientAddress();
    }
    return;
  }

  const socketAddress = normalizedEdgeAddress(request.raw.socket.remoteAddress);
  capturedAddresses.set(
    request,
    source === "caddy"
      ? socketAddress === "127.0.0.1"
        ? normalizedEdgeAddress(caddyAddress)
        : null
      : normalizedEdgeAddress(request.ip),
  );
}

export function resolveTrustedClientAddress(
  request: FastifyRequest,
  uncapturedSocketAddress?: string,
): string {
  const address = capturedAddresses.get(request);
  if (address === undefined && uncapturedSocketAddress !== undefined) {
    return uncapturedSocketAddress;
  }
  if (address === undefined || address === null) {
    throw invalidClientAddress();
  }
  return address;
}

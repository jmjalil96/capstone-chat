import { isIP } from "node:net";
import type { FastifyRequest } from "fastify";
import type { ClientAddressSource } from "../config.js";
import { ApplicationError } from "../errors.js";

const capturedAddresses = new WeakMap<FastifyRequest, string | null>();

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

  const hostname = new URL(`http://[${address}]/`).hostname;
  return hostname.slice(1, -1).toLowerCase();
}

export function captureTrustedClientAddress(
  request: FastifyRequest,
  source: ClientAddressSource,
): void {
  const caddyAddress = request.headers["x-capstone-client-ip"];
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
    delete request.headers[header];
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
    throw new ApplicationError(
      400,
      "BAD_REQUEST",
      "No se pudo validar el origen de red de la solicitud.",
    );
  }
  return address;
}

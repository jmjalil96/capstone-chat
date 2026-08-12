import type { FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";
import { createTrustedAuthHeaders } from "../src/auth/request-headers.js";
import {
  captureTrustedClientAddress,
  resolveTrustedClientAddress,
} from "../src/security/client-address.js";

function request(
  headers: Record<string, string | string[] | undefined>,
  ip = "127.0.0.1",
  remoteAddress = ip,
  url = "/api/session",
): FastifyRequest {
  return {
    headers: { ...headers },
    ip,
    raw: { socket: { remoteAddress } },
    url,
  } as unknown as FastifyRequest;
}

describe("trusted client address", () => {
  it("keeps local socket identity and strips browser forwarding claims", () => {
    const local = request({
      "cf-connecting-ip": "198.51.100.10",
      "do-connecting-ip": "198.51.100.9",
      "x-capstone-client-ip": "198.51.100.11",
      "x-forwarded-for": "198.51.100.12",
    });

    captureTrustedClientAddress(local, "socket");
    const forwarded = createTrustedAuthHeaders(local);

    expect(resolveTrustedClientAddress(local)).toBe("127.0.0.1");
    expect(local.headers["x-capstone-client-ip"]).toBeUndefined();
    expect(local.headers["do-connecting-ip"]).toBeUndefined();
    expect(forwarded.get("x-capstone-client-ip")).toBe("127.0.0.1");
    expect(forwarded.has("cf-connecting-ip")).toBe(false);
    expect(forwarded.has("x-forwarded-for")).toBe(false);
  });

  it.each([
    ["198.51.100.20", "198.51.100.20"],
    ["2001:0DB8:0:0:0:0:0:1", "2001:db8::1"],
  ])("accepts one Caddy-sanitized address over loopback: %s", (value, expected) => {
    const production = request({
      "cf-connecting-ip": "203.0.113.5",
      "x-capstone-client-ip": value,
      "x-forwarded-for": "203.0.113.6, 203.0.113.7",
    });

    captureTrustedClientAddress(production, "caddy");

    expect(resolveTrustedClientAddress(production)).toBe(expected);
    expect(createTrustedAuthHeaders(production).get("x-capstone-client-ip")).toBe(expected);
    expect(production.headers["cf-connecting-ip"]).toBeUndefined();
    expect(production.headers["x-forwarded-for"]).toBeUndefined();
  });

  it.each([
    undefined,
    "",
    "not-an-address",
    "fe80::1%eth0",
    "198.51.100.1, 198.51.100.2",
    ["198.51.100.1", "198.51.100.2"],
  ])("fails closed for an invalid production edge address: %j", (value) => {
    const production = request({ "x-capstone-client-ip": value });

    captureTrustedClientAddress(production, "caddy");

    expect(() => resolveTrustedClientAddress(production)).toThrow(
      "No se pudo validar el origen de red",
    );
    expect(() => createTrustedAuthHeaders(production)).toThrow(
      "No se pudo validar el origen de red",
    );
  });

  it("rejects a private-header claim that did not arrive over the Caddy loopback", () => {
    const direct = request(
      { "x-capstone-client-ip": "198.51.100.20" },
      "198.51.100.99",
      "198.51.100.99",
    );

    captureTrustedClientAddress(direct, "caddy");

    expect(direct.headers["x-capstone-client-ip"]).toBeUndefined();
    expect(() => resolveTrustedClientAddress(direct)).toThrow(
      "No se pudo validar el origen de red",
    );
  });

  it.each([
    ["198.51.100.20", "198.51.100.20"],
    ["2001:0DB8:0:0:0:0:0:1", "2001:db8::1"],
  ])("accepts and normalizes one App Platform address: %s", (value, expected) => {
    const production = request({
      "cf-connecting-ip": "203.0.113.5",
      "do-connecting-ip": value,
      forwarded: "for=203.0.113.6",
      "x-capstone-client-ip": "203.0.113.7",
      "x-forwarded-arbitrary": "attacker-value",
      "x-real-ip": "203.0.113.8",
    });

    captureTrustedClientAddress(production, "digitalocean-app-platform");

    expect(resolveTrustedClientAddress(production)).toBe(expected);
    expect(createTrustedAuthHeaders(production).get("x-capstone-client-ip")).toBe(expected);
    expect(production.headers).toEqual({});
  });

  it.each([
    "",
    " 198.51.100.1",
    "198.51.100.1 ",
    "198.51.100.1\t",
    "not-an-address",
    "fe80::1%eth0",
    "198.51.100.1,198.51.100.2",
    ["198.51.100.1", "198.51.100.2"],
  ])("rejects an invalid present App Platform address even on health: %j", (value) => {
    const production = request(
      { "do-connecting-ip": value },
      "10.0.0.2",
      "10.0.0.2",
      "/api/health/live",
    );

    expect(() => captureTrustedClientAddress(production, "digitalocean-app-platform")).toThrow(
      "No se pudo validar el origen de red",
    );
    expect(production.headers["do-connecting-ip"]).toBeUndefined();
  });

  it("permits a missing App Platform address only on exact health routes", () => {
    for (const url of ["/api/health/live", "/api/health/ready"]) {
      expect(() =>
        captureTrustedClientAddress(
          request({}, "10.0.0.2", "10.0.0.2", url),
          "digitalocean-app-platform",
        ),
      ).not.toThrow();
    }
    for (const url of ["/", "/api/session", "/api/health/live?probe=1"]) {
      expect(() =>
        captureTrustedClientAddress(
          request({}, "10.0.0.2", "10.0.0.2", url),
          "digitalocean-app-platform",
        ),
      ).toThrow("No se pudo validar el origen de red");
    }
  });
});

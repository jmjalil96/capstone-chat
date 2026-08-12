import { once } from "node:events";
import { type AddressInfo, connect } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createEgressBootstrapServer } from "../src/egress-bootstrap-server.js";

const servers: ReturnType<typeof createEgressBootstrapServer>[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error === undefined ? resolve() : reject(error)));
        }),
    ),
  );
});

async function start() {
  const server = createEgressBootstrapServer({
    deploymentRevision: "a".repeat(40),
  });
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  return { origin: `http://127.0.0.1:${address.port}`, port: address.port };
}

async function rawRequest(port: number, target: string): Promise<string> {
  const socket = connect(port, "127.0.0.1");
  socket.setEncoding("utf8");
  let response = "";
  socket.on("data", (chunk: string) => {
    response += chunk;
  });
  await once(socket, "connect");
  socket.end(`GET ${target} HTTP/1.1\r\nHost: bootstrap.invalid\r\nConnection: close\r\n\r\n`);
  await once(socket, "close");
  return response;
}

describe("egress bootstrap server", () => {
  it.each(["/api/health/live", "/api/health/ready"])("serves only %s", async (path) => {
    const { origin } = await start();
    const response = await fetch(`${origin}${path}`);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-capstone-revision")).toBe("a".repeat(40));
    await expect(response.json()).resolves.toEqual({ status: "ready" });
  });

  it.each([
    "/",
    "/sign-in",
    "/api/session",
    "/api/health/ready?probe=1",
    "/api/health/ready/product",
  ])("returns a fixed 404 for %s", async (path) => {
    const { origin } = await start();
    const response = await fetch(`${origin}${path}`);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ status: "unavailable" });
  });

  it("returns the fixed 404 for a malformed absolute target and remains healthy", async () => {
    const { origin, port } = await start();
    const response = await rawRequest(port, "http://[");

    expect(response).toContain("HTTP/1.1 404 Not Found");
    expect(response).toContain('{"status":"unavailable"}');
    await expect(fetch(`${origin}/api/health/ready`)).resolves.toMatchObject({ status: 200 });
  });
});

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApplication } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import type { DatabasePool } from "../src/database/pool.js";
import { createKnownApplicationAssetValidator } from "../src/static-application.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

async function createWebFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "capstone-static-"));
  temporaryDirectories.push(root);
  await mkdir(join(root, "assets"));
  await writeFile(
    join(root, "index.html"),
    '<!doctype html><html lang="es"><body>shell<script src="/assets/app-abcdefgh.js"></script></body></html>',
  );
  await writeFile(join(root, "assets", "app-abcdefgh.js"), "globalThis.capstone = true;\n");
  await writeFile(join(root, "favicon.ico"), "icon");
  await writeFile(join(root, ".env"), "SHOULD_NOT_BE_SERVED=1\n");
  return root;
}

function createPool(): DatabasePool {
  return {
    end: vi.fn(async () => undefined),
    query: vi.fn(async () => ({ rows: [{ result: 1 }] })),
  };
}

describe("production static application", () => {
  it("serves emitted assets and limits the SPA fallback to browser navigation", async () => {
    const root = await createWebFixture();
    const config = Object.freeze({
      ...loadConfig({ NODE_ENV: "test" }),
      webAssetsDirectory: root,
    });
    const application = createApplication(config, { pool: createPool() });
    const isKnownApplicationAsset = createKnownApplicationAssetValidator(root);

    expect(isKnownApplicationAsset("app-abcdefgh.js")).toBe(true);
    expect(isKnownApplicationAsset("favicon.ico")).toBe(false);
    expect(isKnownApplicationAsset("unlisted-abcdefgh.js")).toBe(false);

    const asset = await application.server.inject({
      method: "GET",
      url: "/assets/app-abcdefgh.js",
    });
    expect(asset.statusCode).toBe(200);
    expect(asset.body).toBe("globalThis.capstone = true;\n");
    expect(asset.headers["content-type"]).toMatch(/javascript/u);
    expect(asset.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(asset.headers["x-content-type-options"]).toBe("nosniff");
    expect(asset.headers["content-security-policy"]).toContain("frame-ancestors 'none'");

    const shell = await application.server.inject({ method: "GET", url: "/" });
    expect(shell.statusCode).toBe(200);
    expect(shell.body).toContain("<body>shell");
    expect(shell.headers["cache-control"]).toBe("no-cache");

    const metadata = await application.server.inject({ method: "GET", url: "/favicon.ico" });
    expect(metadata.statusCode).toBe(200);
    expect(metadata.headers["cache-control"]).toBe("public, max-age=300, must-revalidate");

    const navigation = await application.server.inject({
      method: "GET",
      url: "/conversations/00000000-0000-4000-8000-000000000001",
    });
    expect(navigation.statusCode).toBe(200);
    expect(navigation.body).toContain("<body>shell");
    expect(navigation.headers["cache-control"]).toBe("no-cache");
    expect(navigation.headers["content-type"]).toMatch(/^text\/html/u);

    const navigationHead = await application.server.inject({ method: "HEAD", url: "/search" });
    expect(navigationHead.statusCode).toBe(200);
    expect(navigationHead.body).toBe("");
    expect(navigationHead.headers["cache-control"]).toBe("no-cache");

    const unknownApi = await application.server.inject({ method: "GET", url: "/api/unknown" });
    expect(unknownApi.statusCode).toBe(404);
    expect(unknownApi.json()).toMatchObject({ code: "NOT_FOUND" });
    expect(unknownApi.headers["cache-control"]).toBe("no-store");

    for (const url of ["/missing.js", "/.env", "/%2e%2e/.env", "/a/%2e%2e/.env"]) {
      const rejected = await application.server.inject({ method: "GET", url });
      expect(rejected.statusCode, url).toBe(404);
      expect(rejected.body, url).not.toContain("<body>shell");
    }

    const mutation = await application.server.inject({
      method: "POST",
      payload: {},
      url: "/conversations/example",
    });
    expect(mutation.statusCode).toBe(404);
    expect(mutation.body).not.toContain("<body>shell");

    await application.shutdown();
  });
});

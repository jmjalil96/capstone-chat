// @vitest-environment node

import { describe, expect, it } from "vitest";

import { createViteConfig } from "../vite.config";

describe("Vite development configuration", () => {
  it("serves the default trusted browser origin", () => {
    const config = createViteConfig({});

    expect(config.server).toMatchObject({
      host: "localhost",
      port: 5173,
      proxy: {
        "/api": {
          target: "http://127.0.0.1:3000",
        },
      },
    });
    expect(config.preview).toMatchObject({
      host: "127.0.0.1",
      port: 4173,
      proxy: {
        "/api": {
          target: "http://127.0.0.1:3000",
        },
      },
    });
  });

  it("injects only a validated deployment revision into the browser build", () => {
    expect(createViteConfig({ DEPLOYMENT_REVISION: "release-abc123" }).define).toEqual({
      "import.meta.env.VITE_DEPLOYMENT_REVISION": '"release-abc123"',
    });
    expect(
      createViteConfig({ DEPLOYMENT_REVISION: "https://deployment.example/private" }).define,
    ).toEqual({
      "import.meta.env.VITE_DEPLOYMENT_REVISION": '"unknown"',
    });
  });

  it("emits build metadata for the production bundle audit", () => {
    const config = createViteConfig({});

    expect(config.build).toMatchObject({ manifest: true });
    expect(config.plugins).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "capstone-bundle-evidence" })]),
    );
  });
});

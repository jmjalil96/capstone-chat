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
  });
});

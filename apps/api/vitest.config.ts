import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    fileParallelism: false,
    hookTimeout: 120_000,
    include: ["tests/**/*.test.ts"],
    testTimeout: 120_000,
  },
});

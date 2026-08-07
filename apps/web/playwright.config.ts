import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: "http://127.0.0.1:4173",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: "pnpm --filter @capstone/api exec tsx tests/support/identity-e2e-server.ts",
      url: "http://127.0.0.1:3011/api/health/ready",
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: "PORT=3011 pnpm exec vite --host 127.0.0.1 --port 4173",
      url: "http://127.0.0.1:4173",
      reuseExistingServer: false,
    },
  ],
  projects: [
    {
      name: "chromium",
      use: devices["Desktop Chrome"],
    },
    {
      name: "firefox-critical-streams",
      grep: /@critical-stream/u,
      use: devices["Desktop Firefox"],
    },
    {
      name: "webkit-critical-streams",
      grep: /@critical-stream/u,
      use: devices["Desktop Safari"],
    },
  ],
});

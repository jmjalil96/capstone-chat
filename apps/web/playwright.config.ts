import { defineConfig, devices } from "@playwright/test";

const extendedBrowsers = Boolean(process.env.CI || process.env.CAPSTONE_EXTENDED_BROWSERS);
const criticalFlow = /@critical-(?:access|accessibility|identity|stream)/u;

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
      command: "exec ../api/node_modules/.bin/tsx ../api/tests/support/identity-e2e-server.ts",
      url: "http://127.0.0.1:3011/api/health/ready",
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: "PORT=3011 pnpm exec vite preview --host 127.0.0.1 --port 4173",
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
      grep: criticalFlow,
      use: devices["Desktop Firefox"],
    },
    {
      name: "webkit-critical-streams",
      grep: criticalFlow,
      use: devices["Desktop Safari"],
    },
    ...(extendedBrowsers
      ? [
          {
            name: "chrome-critical",
            grep: criticalFlow,
            use: { ...devices["Desktop Chrome"], channel: "chrome" as const },
          },
          {
            name: "edge-critical",
            grep: criticalFlow,
            use: { ...devices["Desktop Edge"], channel: "msedge" as const },
          },
          {
            name: "iphone-webkit-critical",
            grep: criticalFlow,
            use: devices["iPhone 15"],
          },
          {
            name: "android-chrome-critical",
            grep: criticalFlow,
            use: devices["Pixel 7"],
          },
        ]
      : []),
  ],
});

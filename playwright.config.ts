import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false, // run sequentially — single server instance
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [["list"], ["html", { outputFolder: "playwright-report" }]],
  // Global timeout — smoke stubs should never need more than 15 s
  timeout: 15_000,

  use: {
    baseURL: "http://localhost:8800",
    trace: "retain-on-failure",
  },

  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],

  webServer: {
    command: "npm run dev",
    url: "http://localhost:8800",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});

import { defineConfig, devices } from "@playwright/test";

// The in-cluster console is normally port-forwarded to :8800 on an operator's
// laptop, which makes the default port unusable for a local suite run. CI sets
// nothing and keeps :8800.
const PORT = Number(process.env.E2E_PORT ?? 8800);
const BASE_URL = `http://localhost:${PORT}`;

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
    baseURL: BASE_URL,
    trace: "retain-on-failure",
  },

  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],

  webServer: {
    // In CI: `next build` already ran — boot the production server.
    // Locally: reuse whatever server is already running on the port.
    // Both invoke next directly rather than via `npm run`, so the port is not
    // passed twice (the package scripts pin their own).
    command: process.env.CI
      ? `npx next start --port ${PORT}`
      : `npx next dev --port ${PORT}`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});

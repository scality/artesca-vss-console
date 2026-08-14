import { defineConfig, devices } from "@playwright/test";

// The in-cluster console is normally port-forwarded to :8800 on an operator's
// laptop, and `reuseExistingServer` below is on locally — so a local run on
// :8800 attaches to whatever holds the port. Measured 2026-08-14: with a
// `kubectl port-forward` to the Pyramid showroom console up, the whole suite ran
// green against the **deployed pod** instead of the working tree, which is worse
// than a red run because it reads as proof. Local runs therefore default to a
// port nothing forwards to; CI has no port-forward and keeps :8800.
const PORT = Number(process.env.E2E_PORT ?? (process.env.CI ? 8800 : 8899));
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

// The AI Factory GPU mode as an operator sees it: the "VSS paused" banner on
// every page while the box is not in `vss` mode, the full-screen notice in
// kiosk mode, and the sidebar's AI Factory link in every mode.
//
// /api/box-mode is stubbed in the browser, so the spec is independent of any
// cluster; the server-side reader is covered by tests/unit/box-mode.test.ts.
import { test, expect, type Page } from "@playwright/test";

const LLM = { mode: "llm", pinned: true, updatedAt: "2026-10-01T10:40:29.227Z", source: "configmap", reason: null };
const VSS = { mode: "vss", pinned: false, updatedAt: null, source: "absent", reason: "ConfigMap ai-factory/gpu-mode not found" };

async function stubBoxMode(page: Page, body: object) {
  await page.route("**/api/box-mode", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) }),
  );
}

async function setKioskCookie(page: Page) {
  await page.context().addCookies([{ name: "kiosk", value: "1", domain: "localhost", path: "/" }]);
}

test.describe("box GPU mode (AI Factory)", () => {
  // Cold SSR of a page runs the cluster probes, which time out with no cluster
  // (see kiosk.spec.ts); /about is the lightest page that renders the Shell.
  test.beforeEach(() => test.setTimeout(45_000));

  test("llm mode: the banner names the pause and links to the AI Factory", async ({ page }) => {
    await stubBoxMode(page, LLM);
    await page.goto("/about");
    const banner = page.getByTestId("box-mode-banner");
    await expect(banner).toBeVisible({ timeout: 20_000 });
    await expect(banner).toContainText("VSS paused — the box is running the LLM (AI Factory)");
    await expect(banner).toContainText("pinned");
    const link = banner.getByRole("link", { name: /Open the AI Factory/ });
    await expect(link).toHaveAttribute("href", "http://localhost:4090");
    await expect(link).toHaveAttribute("target", "_blank");
  });

  test("vss mode: no banner, and the sidebar still links to the AI Factory", async ({ page }) => {
    await stubBoxMode(page, VSS);
    const answered = page.waitForResponse("**/api/box-mode");
    await page.goto("/about");
    await answered;
    const navLink = page.locator("nav").getByRole("link", { name: /AI Factory/ });
    await expect(navLink).toBeVisible({ timeout: 20_000 });
    await expect(navLink).toHaveAttribute("href", "http://localhost:4090");
    await expect(page.getByTestId("box-mode-banner")).toHaveCount(0);
  });

  test("llm mode in kiosk: a full-screen notice, with Exit kiosk still reachable", async ({ page }) => {
    await stubBoxMode(page, LLM);
    await setKioskCookie(page);
    await page.goto("/");
    const notice = page.getByTestId("box-mode-kiosk-notice");
    await expect(notice).toBeVisible({ timeout: 20_000 });
    await expect(notice.getByRole("heading")).toHaveText("VSS paused — the box is running the LLM (AI Factory)");
    await expect(notice.getByRole("link", { name: /Open the AI Factory/ })).toHaveAttribute("href", "http://localhost:4090");
    await expect(page.getByTestId("box-mode-banner")).toHaveCount(0);
    await expect(page.getByRole("link", { name: /Exit kiosk/ })).toBeVisible();
  });
});

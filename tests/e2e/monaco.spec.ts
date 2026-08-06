/**
 * Monaco has to come out of the image, not cdn.jsdelivr.net: the Pyramid
 * showroom runs on a node whose egress is not guaranteed, and editing the VLM
 * prompt is a core demo action (ISVD-586).
 *
 * These are infrastructure assertions about Monaco itself rather than about any
 * one page — `/prompt` is only the host. Both failures they cover are invisible
 * on a laptop, which is why neither could be left to the page suites:
 *
 *   1. Loading from the CDN. Every other Monaco test passes here, because a
 *      developer machine has egress. Only blocking the CDN separates "served by
 *      the app" from "happens to work".
 *   2. A language service that never starts. The editor still renders and still
 *      accepts typing, so the page looks entirely healthy while JSON validation,
 *      formatting and hover are dead on the scenario diff and the incident raw
 *      payload.
 */
import { test, expect, type Page } from "@playwright/test";

/** Monaco is served locally but is still a large AMD tree fetched and compiled
 *  on demand — more than the suite-wide 15 s allows on a cold server. */
const MONACO_BUDGET_MS = 45_000;

/** `/prompt` is the cheapest page that mounts an editor. */
async function promptPageWithoutCdn(page: Page) {
  const cdnAttempts: string[] = [];
  await page.route(/cdn\.jsdelivr\.net/, (route) => {
    cdnAttempts.push(route.request().url());
    return route.abort();
  });

  await page.route("/api/auth/session", (r) =>
    r.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ user: { name: "console-operator" } }),
    })
  );
  await page.route("/api/prompt", (r) =>
    r.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        prompt: "You are a retail security VLM.",
        model: "cosmos-reason2-8b",
        previewModel: "nvila-lite-2b",
      }),
    })
  );
  await page.route("/api/models", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: "[]" })
  );

  await page.goto("/prompt");
  return cdnAttempts;
}

test.describe("Monaco is served by the app", () => {
  test("the editor renders with cdn.jsdelivr.net unreachable", async ({ page }) => {
    test.setTimeout(MONACO_BUDGET_MS);
    const cdnAttempts = await promptPageWithoutCdn(page);

    // Rendered text, not just a mounted container: Monaco's wrapper div appears
    // whether or not the editor behind it ever loaded.
    const editor = page.locator(".monaco-editor").first();
    await expect(editor).toBeVisible({ timeout: 20_000 });
    await expect(editor.locator(".view-lines")).toContainText("retail security VLM");

    expect(
      cdnAttempts,
      "Monaco must come from the image; these requests went to the public CDN"
    ).toEqual([]);
  });

  test("a language service worker answers", async ({ page }) => {
    test.setTimeout(MONACO_BUDGET_MS);
    const cdnAttempts = await promptPageWithoutCdn(page);
    await page.locator(".monaco-editor").first().waitFor({ timeout: 20_000 });

    // Validation markers on malformed JSON are produced by the json language
    // service, which runs in a web worker created from a blob URL. A blob URL
    // has no base for a relative path to resolve against, so a root-relative
    // `paths.vs` leaves the worker unable to load itself — a marker is proof the
    // worker actually ran, where a 200 on its script would only prove the file
    // is served.
    const diagnosis = await page.evaluate(async () => {
      // @ts-expect-error monaco is assigned to window by its own AMD bundle
      const monaco = window.monaco;
      if (!monaco) return { ok: false, why: "window.monaco absent — Monaco never loaded" };

      const model = monaco.editor.createModel('{"a": 1,,}', "json");
      try {
        for (let i = 0; i < 40; i++) {
          await new Promise((resolve) => setTimeout(resolve, 250));
          const markers = monaco.editor.getModelMarkers({ resource: model.uri });
          if (markers.length) {
            return { ok: true, markers: markers.map((m: { message: string }) => m.message) };
          }
        }
        return { ok: false, why: "no validation markers after 10 s — the worker did not answer" };
      } finally {
        model.dispose();
      }
    });

    expect(diagnosis.ok, JSON.stringify(diagnosis)).toBe(true);
    expect(cdnAttempts).toEqual([]);
  });
});

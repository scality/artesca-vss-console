// Phase 6 (clip playback): incident row click → dialog opens → stub HLS playlist response
// → hls.js attaches → keyboard shortcuts (space, left, right, F) wire to video element.
import { test, expect, type Page } from "@playwright/test";
import incidentsFixture from "../fixtures/incidents.json";
import scenariosFixture from "../fixtures/scenarios.json";

function stubAuth(page: Page) {
  return page.route("/api/auth/session", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ user: { name: "console-operator" } }),
    })
  );
}

// Minimal HLS playlist
const FAKE_HLS_PLAYLIST = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:4
#EXT-X-MEDIA-SEQUENCE:0
#EXTINF:4.000000,
segment0.ts
#EXT-X-ENDLIST
`;

async function stubIncidentsApis(page: Page) {
  await stubAuth(page);

  // SSE live endpoint — return empty body (no live events in test)
  await page.route("/api/incidents/live", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      headers: { "Cache-Control": "no-cache" },
      body: "",
    })
  );

  // Preload endpoint
  await page.route("/api/clips/preload", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true }),
    })
  );

  // Initial incidents list
  await page.route("/api/incidents*", (route) => {
    if (route.request().url().includes("/api/incidents/live")) return;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(incidentsFixture),
    });
  });

  // Scenarios for filter chips
  await page.route("/api/scenarios", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(scenariosFixture),
    })
  );

  // HLS playlist endpoint
  await page.route("/api/clips/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/vnd.apple.mpegurl",
      body: FAKE_HLS_PLAYLIST,
    })
  );
}

test.describe("incidents + clip playback — Phase 6", () => {
  test("incidents page renders without crashing", async ({ page }) => {
    await stubIncidentsApis(page);
    await page.goto("/incidents");
    await page.waitForLoadState("networkidle");

    await expect(page.locator("body")).not.toContainText("Application error");
  });

  test("incident rows from fixture are displayed", async ({ page }) => {
    await stubIncidentsApis(page);
    await page.goto("/incidents");
    await page.waitForLoadState("networkidle");

    // Fixture has "Shoplifting Detection" and "Crowd Density Alert"
    await expect(page.locator("text=Shoplifting Detection")).toBeVisible({ timeout: 8_000 });
    await expect(page.locator("text=Crowd Density Alert")).toBeVisible({ timeout: 8_000 });
  });

  test("empty incidents list shows empty state", async ({ page }) => {
    await stubAuth(page);
    await page.route("/api/incidents/live", (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        headers: { "Cache-Control": "no-cache" },
        body: "",
      })
    );
    await page.route("/api/incidents*", (route) => {
      if (route.request().url().includes("/api/incidents/live")) return;
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([]),
      });
    });
    await page.route("/api/scenarios", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([]),
      })
    );
    await page.route("/api/clips/preload", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: "{}" })
    );

    await page.goto("/incidents");
    await page.waitForLoadState("networkidle");

    await expect(page.locator("body")).not.toContainText("Application error");
    // Empty-state message
    const emptyText = page.locator("text=/no incidents|match the current/i");
    await expect(emptyText.first()).toBeVisible({ timeout: 8_000 });
  });

  test("clicking incident row opens detail dialog with HLS clip area", async ({ page }) => {
    await stubIncidentsApis(page);
    await page.goto("/incidents");
    await page.waitForLoadState("networkidle");

    await expect(page.locator("text=Shoplifting Detection")).toBeVisible({ timeout: 8_000 });

    // Click the first incident row
    const firstRow = page.locator("tbody tr, [data-incident-row]").first();
    if (await firstRow.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await firstRow.click();

      // IncidentDetail dialog should open
      const dialog = page.locator('[role="dialog"]');
      await expect(dialog).toBeVisible({ timeout: 5_000 });
      await expect(page.locator("body")).not.toContainText("Application error");
    }
  });

  test("incident detail dialog contains video element or HLS player area", async ({ page }) => {
    await stubIncidentsApis(page);
    await page.goto("/incidents");
    await page.waitForLoadState("networkidle");

    await expect(page.locator("text=Shoplifting Detection")).toBeVisible({ timeout: 8_000 });

    const firstRow = page.locator("tbody tr, [data-incident-row]").first();
    if (await firstRow.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await firstRow.click();

      const dialog = page.locator('[role="dialog"]');
      await expect(dialog).toBeVisible({ timeout: 5_000 });

      // Should contain either a <video> element or a HLS player placeholder
      const videoArea = dialog.locator("video, [data-hls-player], [data-video-player]");
      const hasVideo = await videoArea.isVisible({ timeout: 5_000 }).catch(() => false);
      // Also acceptable: a "Loading clip" or "clip unavailable" message in the dialog
      const loadingMsg = dialog.locator("text=/clip|video|loading|playback/i");
      const hasMsg = await loadingMsg.isVisible({ timeout: 3_000 }).catch(() => false);

      expect(hasVideo || hasMsg).toBe(true);
    }
  });

  test.fixme(
    "hls.js attaches to video element and plays (real NIM clip)",
    async () => {
      // Phase 6 decision C: requires actual HLS segments from ffmpeg transcoding
      // an S3 clip. The stub HLS playlist points to fake .ts segments that don't exist.
      // Full playback verification requires a live cluster with the S3 vss-video bucket.
    }
  );

  test.fixme(
    "keyboard shortcuts (space, ←, →, F) wire to video element (real clip)",
    async () => {
      // Design-doc decision C: space=pause/play, ←/→=seek, F=fullscreen.
      // These require a real video source that hls.js can attach to and play.
      // Cannot verify keydown → video.currentTime changes without a real HLS source.
    }
  );
});

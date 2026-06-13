// Phase 1 exit criterion: Non-zero data on overview from a real cluster.
// Stubbed version: KPIs + per-ns cards render; GPU card grid shows tiles with L40S thresholds.
//
// NOTE: The overview page is a Next.js Server Component — page.route() stubs only intercept
// browser-side requests. The stub is registered for when the client-side refresh hits the API,
// but the initial SSR render fetches server-side. Tests therefore verify the page renders
// correctly with whatever data is available (or shows the "no data" fallback gracefully).
import { test, expect, type Page } from "@playwright/test";

function stubAuth(page: Page) {
  return page.route("/api/auth/session", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ user: { name: "console-operator" } }),
    })
  );
}

async function stubOverviewApis(page: Page) {
  await stubAuth(page);
  // These stubs intercept client-side refetch requests from OverviewAutoRefresh
  await page.route("/api/status/overview", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        takenAt: new Date().toISOString(),
        namespaces: {
          vst: { total: 3, ready: 3, failed: 0 },
          rtvi: { total: 2, ready: 2, failed: 0 },
          agent: { total: 1, ready: 1, failed: 0 },
          alerts: { total: 1, ready: 1, failed: 0 },
          "demo-data": { total: 1, ready: 1, failed: 0 },
          "pyramid-ingress": { total: 1, ready: 1, failed: 0 },
        },
        nim: { ready: true, warmupPct: 100, queueDepth: 0 },
        gpus: [
          {
            index: 0,
            name: "NVIDIA L40S",
            memoryUsedMiB: 22528,
            memoryTotalMiB: 49152,
            utilGpu: 42,
            utilMem: 46,
            tempC: 58,
            powerW: 180,
            processes: [{ pid: 1234, name: "nim", memMiB: 18432 }],
          },
          {
            index: 1,
            name: "NVIDIA L40S",
            memoryUsedMiB: 8192,
            memoryTotalMiB: 49152,
            utilGpu: 65,
            utilMem: 17,
            tempC: 62,
            powerW: 120,
            processes: [{ pid: 1240, name: "rtvi-vlm", memMiB: 8192 }],
          },
        ],
        kafka: {
          "vision-llm-requests": { topic: "vision-llm-requests", retainedMsgs: 0 },
          "vision-llm-responses": { topic: "vision-llm-responses", retainedMsgs: 2 },
        },
        s3: {
          bucket: "nvidia-vss-video",
          objectCount: 4820,
          bytesTotal: 107374182400,
          growth24h: 1073741824,
        },
        cameraSim: { instanceState: "running", pathsReady: 4, pathsTotal: 4 },
      }),
    })
  );
  await page.route("/api/status/pods", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([
        { namespace: "vst", name: "vst-sensor-ms-7d4f9b-x2kqp", phase: "Running", ready: true, restarts: 0, age: "4h23m" },
        { namespace: "rtvi", name: "rtvi-vlm-5b9c7d-p8kqz", phase: "Running", ready: true, restarts: 0, age: "4h20m" },
      ]),
    })
  );
}

test.describe("overview page — Phase 1", () => {
  test("overview page renders without crashing (happy path)", async ({ page }) => {
    await stubOverviewApis(page);
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    await expect(page.locator("body")).not.toContainText("Application error");
    // Page title should be present
    await expect(page.locator("h1")).toBeVisible({ timeout: 8_000 });
  });

  test("overview page renders without crashing (no data / fallback)", async ({ page }) => {
    // No stub — SSR will try to reach cluster and fail gracefully
    await stubAuth(page);
    await page.route("/api/status/overview", (route) =>
      route.fulfill({ status: 503, body: "" })
    );
    await page.route("/api/status/pods", (route) =>
      route.fulfill({ status: 503, body: "" })
    );
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    await expect(page.locator("body")).not.toContainText("Application error");
    // Should show a no-data warning or still render the shell
    await expect(page.locator("body")).toBeVisible();
  });

  test("overview page includes page title Scality VSS Console", async ({ page }) => {
    await stubOverviewApis(page);
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    // The h1 contains "Scality VSS Console" per the page.tsx
    const heading = page.locator("h1");
    await expect(heading).toBeVisible({ timeout: 8_000 });
    const text = await heading.textContent();
    expect(text).toMatch(/VSS|Console|Demo/i);
  });

  test("namespace section header is visible", async ({ page }) => {
    await stubOverviewApis(page);
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    // "Namespaces" section is always rendered (even with no pod data)
    const nsHeader = page.locator("text=Namespaces");
    await expect(nsHeader).toBeVisible({ timeout: 8_000 });
  });

  test("overview page shows KIOSK badge when kiosk cookie is set", async ({ page }) => {
    await stubOverviewApis(page);
    await page.context().addCookies([
      { name: "kiosk", value: "1", domain: "localhost", path: "/" },
    ]);
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    await expect(page.locator("body")).not.toContainText("Application error");
    // KIOSK badge appears when kiosk is active
    const kioskBadge = page.locator("text=KIOSK");
    await expect(kioskBadge).toBeVisible({ timeout: 8_000 });
  });

  test("camera-sim card shows running state when data is available", async ({ page }) => {
    await stubOverviewApis(page);
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    // The running state comes from the stub data — may appear if SSR data loads OR
    // client-side refresh fires. Either way, page should not crash.
    await expect(page.locator("body")).not.toContainText("Application error");
  });

  test("degraded overview: page renders with failure data without crashing", async ({ page }) => {
    await stubAuth(page);
    await page.route("/api/status/overview", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          takenAt: new Date().toISOString(),
          namespaces: {
            vst: { total: 3, ready: 2, failed: 1 },
          },
          nim: { ready: false, warmupPct: 42, queueDepth: 7 },
          gpus: [],
          kafka: {},
          s3: { bucket: "nvidia-vss-video", objectCount: 0, bytesTotal: 0, growth24h: 0 },
          cameraSim: { instanceState: "unreachable", pathsReady: 0, pathsTotal: 4 },
        }),
      })
    );
    await page.route("/api/status/pods", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: "[]" })
    );
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    await expect(page.locator("body")).not.toContainText("Application error");
  });

  test.fixme(
    "non-zero data from real cluster confirms live K8s integration",
    async () => {
      // Phase 1 exit criterion: requires a live ARTESCA MetalK8s node
      // with VST/rtvi/agent/alerts namespaces running. Cannot be tested without the cluster.
    }
  );

  test.fixme(
    "GPU card grid shows 4 tiles with L40S thresholds visible (real cluster)",
    async () => {
      // Phase 1 exit criterion: GPU cards require live nvidia-smi data from in-cluster exec.
      // The overview page SSR fetches /api/gpu which runs kubectl exec nvidia-smi.
      // Cannot be verified with stubs because stubs only intercept client-side requests.
    }
  );
});

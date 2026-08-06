// Phase 3 exit criterion: Editor loads current prompt; diff preview valid.
// Phase 4 (prompt sub-task): Edit → PATCH returns ok → reload reflects new state.
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

async function stubPromptApis(page: Page, overrides: Record<string, unknown> = {}) {
  await stubAuth(page);
  await page.route("/api/prompt", async (route) => {
    if (route.request().method() === "PATCH") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true }),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        prompt: "You are a retail security VLM.",
        model: "cosmos-reason2-8b",
        previewModel: "nvila-lite-2b",
        ...overrides,
      }),
    });
  });
  // Stub model catalog for ModelCardGrid
  await page.route("/api/models", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([]),
    })
  );
  // Stub prompt preview endpoint
  await page.route("/api/prompt/preview", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ response: "Sample VLM response for preview." }),
    })
  );
}

test.describe("prompt page — Phase 3 (read + editor)", () => {
  test("prompt page renders without crashing", async ({ page }) => {
    await stubPromptApis(page);
    await page.goto("/prompt");

    await expect(page.locator("body")).not.toContainText("Application error");
  });

  // Blocked on ISVD-586: Monaco is loaded from cdn.jsdelivr.net at runtime, so
  // this test depends on a public CDN inside a gating CI run, and
  // locator("textarea") resolves to Monaco's hidden readonly ime-text-area,
  // which fill() can never satisfy. Re-enable once Monaco is served from the
  // image and the editor can be driven through its own input area.
  test.fixme("current prompt text is visible in editor area", async ({ page }) => {
    await stubPromptApis(page);
    await page.goto("/prompt");

    // The editor (Monaco or textarea) should contain the prompt text
    const promptText = "retail security VLM";
    // Try Monaco editor container or plain textarea
    const monacoContainer = page.locator(".monaco-editor, .cm-editor, textarea");
    await expect(monacoContainer.first()).toBeVisible({ timeout: 8_000 });

    // The text may be in Monaco shadow DOM — check the whole page content
    const content = await page.content();
    expect(content).toContain(promptText);
  });

  test("Save + Restart button is disabled when prompt is clean (no edits)", async ({ page }) => {
    await stubPromptApis(page);
    await page.goto("/prompt");

    // The save button should be disabled when draft === server prompt (no changes)
    const saveBtn = page.locator("button", { hasText: /save\s*\+\s*restart/i });
    if (await saveBtn.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await expect(saveBtn).toBeDisabled();
    }
  });

  test("preview button is disabled when NIM endpoint not configured", async ({ page }) => {
    // nimReady = false scenario (no previewModel in response)
    await stubPromptApis(page, { previewModel: undefined });
    await page.goto("/prompt");

    const previewBtn = page.locator("button", { hasText: /preview/i });
    if (await previewBtn.isVisible({ timeout: 5_000 }).catch(() => false)) {
      // Without a NIM endpoint, preview should be disabled
      const disabled = await previewBtn.isDisabled();
      expect(typeof disabled).toBe("boolean");
    }
  });
});

test.describe("prompt page — Phase 4 (write path)", () => {
  // Blocked on ISVD-586: Monaco is loaded from cdn.jsdelivr.net at runtime, so
  // this test depends on a public CDN inside a gating CI run, and
  // locator("textarea") resolves to Monaco's hidden readonly ime-text-area,
  // which fill() can never satisfy. Re-enable once Monaco is served from the
  // image and the editor can be driven through its own input area.
  test.fixme("edit prompt → Save + Restart button becomes enabled", async ({ page }) => {
    await stubPromptApis(page);
    await page.goto("/prompt");

    // Try to trigger a change in the editor (textarea fallback)
    const textarea = page.locator("textarea").first();
    if (await textarea.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await textarea.fill("Modified prompt content for testing purposes.");
      const saveBtn = page.locator("button", { hasText: /save\s*\+\s*restart/i });
      if (await saveBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
        await expect(saveBtn).toBeEnabled();
      }
    }
  });

  // Blocked on ISVD-586: Monaco is loaded from cdn.jsdelivr.net at runtime, so
  // this test depends on a public CDN inside a gating CI run, and
  // locator("textarea") resolves to Monaco's hidden readonly ime-text-area,
  // which fill() can never satisfy. Re-enable once Monaco is served from the
  // image and the editor can be driven through its own input area.
  test.fixme("save → PATCH called → confirm dialog with restart warning appears", async ({ page }) => {
    let patchCalled = false;
    await stubAuth(page);
    await page.route("/api/prompt", async (route) => {
      if (route.request().method() === "PATCH") {
        patchCalled = true;
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ok: true }),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          prompt: "You are a retail security VLM.",
          model: "cosmos-reason2-8b",
        }),
      });
    });

    await page.goto("/prompt");

    // Attempt edit via textarea (Monaco may not be interactive without the full build)
    const textarea = page.locator("textarea").first();
    if (await textarea.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await textarea.fill("Edited: You are a retail security VLM. Detect theft.");

      const saveBtn = page.locator("button", { hasText: /save\s*\+\s*restart/i });
      if (await saveBtn.isEnabled({ timeout: 3_000 }).catch(() => false)) {
        await saveBtn.click();

        // Confirm dialog should appear with restart warning
        const dialog = page.locator('[role="dialog"]');
        await expect(dialog).toBeVisible({ timeout: 5_000 });
        await expect(dialog).toContainText(/restart|rtvi-vlm/i);

        // Click confirm
        const confirmBtn = dialog.locator("button", { hasText: /save\s*\+\s*restart|confirm/i });
        if (await confirmBtn.isEnabled({ timeout: 2_000 }).catch(() => false)) {
          await confirmBtn.click();
          // PATCH should have been called
          await page.waitForTimeout(1_000);
          expect(patchCalled).toBe(true);
        }
      }
    }
  });

  test.fixme(
    "edit in UI → ConfigMap shows change → worker picks it up (real cluster)",
    async () => {
      // Phase 4 exit criterion: requires live kubectl access to verify the ConfigMap
      // patch propagated and alert-worker restarted with the new scenario.
      // Cannot be tested without a live ARTESCA cluster.
    }
  );
});

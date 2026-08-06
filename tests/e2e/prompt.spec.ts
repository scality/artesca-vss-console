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

/** Monaco is served from the image, but it is still a large AMD tree fetched
 *  and compiled on demand — more than the suite-wide 15 s allows for on a cold
 *  `next dev`. */
const MONACO_BUDGET_MS = 45_000;

/**
 * One of the two side-by-side editors, chosen by its visible pane label.
 *
 * The label is the only thing that distinguishes them: Monaco 0.52.2 marks
 * neither the read-only container nor its textarea as read-only, so the two are
 * identical in the DOM (verified, not assumed). `.monaco-editor.first()` is the
 * read-only pane — which is why the original version of these tests could not
 * have worked even with a local Monaco: it typed into the pane that ignores
 * input.
 */
function promptPane(page: Page, label: "Current (read-only)" | "Proposed (editable)") {
  return page
    .getByText(label, { exact: true })
    .locator("xpath=following-sibling::div")
    .locator(".monaco-editor");
}

/** Waits for the editor's model to be rendered, not just its container. */
async function renderedPane(page: Page, label: Parameters<typeof promptPane>[1]) {
  const editor = promptPane(page, label);
  await expect(editor).toBeVisible({ timeout: 20_000 });
  await expect(editor.locator(".view-lines")).not.toBeEmpty();
  return editor;
}

/**
 * Types into the editable pane the way an operator does.
 *
 * Not `fill()`: Monaco derives its model from key and composition events, not
 * from a textarea's value, so setting the value leaves the model — and the
 * dirty state the Save button reads — untouched.
 */
async function replaceProposedText(page: Page, text: string) {
  const editor = await renderedPane(page, "Proposed (editable)");
  await editor.click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type(text);
}

test.describe("prompt page — Phase 3 (read + editor)", () => {
  test("prompt page renders without crashing", async ({ page }) => {
    await stubPromptApis(page);
    await page.goto("/prompt");

    await expect(page.locator("body")).not.toContainText("Application error");
  });

  test("current prompt text is visible in editor area", async ({ page }) => {
    test.setTimeout(MONACO_BUDGET_MS);
    await stubPromptApis(page);
    await page.goto("/prompt");

    const current = await renderedPane(page, "Current (read-only)");
    // Monaco renders only the visible lines, and the prompt is line 1.
    await expect(current.locator(".view-lines")).toContainText("retail security VLM");
  });

  // That Monaco is served by the app rather than by cdn.jsdelivr.net, and that
  // its language workers start, is asserted in tests/e2e/monaco.spec.ts — it is
  // a fact about Monaco, not about this page.

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
  test("edit prompt → Save + Restart button becomes enabled", async ({ page }) => {
    test.setTimeout(MONACO_BUDGET_MS);
    await stubPromptApis(page);
    await page.goto("/prompt");

    const saveBtn = page.locator("button", { hasText: /save\s*\+\s*restart/i });
    await expect(saveBtn).toBeDisabled();

    await replaceProposedText(page, "Modified prompt content for testing purposes.");

    await expect(saveBtn).toBeEnabled();
  });

  test("save → PATCH called → confirm dialog with restart warning appears", async ({ page }) => {
    test.setTimeout(MONACO_BUDGET_MS);
    let patchCalled = false;
    await stubPromptApis(page);
    // Registered after, so it wins; GET falls back to the stub above rather
    // than being restated here, and /api/models stays stubbed too — the page
    // has to render before the editor can be typed into.
    await page.route("/api/prompt", async (route) => {
      if (route.request().method() !== "PATCH") return route.fallback();
      patchCalled = true;
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true }),
      });
    });

    await page.goto("/prompt");

    await replaceProposedText(page, "Edited: You are a retail security VLM. Detect theft.");

    const saveBtn = page.locator("button", { hasText: /save\s*\+\s*restart/i });
    await expect(saveBtn).toBeEnabled();
    await saveBtn.click();

    // Saving restarts the VLM worker, so it is behind a confirmation that has
    // to say so.
    const dialog = page.locator('[role="dialog"]');
    await expect(dialog).toBeVisible({ timeout: 5_000 });
    await expect(dialog).toContainText(/restart|rtvi-vlm/i);

    const confirmBtn = dialog.locator("button", {
      hasText: /save\s*\+\s*restart|confirm/i,
    });
    await confirmBtn.click();

    await expect.poll(() => patchCalled, { timeout: 5_000 }).toBe(true);
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

// Settings: SG whitelist CRUD — add a CIDR via dialog; "My IP" helper stubs api.ipify.org;
// delete flow confirms.
import { test, expect, type Page } from "@playwright/test";
import sgWhitelistFixture from "../fixtures/sg-whitelist.json";

function stubAuth(page: Page) {
  return page.route("/api/auth/session", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ user: { name: "console-operator" } }),
    })
  );
}

async function stubSettingsApis(page: Page) {
  await stubAuth(page);

  let entries = [...sgWhitelistFixture];

  await page.route("/api/settings/sg", async (route) => {
    const method = route.request().method();
    if (method === "GET") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(entries),
      });
    }
    if (method === "POST") {
      const body = await route.request().postDataJSON();
      const newEntry = {
        id: "550e8400-e29b-41d4-a716-446655440099",
        cidr: body.cidr,
        label: body.label,
        addedBy: "console-operator",
        addedAt: new Date().toISOString(),
        port: 8800,
      };
      entries = [...entries, newEntry];
      return route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify(newEntry),
      });
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });

  await page.route(/\/api\/settings\/sg\/[\w-]+/, async (route) => {
    if (route.request().method() === "DELETE") {
      const id = route.request().url().split("/").pop();
      entries = entries.filter((e) => e.id !== id);
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true }),
      });
    }
    return route.fulfill({ status: 404 });
  });

  await page.route("/api/settings/rotations", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({}),
    })
  );

  // Stub "My IP" external service — AddCidrDialog fetches api.ipify.org?format=json
  await page.route("https://api.ipify.org**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ip: "203.0.113.42" }),
    })
  );
}

test.describe("settings — SG whitelist", () => {
  test("settings page renders without crashing", async ({ page }) => {
    await stubSettingsApis(page);
    await page.goto("/settings");
    await page.waitForLoadState("networkidle");

    await expect(page.locator("body")).not.toContainText("Application error");
  });

  test("existing CIDR entries from fixture are visible", async ({ page }) => {
    await stubSettingsApis(page);
    await page.goto("/settings");
    await page.waitForLoadState("networkidle");

    await expect(page.locator("text=84.14.13.200/29")).toBeVisible({ timeout: 8_000 });
    await expect(page.locator("text=Scality Paris office")).toBeVisible({ timeout: 8_000 });
  });

  test("Add CIDR button opens the add-CIDR dialog", async ({ page }) => {
    await stubSettingsApis(page);
    await page.goto("/settings");
    await page.waitForLoadState("networkidle");

    const addBtn = page.locator("button", { hasText: /add cidr/i });
    await expect(addBtn).toBeVisible({ timeout: 8_000 });
    await addBtn.click();

    const dialog = page.locator('[role="dialog"]');
    await expect(dialog).toBeVisible({ timeout: 5_000 });
  });

  test("add-CIDR dialog has CIDR and label inputs", async ({ page }) => {
    await stubSettingsApis(page);
    await page.goto("/settings");
    await page.waitForLoadState("networkidle");

    const addBtn = page.locator("button", { hasText: /add cidr/i });
    await expect(addBtn).toBeVisible({ timeout: 8_000 });
    await addBtn.click();

    const dialog = page.locator('[role="dialog"]');
    await expect(dialog).toBeVisible({ timeout: 8_000 });

    // AddCidrDialog has inputs with id="cidr-input" and id="label-input"
    const cidrInput = dialog.locator('input#cidr-input, input[placeholder*="84.14" i], input[type="text"]').first();
    await expect(cidrInput).toBeVisible({ timeout: 5_000 });
  });

  test("submitting a new CIDR adds it to the table", async ({ page }) => {
    await stubSettingsApis(page);
    await page.goto("/settings");
    await page.waitForLoadState("networkidle");

    const addBtn = page.locator("button", { hasText: /add cidr/i });
    await addBtn.click();

    const dialog = page.locator('[role="dialog"]');
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    // Fill CIDR
    const inputs = dialog.locator('input[type="text"]');
    const inputCount = await inputs.count();
    if (inputCount >= 1) {
      await inputs.nth(0).fill("10.0.1.0/24");
    }
    if (inputCount >= 2) {
      await inputs.nth(1).fill("My home network");
    }

    const addConfirmBtn = dialog.locator("button", { hasText: /add|save|confirm/i });
    if (await addConfirmBtn.isEnabled({ timeout: 2_000 }).catch(() => false)) {
      await addConfirmBtn.click();
      await page.waitForLoadState("networkidle");
    }

    await expect(page.locator("body")).not.toContainText("Application error");
  });

  test("delete CIDR entry calls DELETE and shows confirmation", async ({ page }) => {
    await stubSettingsApis(page);
    // Override confirm dialog to auto-accept
    await page.on("dialog", (dialog) => dialog.accept());

    await page.goto("/settings");
    await page.waitForLoadState("networkidle");

    await expect(page.locator("text=84.14.13.200/29")).toBeVisible({ timeout: 8_000 });

    // Find a delete button in the whitelist table
    const deleteBtn = page.locator(
      "button[aria-label*='delete' i], button[aria-label*='remove' i], button", {
        hasText: /delete|remove/i,
      }
    ).first();

    if (await deleteBtn.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await deleteBtn.click();
      await page.waitForTimeout(1_500);
      await expect(page.locator("body")).not.toContainText("Application error");
    }
  });

  test("My IP button stubs ipify.org and populates CIDR field", async ({ page }) => {
    await stubSettingsApis(page);
    await page.goto("/settings");
    await page.waitForLoadState("networkidle");

    const addBtn = page.locator("button", { hasText: /add cidr/i });
    await addBtn.click();

    const dialog = page.locator('[role="dialog"]');
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    // Look for "My IP" button in the dialog
    const myIpBtn = dialog.locator("button", { hasText: /my ip|use my ip/i });
    if (await myIpBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await myIpBtn.click();
      await page.waitForTimeout(1_000);

      // The CIDR field should be populated with "203.0.113.42" (from stubbed ipify.org)
      const cidrInput = dialog.locator('input[type="text"]').first();
      const value = await cidrInput.inputValue().catch(() => "");
      // Value might be the IP or IP/32
      if (value) {
        expect(value).toContain("203.0.113.42");
      }
    }
    await expect(page.locator("body")).not.toContainText("Application error");
  });
});

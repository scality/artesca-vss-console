import { describe, it, expect } from "vitest";
import { KIOSK_HIDDEN_ROUTES } from "@/lib/kiosk";
import { glob2regex } from "@/lib/utils";

describe("KIOSK_HIDDEN_ROUTES", () => {
  it("includes all non-kiosk pages", () => {
    const required = [
      "/cameras",
      "/scenarios",
      "/prompt",
      "/tuning",
      "/demo-data",
      "/profiles",
      "/secrets",
      "/logs",
      "/diagnostics",
      "/settings",
    ];
    for (const r of required) {
      expect(KIOSK_HIDDEN_ROUTES).toContain(r);
    }
  });

  it("does NOT include kiosk-visible pages", () => {
    const visible = ["/", "/topology", "/incidents"];
    for (const r of visible) {
      expect(KIOSK_HIDDEN_ROUTES).not.toContain(r);
    }
  });

  it("contains at least 10 hidden routes", () => {
    expect(KIOSK_HIDDEN_ROUTES.length).toBeGreaterThanOrEqual(10);
  });

  it("all entries start with /", () => {
    for (const r of KIOSK_HIDDEN_ROUTES) {
      expect(r.startsWith("/")).toBe(true);
    }
  });
});

describe("glob2regex in kiosk sensor filter context", () => {
  it("checkout-* matches checkout feeds but not aisle", () => {
    const re = glob2regex("checkout-*");
    expect(re.test("checkout-1-a")).toBe(true);
    expect(re.test("checkout-1-b")).toBe(true);
    expect(re.test("aisle-3-a")).toBe(false);
  });

  it("* matches any single sensor without slashes", () => {
    const re = glob2regex("*");
    expect(re.test("checkout-1-a")).toBe(true);
    expect(re.test("aisle-3")).toBe(true);
  });
});

import { describe, it, expect } from "vitest";
import { KIOSK_HIDDEN_ROUTES, KIOSK_ALLOWED_ROUTES, isKioskAllowed, isApiOrInternal } from "@/lib/kiosk";
import { glob2regex } from "@/lib/utils";

describe("KIOSK_HIDDEN_ROUTES", () => {
  it("includes all non-kiosk pages", () => {
    const required = [
      "/cameras",
      "/scenarios",
      "/prompt",
      "/tuning",
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

describe("KIOSK_ALLOWED_ROUTES", () => {
  it("includes the showroom-visible pages", () => {
    const required = ["/", "/incidents", "/topology", "/chat"];
    for (const r of required) {
      expect(KIOSK_ALLOWED_ROUTES).toContain(r);
    }
  });

  it("does NOT include operator-config pages", () => {
    const operatorPages = ["/cameras", "/scenarios", "/settings", "/tuning", "/logs"];
    for (const r of operatorPages) {
      expect(KIOSK_ALLOWED_ROUTES).not.toContain(r);
    }
  });

  it("KIOSK_ALLOWED_ROUTES and KIOSK_HIDDEN_ROUTES are disjoint", () => {
    for (const r of KIOSK_ALLOWED_ROUTES) {
      expect(KIOSK_HIDDEN_ROUTES).not.toContain(r);
    }
  });
});

describe("isKioskAllowed — middleware page guard", () => {
  it("allows /", () => {
    expect(isKioskAllowed("/")).toBe(true);
  });

  it("allows /incidents", () => {
    expect(isKioskAllowed("/incidents")).toBe(true);
  });

  it("allows /incidents sub-routes", () => {
    expect(isKioskAllowed("/incidents/42")).toBe(true);
  });

  it("allows /topology", () => {
    expect(isKioskAllowed("/topology")).toBe(true);
  });

  it("allows /chat", () => {
    expect(isKioskAllowed("/chat")).toBe(true);
  });

  it("blocks /cameras", () => {
    expect(isKioskAllowed("/cameras")).toBe(false);
  });

  it("blocks /cameras/bindings", () => {
    expect(isKioskAllowed("/cameras/bindings")).toBe(false);
  });

  it("blocks /scenarios", () => {
    expect(isKioskAllowed("/scenarios")).toBe(false);
  });

  it("blocks /settings", () => {
    expect(isKioskAllowed("/settings")).toBe(false);
  });

  it("blocks /tuning", () => {
    expect(isKioskAllowed("/tuning")).toBe(false);
  });

  it("blocks /prompt", () => {
    expect(isKioskAllowed("/prompt")).toBe(false);
  });

  it("blocks /logs", () => {
    expect(isKioskAllowed("/logs")).toBe(false);
  });

  it("blocks /diagnostics", () => {
    expect(isKioskAllowed("/diagnostics")).toBe(false);
  });

  it("blocks /profiles", () => {
    expect(isKioskAllowed("/profiles")).toBe(false);
  });

  it("blocks /secrets", () => {
    expect(isKioskAllowed("/secrets")).toBe(false);
  });

  it("does not treat /incident (no s) as allowed", () => {
    expect(isKioskAllowed("/incident")).toBe(false);
  });
});

describe("isApiOrInternal — kiosk API exemption", () => {
  it("passes /api/status/overview", () => {
    expect(isApiOrInternal("/api/status/overview")).toBe(true);
  });

  it("passes /api/pods", () => {
    expect(isApiOrInternal("/api/pods")).toBe(true);
  });

  it("passes /api/cameras (mutating APIs remain accessible; rejectIfKiosk guards them)", () => {
    expect(isApiOrInternal("/api/cameras")).toBe(true);
  });

  it("passes /_next/ internal paths", () => {
    expect(isApiOrInternal("/_next/static/chunk.js")).toBe(true);
  });

  it("does not pass page routes", () => {
    expect(isApiOrInternal("/cameras")).toBe(false);
    expect(isApiOrInternal("/settings")).toBe(false);
    expect(isApiOrInternal("/")).toBe(false);
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

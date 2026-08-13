import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Module mocks — declared before any import that triggers the modules ──

vi.mock("@/lib/auth", () => ({
  auth: vi.fn().mockResolvedValue({ user: { name: "operator" } }),
}));

vi.mock("@/lib/kiosk-server", () => ({
  rejectIfKiosk: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/helpers/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/cluster-refs", () => ({
  CLUSTER: {
    grafana: {
      url: "https://10.0.0.1:8443/",
      user: "admin",
      password: "grafana-pw",
      loginHint: "sign in with the ARTESCA admin",
    },
  },
}));

import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { rejectIfKiosk } from "@/lib/kiosk-server";
import { auditLog } from "@/lib/helpers/audit";
import { CLUSTER } from "@/lib/cluster-refs";

import { POST } from "@/app/api/grafana-credential/route";

describe("POST /api/grafana-credential", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(auth).mockResolvedValue({ user: { name: "operator" } } as never);
    vi.mocked(rejectIfKiosk).mockResolvedValue(null);
    (CLUSTER as unknown as { grafana: { password: string } }).grafana.password = "grafana-pw";
  });

  it("returns the password to an authenticated operator", async () => {
    const res = await POST();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ password: "grafana-pw" });
  });

  it("records the reveal in the audit log, without the value", async () => {
    await POST();
    expect(auditLog).toHaveBeenCalledTimes(1);
    const [action, target, details] = vi.mocked(auditLog).mock.calls[0];
    expect(action).toBe("reveal");
    expect(target).toBe("grafana-password");
    expect(JSON.stringify(details)).not.toContain("grafana-pw");
  });

  it("refuses an unauthenticated caller and audits nothing", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    const res = await POST();
    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain("grafana-pw");
    expect(auditLog).not.toHaveBeenCalled();
  });

  // The showroom display runs in kiosk mode on an unattended screen. Serving a
  // credential there defeats the purpose of the mode.
  it("refuses in kiosk mode and audits nothing", async () => {
    vi.mocked(rejectIfKiosk).mockResolvedValue(
      NextResponse.json({ error: "kiosk mode is read-only" }, { status: 403 })
    );
    const res = await POST();
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain("grafana-pw");
    expect(auditLog).not.toHaveBeenCalled();
  });

  it("404s when no password is configured, rather than returning an empty one", async () => {
    (CLUSTER as unknown as { grafana: { password: string } }).grafana.password = "";
    const res = await POST();
    expect(res.status).toBe(404);
    expect(auditLog).not.toHaveBeenCalled();
  });

  it("forbids caching the response", async () => {
    const res = await POST();
    expect(res.headers.get("cache-control")).toContain("no-store");
  });
});

// A source scan, in the same idiom as the DSN-literal check in
// telemetry-config.test.ts. The route above can be perfect and the fix still
// undone by one edit to the page: `src/app/page.tsx` is a server component, so
// anything it renders or passes as a prop is in the HTML payload of every
// dashboard load, for every viewer, whether or not the UI masks it. That is the
// failure this whole change removes, and no runtime test on the route would
// notice it coming back.
describe("the overview does not put the Grafana password in its payload", () => {
  const pagePath = "src/app/page.tsx";
  const cardPath = "src/components/overview/GrafanaAccessCard.tsx";

  it("only ever reads grafana.password as a boolean in the server component", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(pagePath, "utf8");
    const uses = [...src.matchAll(/[^\s(]*grafana\.password/g)].map((m) => m[0]);
    // Every occurrence must be the argument of a Boolean() coercion.
    const bareUses = uses.filter(
      (u) => !new RegExp(`Boolean\\(\\s*${u.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\)`).test(src)
    );
    expect(bareUses).toEqual([]);
  });

  it("does not pass a password prop to the card", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(pagePath, "utf8");
    const usage = src.slice(src.indexOf("<GrafanaAccessCard"));
    const tag = usage.slice(0, usage.indexOf("/>") + 2);
    expect(tag).toContain("hasPassword={Boolean(");
    expect(tag).not.toMatch(/\bpassword=\{(?!Boolean)/);
  });

  it("the card declares no password prop to receive one through", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(cardPath, "utf8");
    const props = src.slice(src.indexOf("}: {"), src.indexOf("}) {"));
    expect(props).toContain("hasPassword: boolean");
    expect(props).not.toMatch(/^\s*password\s*:/m);
  });
});

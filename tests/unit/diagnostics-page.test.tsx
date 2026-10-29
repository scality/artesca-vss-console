// @vitest-environment jsdom
//
// Every "Run now" on /diagnostics must name a test the route knows and read the
// route's { exitCode, stdout } answer. The page used ids the route does not have
// (smoke-phase1 vs phase-smoke-1, kubectl-events vs get-events → 400) and read
// `exit`/`output`, so every card reported "fail" with an empty drawer.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import React, { act } from "react";
import { readFileSync } from "node:fs";
import path from "node:path";

const toast = vi.fn();
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast }) }));
vi.mock("@/components/KioskProvider", () => ({ useKiosk: () => ({ kiosk: false }) }));
vi.mock("@/components/Shell", () => ({ Shell: ({ children }: { children: React.ReactNode }) => children }));
vi.mock("@/components/diagnostics/VstStoragePanel", () => ({ VstStoragePanel: () => null }));
vi.mock("@/components/diagnostics/ConnectivityPanel", () => ({ ConnectivityPanel: () => null }));

import DiagnosticsPage from "@/app/diagnostics/page";

// The route's test ids, read from its DIAGNOSTICS map.
const routeSrc = readFileSync(path.resolve(__dirname, "../../src/app/api/diagnostics/[test]/route.ts"), "utf8");
const block = routeSrc.slice(routeSrc.indexOf("const DIAGNOSTICS"), routeSrc.indexOf("};", routeSrc.indexOf("const DIAGNOSTICS")));
const ROUTE_IDS = [...block.matchAll(/^\s+"([\w-]+)":/gm)].map((m) => m[1]);

describe("/diagnostics Run now", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    toast.mockReset();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const id = url.split("/").pop()!;
      if (init?.method !== "POST") return new Response("[]", { status: 404 });
      return ROUTE_IDS.includes(id)
        ? Response.json({ test: id, exitCode: 0, stdout: "ok", stderr: "" })
        : Response.json({ error: `Unknown test: ${id}` }, { status: 400 });
    }));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("every card runs a test the route knows and reports its pass", async () => {
    expect(ROUTE_IDS.length).toBeGreaterThan(5);
    act(() => root.render(<DiagnosticsPage />));
    const buttons = [...container.querySelectorAll("button")].filter((b) => b.textContent === "Run now");
    expect(buttons.length).toBe(ROUTE_IDS.length);

    await act(async () => {
      for (const b of buttons) b.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const titles = toast.mock.calls.map(([t]) => t.title as string);
    expect(titles).toHaveLength(buttons.length);
    for (const t of titles) expect(t).toMatch(/— pass$/);
  });
});

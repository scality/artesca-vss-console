// @vitest-environment jsdom
//
// The /incidents Scenario filter is fed by GET /api/scenarios, which answers
// { scenarios: [...] }. The page parsed the body as a bare array, the parse
// threw, the option list stayed empty and the dropdown stayed disabled.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import React, { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/components/KioskProvider", () => ({ useKiosk: () => ({ kiosk: false }) }));
vi.mock("@/components/Shell", () => ({ Shell: ({ children }: { children: React.ReactNode }) => children }));
vi.mock("@/app/incidents/use-incident-stream", () => ({
  useIncidentStream: () => ({ streamStatus: "open", sseFailed: false, lastEventAt: null }),
}));

import IncidentsPage from "@/app/incidents/page";

describe("/incidents scenario filter", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.stubGlobal("fetch", vi.fn(async (url: string) =>
      String(url).startsWith("/api/scenarios")
        ? Response.json({ scenarios: [{ id: "theft", name: "Shelf theft" }], warnings: [] })
        : Response.json({ incidents: [] }),
    ));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("lists the scenarios from GET /api/scenarios", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <IncidentsPage />
        </QueryClientProvider>,
      );
    });
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });

    const trigger = [...container.querySelectorAll("button")].find((b) => b.textContent?.startsWith("Scenario"));
    expect(trigger, "scenario dropdown").toBeTruthy();
    expect(trigger!.disabled).toBe(false);
    await act(async () => { trigger!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(container.textContent).toContain("Shelf theft");
  });
});

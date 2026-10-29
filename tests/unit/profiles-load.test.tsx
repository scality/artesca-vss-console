// @vitest-environment jsdom
//
// GET /api/profiles/<name> answers { profile }. The page used the envelope as
// the profile: the Load dialog read envelope.scenarios.length and threw,
// Duplicate posted an invalid body, Export saved the wrapper.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import React, { act } from "react";

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/components/KioskProvider", () => ({ useKiosk: () => ({ kiosk: false }) }));
vi.mock("@/components/Shell", () => ({ Shell: ({ children }: { children: React.ReactNode }) => children }));

import ProfilesPage from "@/app/profiles/page";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PROFILE = {
  name: "scene-a",
  savedAt: "2026-01-01T00:00:00.000Z",
  savedBy: "operator",
  scenarios: [],
  vlmPrompt: "describe",
  cameras: [],
  rtviTuning: {},
  alertTuning: {},
  nimModel: "vlm",
};

describe("/profiles Load", () => {
  let container: HTMLDivElement;
  let root: Root;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/profiles") {
        return Response.json({ profiles: [{ name: "scene-a", savedAt: PROFILE.savedAt, savedBy: "operator", numScenarios: 0, numCameras: 0, nimModel: "vlm" }] });
      }
      return init?.method === "PUT" ? Response.json({ ok: true }) : Response.json({ profile: PROFILE });
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  const click = (el: Element) => act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  const button = (scope: ParentNode, text: string) =>
    [...scope.querySelectorAll("button")].find((b) => b.textContent?.trim() === text)!;

  it("opens the dialog on the profile and PUTs its name", async () => {
    await act(async () => { root.render(<ProfilesPage />); });
    await click(button(container, "Load"));
    expect(document.body.textContent).toContain("Load profile: scene-a");

    await click(button(document.body, "Load profile"));
    // The dialog steps through six 400 ms progress labels before it calls onConfirm.
    const put = () => fetchMock.mock.calls.some(([, init]) => init?.method === "PUT");
    for (let i = 0; i < 80 && !put(); i++) {
      await act(async () => { await new Promise((r) => setTimeout(r, 100)); });
    }
    expect(fetchMock).toHaveBeenCalledWith("/api/profiles/scene-a", { method: "PUT" });
  }, 15_000);
});

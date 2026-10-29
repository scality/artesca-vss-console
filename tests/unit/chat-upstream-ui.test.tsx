// @vitest-environment jsdom
//
// /chat's "open upstream UI" button opened port 3000 on the console's own host,
// where the upstream agent UI is reachable only if someone exposed it there.
// It now opens VSS_AGENT_UI_URL and is absent when that is unset.

import { describe, it, expect, vi, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import React, { act } from "react";

vi.mock("@/components/Shell", () => ({ Shell: ({ children }: { children: React.ReactNode }) => <main>{children}</main> }));
vi.mock("@/components/MarkdownReport", () => ({ MarkdownReport: ({ markdown }: { markdown: string }) => <p>{markdown}</p> }));

import ChatPage from "@/app/chat/page";
import { BoxModeProvider } from "@/components/BoxModeProvider";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
Element.prototype.scrollTo = () => {}; // jsdom has none; the page auto-scrolls the transcript

const SET = "https://agent-ui.example/";

describe("/chat open upstream UI", () => {
  let root: Root | undefined;
  let container: HTMLDivElement;
  afterEach(() => {
    act(() => root?.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function render(agentUiUrl: string | null) {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ cameras: [], available: false, voices: [] })));
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <BoxModeProvider aiFactoryUrl={null} agentUiUrl={agentUiUrl}>
          <ChatPage />
        </BoxModeProvider>,
      );
    });
    return [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("open upstream UI"));
  }

  it("is absent when no upstream UI URL is configured", async () => {
    expect(await render(null)).toBeUndefined();
  });

  it("opens the configured URL", async () => {
    const open = vi.fn();
    vi.spyOn(window, "open").mockImplementation(open);
    const button = await render(SET);
    expect(button).toBeDefined();
    await act(async () => button!.click());
    expect(open).toHaveBeenCalledWith(SET, "_blank", "noopener,noreferrer");
  });
});

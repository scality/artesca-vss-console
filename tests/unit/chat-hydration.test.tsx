// @vitest-environment jsdom
//
// /chat seeds its transcript, camera scope and voice choice from localStorage
// in useState initializers. The server has no localStorage and rendered an
// empty page; the client's first render had the history, so hydration failed
// (React #418) and React threw the server HTML away.

import { describe, it, expect, vi, afterEach } from "vitest";
import { hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import React, { act } from "react";

vi.mock("@/components/Shell", () => ({ Shell: ({ children }: { children: React.ReactNode }) => <main>{children}</main> }));
vi.mock("@/components/MarkdownReport", () => ({ MarkdownReport: ({ markdown }: { markdown: string }) => <p>{markdown}</p> }));

import ChatPage from "@/app/chat/page";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
Element.prototype.scrollTo = () => {}; // jsdom has none; the page auto-scrolls the transcript

describe("/chat hydration", () => {
  let root: Root | undefined;
  afterEach(() => {
    act(() => root?.unmount());
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it("hydrates without a mismatch when a transcript is stored", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ cameras: [], available: false, voices: [] })));
    const container = document.createElement("div");
    document.body.appendChild(container);

    // Server render: nothing stored (the server cannot read localStorage).
    localStorage.clear();
    container.innerHTML = renderToString(<ChatPage />);

    localStorage.setItem("nvidia-vss-chat-history", JSON.stringify([{ role: "user", content: "hello", ts: "2026-01-01T00:00:00.000Z" }]));
    const onRecoverableError = vi.fn();
    await act(async () => {
      root = hydrateRoot(container, <ChatPage />, { onRecoverableError });
    });

    expect(onRecoverableError).not.toHaveBeenCalled();
    expect(container.textContent).toContain("hello");
  });
});

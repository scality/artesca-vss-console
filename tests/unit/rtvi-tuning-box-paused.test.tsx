// @vitest-environment jsdom
//
// While the box is not in `vss` mode, PATCH /api/tuning/rtvi answers 409 with
// the reason in `error`. The form threw a fixed "Patch failed", so the operator
// saw "Save failed: Patch failed" and never learned the box was paused.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import React, { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { pausedHeadline } from "@/lib/box-mode-shared";

const toast = vi.fn();
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast }) }));

import { RtviTuningForm } from "@/components/tuning/RtviTuningForm";

const PAUSED = `${pausedHeadline("llm")}. deployment/ns/vlm is scaled by the AI Factory GPU switch.`;

describe("RtviTuningForm save while the box is paused", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    toast.mockReset();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === "PATCH"
        ? Response.json({ error: PAUSED, paused: true }, { status: 409 })
        : Response.json({}),
    ));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  const click = (el: Element) => act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); });

  it("shows the 409's reason in the failure toast", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(<QueryClientProvider client={client}><RtviTuningForm /></QueryClientProvider>);
    });
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });

    // Make the form dirty: max_num_seqs 4 → 5.
    const input = container.querySelector<HTMLInputElement>('input[type="number"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "5");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });

    await click(container.querySelector('[aria-label="Save VLM tuning and restart the VLM"]')!);
    const confirm = [...document.body.querySelectorAll("button")].find((b) => b.textContent === "Confirm")!;
    await click(confirm);

    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Save failed", description: PAUSED }));
  });
});

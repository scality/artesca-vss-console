// @vitest-environment jsdom
//
// The topology camera-sim node's "Add Feed" posts to /api/cameras, whose
// AddCameraSchema takes { cameraId, feeds: [{ feedId, fileName, fileBase64 }] }.
// The form sent { id, feeds: [{ id, sensorId, source, rtspUrl, fileBase64 }] },
// so every submit came back 400 "Validation failed".

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import React, { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

import { CameraSimActionsRenderer } from "@/components/topology/node-content/action-renderers";

describe("topology Add Feed", () => {
  let container: HTMLDivElement;
  let root: Root;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    fetchMock = vi.fn(async () => Response.json({ ok: true, cameraId: "cam-a" }));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  const type = (el: HTMLInputElement, v: string) =>
    act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, v);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });

  it("posts the body /api/cameras validates", async () => {
    act(() => {
      root.render(
        <QueryClientProvider client={new QueryClient()}>
          <CameraSimActionsRenderer nodeId="camera-sim" runtimeState={undefined} snapshot={undefined} />
        </QueryClientProvider>,
      );
    });
    await type(container.querySelector<HTMLInputElement>("#sensor-id")!, "cam-a");
    await type(container.querySelector<HTMLInputElement>("#source-file")!, "clip.ts");
    const file = container.querySelector<HTMLInputElement>("#ts-upload")!;
    Object.defineProperty(file, "files", { value: [new File(["abc"], "clip.ts")] });
    await act(async () => {
      file.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 20));
    });

    const add = [...container.querySelectorAll("button")].find((b) => b.textContent === "Add Feed")!;
    expect(add.disabled).toBe(false);
    await act(async () => { add.dispatchEvent(new MouseEvent("click", { bubbles: true })); });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/cameras");
    expect(JSON.parse(init.body)).toEqual({
      cameraId: "cam-a",
      role: "other",
      feeds: [{ feedId: "default", fileName: "clip.ts", fileBase64: btoa("abc") }],
    });
  });
});

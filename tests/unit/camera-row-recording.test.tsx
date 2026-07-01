// @vitest-environment jsdom
/**
 * Unit tests for the per-camera recording toggle on CameraRow.  The toggle is
 * an icon-only button (VideoOff/Video) whose intent is carried by its `title`
 * attribute — "Recording ON — click to stop…" when enabled, "Recording OFF —
 * click to start…" when disabled.  Verifies:
 *   1. The button's title reflects the camera's current recording state
 *      (default ON when no recording override → "Recording ON").
 *   2. Clicking it PUTs /api/cameras/{id} with the flipped recording.enabled
 *      plus the preserved policy + retentionDays.
 *   3. A camera with recording.enabled=false renders the "Recording OFF" title
 *      and PUTs enabled:true.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot } from "react-dom/client";
import React, { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Camera } from "@/lib/types";

// React 19 gates the synchronous act(...) form on this flag; without it the
// call errors with "The current testing environment is not configured to
// support act(...)" and no-ops the render. The async act(async () => …) form
// used elsewhere doesn't need it, but this file renders synchronously.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// useToast is a side effect we don't assert on — stub it so the component
// renders without the Toaster provider.
const toastMock = vi.fn();
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: toastMock }),
}));

import { CameraRow } from "@/components/cameras/CameraRow";

// ── DOM helpers ───────────────────────────────────────────────────────────────

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

function renderRow(camera: Camera) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  act(() => {
    root.render(
      <QueryClientProvider client={qc}>
        <table>
          <tbody>
            <CameraRow camera={camera} eip="1.2.3.4" promptSets={[]} />
          </tbody>
        </table>
      </QueryClientProvider>,
    );
  });
}

// The recording toggle is icon-only — match it on the `title` attribute, which
// carries the operator-facing intent ("Recording ON…" / "Recording OFF…").
function findButtonByTitle(text: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll("button")).find((b) =>
    (b.getAttribute("title") ?? "").includes(text),
  ) as HTMLButtonElement | undefined;
}

const BASE_CAMERA: Camera = {
  id: "cam01",
  role: "checkout",
  description: "Checkout 1",
  feeds: [
    {
      id: "default",
      sensorId: "cam01",
      source: "rtsp",
      rtspUrl: "rtsp://1.2.3.4:8554/cam01",
      vstRegistered: true,
      replayReady: true,
    },
  ],
};

// ── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  toastMock.mockReset();
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true }),
    }),
  );
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("CameraRow recording toggle", () => {
  it("shows the 'Recording ON' toggle when the camera has no recording override", () => {
    renderRow(BASE_CAMERA);
    expect(findButtonByTitle("Recording ON")).toBeDefined();
    expect(findButtonByTitle("Recording OFF")).toBeUndefined();
  });

  it("shows the 'Recording OFF' toggle when recording is currently disabled", () => {
    renderRow({
      ...BASE_CAMERA,
      recording: { enabled: false, policy: "off", retentionDays: 7 },
    });
    expect(findButtonByTitle("Recording OFF")).toBeDefined();
    expect(findButtonByTitle("Recording ON")).toBeUndefined();
  });

  it("clicking the 'Recording ON' toggle PUTs recording.enabled=false with preserved policy", async () => {
    renderRow({
      ...BASE_CAMERA,
      recording: { enabled: true, policy: "always", retentionDays: 14 },
    });
    const btn = findButtonByTitle("Recording ON");
    expect(btn).toBeDefined();

    await act(async () => {
      btn!.click();
    });

    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/cameras/cam01");
    expect(opts.method).toBe("PUT");
    expect(JSON.parse(opts.body)).toEqual({
      recording: { enabled: false, policy: "always", retentionDays: 14 },
    });
  });

  it("clicking the 'Recording OFF' toggle PUTs recording.enabled=true", async () => {
    renderRow({
      ...BASE_CAMERA,
      recording: { enabled: false, policy: "off", retentionDays: 7 },
    });
    const btn = findButtonByTitle("Recording OFF");
    expect(btn).toBeDefined();

    await act(async () => {
      btn!.click();
    });

    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, opts] = fetchMock.mock.calls[0];
    expect(JSON.parse(opts.body).recording.enabled).toBe(true);
  });
});

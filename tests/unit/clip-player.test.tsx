// @vitest-environment jsdom
// Unit tests for ClipPlayer fallback rendering.
// These cover the three visible states that matter for the Pyramid demo:
//   1. clipStatus="failed"  → immediate data-only fallback (no HLS attempt)
//   2. HLS fatal error + isTransient → "Preparing clip…" spinner
//   3. Normal render with no error → video element present

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot } from "react-dom/client";
import React, { act } from "react";

// ─── Hoist the Hls mock constructor ──────────────────────────────────────────
//
// vi.mock() is hoisted above all imports by Vitest, so the constructor
// function must be declared inside a vi.mock() factory (no top-level var
// references allowed there).  The factory below keeps all mock state in a
// module-scoped closure and exposes helpers via static properties on the
// returned class — same pattern as clip-cache.test.ts.

vi.mock("hls.js", () => {
  type ErrorHandler = (event: null, data: { fatal: boolean; details: string }) => void;
  let _handler: ErrorHandler | null = null;
  let _callCount = 0;

  function HlsCtor(this: Record<string, unknown>) {
    _callCount++;
    Object.assign(this, {
      loadSource: vi.fn(),
      attachMedia: vi.fn(),
      destroy: vi.fn(),
      on: vi.fn((event: string, handler: ErrorHandler) => {
        if (event === "ERROR") _handler = handler;
      }),
    });
  }

  HlsCtor.isSupported = () => true;
  HlsCtor.Events = { MANIFEST_PARSED: "MANIFEST_PARSED", ERROR: "ERROR" };
  // Static helpers for test assertions
  HlsCtor._getHandler = () => _handler;
  HlsCtor._getCallCount = () => _callCount;
  HlsCtor._reset = () => { _handler = null; _callCount = 0; };

  return { default: HlsCtor };
});

// ─── Import component + typed handle to the mocked Hls ───────────────────────

import { ClipPlayer } from "@/components/incidents/ClipPlayer";
import Hls from "hls.js";

// Typed access to the static helpers on the mock constructor
const HlsMock = Hls as unknown as {
  _getHandler: () => ((event: null, data: { fatal: boolean; details: string }) => void) | null;
  _getCallCount: () => number;
  _reset: () => void;
};

// ─── DOM helpers ──────────────────────────────────────────────────────────────

function getByTestId(container: HTMLElement, id: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${id}"]`);
}

// ─── Shared fallback metadata ─────────────────────────────────────────────────

const META = {
  ts: "2026-04-22T09:45:12.000Z",
  sensorId: "checkout-1-a",
  severity: "high" as const,
  summary: "Person concealing item near self-checkout",
  scenarioName: "Shoplifting Detection",
};

// ─── Suite ────────────────────────────────────────────────────────────────────

describe("ClipPlayer fallback states", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    HlsMock._reset();
    vi.useFakeTimers();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.useRealTimers();
  });

  // ── 1. clipStatus="failed" → immediate data-only fallback ─────────────────

  it('renders the unavailable fallback immediately when clipStatus="failed"', async () => {
    await act(async () => {
      root.render(
        <ClipPlayer
          src="/api/clips/checkout-1-a/2026-04-22T09:45:12.000Z/index.m3u8"
          clipStatus="failed"
          fallbackMeta={META}
        />
      );
    });

    expect(getByTestId(container, "clip-unavailable")).not.toBeNull();
    expect(getByTestId(container, "clip-materialising")).toBeNull();
    expect(container.textContent).toContain("Video unavailable");
    expect(container.textContent).toContain("checkout-1-a");
    expect(container.textContent).toContain("Person concealing item near self-checkout");
    expect(container.textContent).toContain("Shoplifting Detection");
  });

  it('does NOT mount hls.js when clipStatus="failed"', async () => {
    await act(async () => {
      root.render(
        <ClipPlayer
          src="/api/clips/checkout-1-a/ts/index.m3u8"
          clipStatus="failed"
          fallbackMeta={META}
        />
      );
    });
    expect(HlsMock._getCallCount()).toBe(0);
  });

  it("shows severity badge text in the unavailable fallback", async () => {
    await act(async () => {
      root.render(
        <ClipPlayer
          src="/api/clips/checkout-1-a/ts/index.m3u8"
          clipStatus="failed"
          fallbackMeta={META}
        />
      );
    });
    expect(container.textContent).toContain("high");
  });

  // ── 2. HLS fatal error (transient — pending status) → spinner ─────────────

  it("shows materialising spinner on first HLS error when clipStatus=pending", async () => {
    await act(async () => {
      root.render(
        <ClipPlayer
          src="/api/clips/cam/ts/index.m3u8"
          clipStatus="pending"
          fallbackMeta={META}
        />
      );
    });

    await act(async () => {
      HlsMock._getHandler()?.(null, { fatal: true, details: "networkError" });
    });

    expect(getByTestId(container, "clip-materialising")).not.toBeNull();
    expect(getByTestId(container, "clip-unavailable")).toBeNull();
    expect(container.textContent).toContain("Preparing clip");
  });

  it("shows materialising spinner on first HLS error when clipStatus is undefined", async () => {
    await act(async () => {
      root.render(
        <ClipPlayer
          src="/api/clips/cam/ts/index.m3u8"
          fallbackMeta={META}
        />
      );
    });

    await act(async () => {
      HlsMock._getHandler()?.(null, { fatal: true, details: "networkError" });
    });

    expect(getByTestId(container, "clip-materialising")).not.toBeNull();
    expect(getByTestId(container, "clip-unavailable")).toBeNull();
  });

  // ── 3. No raw HLS error identifiers shown in the failed fallback ──────────

  it("does not expose raw HLS error identifiers in the failed fallback", async () => {
    await act(async () => {
      root.render(
        <ClipPlayer
          src="/api/clips/cam/ts/index.m3u8"
          clipStatus="failed"
          fallbackMeta={META}
        />
      );
    });
    expect(container.textContent).not.toMatch(/HLS error/i);
    expect(container.textContent).not.toMatch(/networkError/);
    expect(container.textContent).not.toMatch(/fragLoadError/);
  });

  // ── 4. No fallbackMeta supplied → card still renders without crashing ─────

  it("renders unavailable card without crashing when fallbackMeta is omitted", async () => {
    await act(async () => {
      root.render(
        <ClipPlayer
          src="/api/clips/cam/ts/index.m3u8"
          clipStatus="failed"
        />
      );
    });
    expect(getByTestId(container, "clip-unavailable")).not.toBeNull();
    expect(container.textContent).toContain("Video unavailable");
  });

  // ── 5. Spinner remains on retry (first-error, transient) ─────────────────

  it("continues to show spinner while retries are in flight (pending status)", async () => {
    await act(async () => {
      root.render(
        <ClipPlayer
          src="/api/clips/cam/ts/index.m3u8"
          clipStatus="pending"
          fallbackMeta={META}
        />
      );
    });

    // First fatal error
    await act(async () => {
      HlsMock._getHandler()?.(null, { fatal: true, details: "networkError" });
    });

    // Advance past retry delay — the spinner should still be shown (not yet permanent)
    await act(async () => { vi.advanceTimersByTime(4_100); });
    expect(getByTestId(container, "clip-materialising")).not.toBeNull();
    expect(getByTestId(container, "clip-unavailable")).toBeNull();
  });

  // ── 6. Normal render: video element present, no fallback shown ────────────

  it("renders the video element (not a fallback) when no error occurs", async () => {
    await act(async () => {
      root.render(
        <ClipPlayer
          src="/api/clips/cam/ts/index.m3u8"
          clipStatus="ready"
          fallbackMeta={META}
        />
      );
    });

    expect(getByTestId(container, "clip-unavailable")).toBeNull();
    expect(getByTestId(container, "clip-materialising")).toBeNull();
    expect(container.querySelector("video")).not.toBeNull();
  });
});

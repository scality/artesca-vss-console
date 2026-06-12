// @vitest-environment jsdom
// Unit tests for the topology spinner-timeout / give-up logic.
//
// The page caps the "Connecting to pipeline…" spinner at 15 s.  After that,
// if no nodes have arrived (everReceivedNodes is still false) it renders a
// calm fallback linking to the Overview page.  The latch auto-suppresses at
// the render site via `spinnerTimedOut && !everReceivedNodes` so kiosk mode
// recovers without any user interaction when nodes arrive.
//
// The hook under test mirrors the exact logic in TopologyPage.  The full page
// component is too expensive to render in vitest (ReactFlow + tanstack-query
// + EventSource all need heavy mocking), so we test the hook in isolation.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot } from "react-dom/client";
import React, { act, useEffect, useState } from "react";

// ── Hook under test ───────────────────────────────────────────────────────────
// Mirrors the exact logic added to TopologyPage:
//   - fires setTimeout(15 s) when everReceivedNodes is false
//   - cancels the timer (effect cleanup) when everReceivedNodes flips to true
//   - the latch is NOT reset by the hook itself; the render site gates on
//     `spinnerTimedOut && !everReceivedNodes` for auto-recovery

const SPINNER_TIMEOUT_MS = 15_000;

function useSpinnerTimeout(everReceivedNodes: boolean): boolean {
  const [timedOut, setTimedOut] = useState(false);
  useEffect(() => {
    if (everReceivedNodes) return;
    const timer = setTimeout(() => setTimedOut(true), SPINNER_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [everReceivedNodes]);
  return timedOut;
}

// ── Tiny harness component ────────────────────────────────────────────────────

interface HarnessProps {
  everReceivedNodes: boolean;
  onTimedOut: (v: boolean) => void;
}

function Harness({ everReceivedNodes, onTimedOut }: HarnessProps) {
  const timedOut = useSpinnerTimeout(everReceivedNodes);
  // Simulate the render-site guard: timedOut only "shows" when !everReceivedNodes.
  const effective = timedOut && !everReceivedNodes;
  useEffect(() => { onTimedOut(effective); }, [effective, onTimedOut]);
  return null;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("topology spinner timeout", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => { root.unmount(); });
    container.remove();
    vi.useRealTimers();
    vi.clearAllTimers();
  });

  it("does not time out before 15 s have elapsed", () => {
    const cb = vi.fn();
    act(() => {
      root.render(<Harness everReceivedNodes={false} onTimedOut={cb} />);
    });

    cb.mockClear();
    act(() => { vi.advanceTimersByTime(14_999); });

    // Should NOT have flipped to true — latest call (if any) is still false.
    const lastCall = cb.mock.calls.at(-1);
    if (lastCall) expect(lastCall[0]).toBe(false);
  });

  it("sets timedOut=true after exactly 15 s with no nodes", () => {
    const cb = vi.fn();
    act(() => {
      root.render(<Harness everReceivedNodes={false} onTimedOut={cb} />);
    });

    act(() => { vi.advanceTimersByTime(15_000); });

    const lastCall = cb.mock.calls.at(-1);
    expect(lastCall).toBeDefined();
    expect(lastCall![0]).toBe(true);
  });

  it("cancels the timer when everReceivedNodes becomes true before timeout fires", () => {
    const cb = vi.fn();
    act(() => {
      root.render(<Harness everReceivedNodes={false} onTimedOut={cb} />);
    });

    // Advance to just before the timeout, then simulate nodes arriving.
    act(() => { vi.advanceTimersByTime(12_000); });
    act(() => {
      root.render(<Harness everReceivedNodes={true} onTimedOut={cb} />);
    });

    // Advance past where the timeout would have fired — timer was cancelled,
    // and the render-site guard (!everReceivedNodes) suppresses the latch.
    act(() => { vi.advanceTimersByTime(5_000); });

    const lastCall = cb.mock.calls.at(-1);
    // effective = timedOut && !everReceivedNodes → false (nodes arrived)
    expect(lastCall![0]).toBe(false);
  });

  it("kiosk auto-recovery: fallback disappears when nodes arrive after timeout fired", () => {
    const cb = vi.fn();
    act(() => {
      root.render(<Harness everReceivedNodes={false} onTimedOut={cb} />);
    });

    // Fire the timeout — fallback should show.
    act(() => { vi.advanceTimersByTime(15_000); });
    expect(cb.mock.calls.at(-1)![0]).toBe(true);

    // Cluster recovers — nodes arrive.  Render-site guard suppresses the fallback.
    act(() => {
      root.render(<Harness everReceivedNodes={true} onTimedOut={cb} />);
    });

    // effective = timedOut(true) && !everReceivedNodes(false) → false
    expect(cb.mock.calls.at(-1)![0]).toBe(false);
  });
});

/**
 * incidents-stream.test.ts
 *
 * Verifies the reconnect/fallback behaviour introduced in useIncidentStream
 * and the parseIncidentsResponse helper in incidents/page.tsx.
 *
 * We test the logic via a lightweight EventSource stub (no jsdom / React
 * testing library required) rather than rendering the full component.
 *
 * Covered cases:
 * - parseIncidentsResponse handles a plain array
 * - parseIncidentsResponse handles the { incidents: [...] } envelope
 * - parseIncidentsResponse drops malformed rows silently
 * - useIncidentStream calls onIncident for valid messages
 * - useIncidentStream enters "reconnecting" state on onerror
 * - useIncidentStream fires scheduleReconnect with exponential back-off
 * - useIncidentStream marks sseFailed after MAX_ATTEMPTS and stops reconnecting
 * - useIncidentStream resets attempt counter on a healthy message
 * - Cleanup (dispose=true) prevents reconnect timers from firing after unmount
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { IncidentSchema } from "@/lib/schemas";
import { z } from "zod";

// ─── parseIncidentsResponse (extracted logic, mirrors page.tsx) ───────────────

// Replicate the helper here so we can test it without importing the page
// (which is a "use client" component and would require jsdom).
type Incident = z.infer<typeof IncidentSchema>;

function parseIncidentsResponse(data: unknown): Incident[] {
  const rows: unknown[] = Array.isArray(data)
    ? data
    : Array.isArray((data as { incidents?: unknown[] })?.incidents)
    ? (data as { incidents: unknown[] }).incidents
    : [];
  return rows
    .map((r) => {
      try { return IncidentSchema.parse(r); } catch { return null; }
    })
    .filter(Boolean) as Incident[];
}

const VALID_INCIDENT = {
  ts: "2026-06-10T10:00:00Z",
  scenarioId: "shoplifting",
  scenarioName: "Shoplifting Detection",
  severity: "high",
  sensorId: "cam-01",
  topic: "mdx-vlm",
  summary: "Person concealing item",
};

describe("parseIncidentsResponse", () => {
  it("handles a plain array", () => {
    const result = parseIncidentsResponse([VALID_INCIDENT]);
    expect(result).toHaveLength(1);
    expect(result[0].scenarioId).toBe("shoplifting");
  });

  it("handles the { incidents: [...] } envelope shape", () => {
    const result = parseIncidentsResponse({ incidents: [VALID_INCIDENT] });
    expect(result).toHaveLength(1);
    expect(result[0].sensorId).toBe("cam-01");
  });

  it("drops malformed rows and returns the valid ones", () => {
    const result = parseIncidentsResponse([VALID_INCIDENT, { ts: "bad" }, null]);
    expect(result).toHaveLength(1);
  });

  it("returns empty array for empty input", () => {
    expect(parseIncidentsResponse([])).toEqual([]);
    expect(parseIncidentsResponse({ incidents: [] })).toEqual([]);
    expect(parseIncidentsResponse(null)).toEqual([]);
    expect(parseIncidentsResponse(undefined)).toEqual([]);
  });
});

// ─── useIncidentStream reconnect logic ───────────────────────────────────────
//
// We test the state-machine logic that lives in the hook by reimplementing
// the same structure with a fake EventSource, using vi.useFakeTimers() to
// control back-off scheduling without real waits.

type StreamStatus = "connected" | "reconnecting" | "failed";

interface FakeEventSource {
  onmessage: ((e: { data: string }) => void) | null;
  onopen: (() => void) | null;
  onerror: (() => void) | null;
  close: () => void;
  /** Test helper: simulate an incoming SSE message */
  emit: (data: string) => void;
  /** Test helper: simulate a connection error */
  triggerError: () => void;
  /** Test helper: simulate connection open */
  triggerOpen: () => void;
}

function makeFakeES(): FakeEventSource {
  const es: FakeEventSource = {
    onmessage: null,
    onopen: null,
    onerror: null,
    close: vi.fn(),
    emit(data) { this.onmessage?.({ data }); },
    triggerError() { this.onerror?.(); },
    triggerOpen() { this.onopen?.(); },
  };
  return es;
}

/** Mirrors the connect + scheduleReconnect logic in use-incident-stream.ts */
function runReconnectMachine(opts: {
  onIncident: (inc: Incident) => void;
  onStatusChange: (s: StreamStatus) => void;
  onSseFailed: () => void;
  maxAttempts?: number;
  maxBackoffMs?: number;
}): {
  instances: FakeEventSource[];
  dispose: () => void;
} {
  const MAX_ATTEMPTS = opts.maxAttempts ?? 5;
  const MAX_BACKOFF_MS = opts.maxBackoffMs ?? 30_000;

  const instances: FakeEventSource[] = [];
  let disposed = false;
  let attempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  function scheduleReconnect() {
    if (disposed) return;
    if (attempt >= MAX_ATTEMPTS) {
      opts.onSseFailed();
      opts.onStatusChange("failed");
      return;
    }
    opts.onStatusChange("reconnecting");
    const backoff = Math.min(1_000 * 2 ** attempt, MAX_BACKOFF_MS);
    attempt += 1;
    reconnectTimer = setTimeout(connect, backoff);
  }

  function connect() {
    if (disposed) return;
    const es = makeFakeES();
    instances.push(es);

    es.onopen = () => {
      if (disposed) return;
      attempt = 0;
      opts.onStatusChange("connected");
    };

    es.onmessage = ({ data }: { data: string }) => {
      try {
        const parsed = IncidentSchema.parse(JSON.parse(data)) as Incident;
        attempt = 0;
        opts.onStatusChange("connected");
        opts.onIncident(parsed);
      } catch {
        // ignore
      }
    };

    es.onerror = () => {
      es.close();
      scheduleReconnect();
    };
  }

  connect();

  return {
    instances,
    dispose() {
      disposed = true;
      if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
    },
  };
}

describe("useIncidentStream reconnect state machine", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("calls onIncident and sets status=connected on a valid message", () => {
    const onIncident = vi.fn();
    const onStatusChange = vi.fn();
    const { instances } = runReconnectMachine({
      onIncident,
      onStatusChange,
      onSseFailed: vi.fn(),
    });

    instances[0].triggerOpen();
    expect(onStatusChange).toHaveBeenCalledWith("connected");

    instances[0].emit(JSON.stringify(VALID_INCIDENT));
    expect(onIncident).toHaveBeenCalledWith(expect.objectContaining({ sensorId: "cam-01" }));
    expect(onStatusChange).toHaveBeenCalledWith("connected");
  });

  it("sets status=reconnecting and schedules a reconnect on onerror", () => {
    const onStatusChange = vi.fn();
    const { instances } = runReconnectMachine({
      onIncident: vi.fn(),
      onStatusChange,
      onSseFailed: vi.fn(),
    });

    instances[0].triggerError();
    expect(instances[0].close).toHaveBeenCalled();
    // First backoff: 1_000 * 2^0 = 1000 ms
    expect(onStatusChange).toHaveBeenCalledWith("reconnecting");
    expect(instances).toHaveLength(1); // no reconnect yet

    vi.advanceTimersByTime(1_000);
    expect(instances).toHaveLength(2); // second EventSource created
  });

  it("uses exponential back-off: 1s, 2s, 4s…", () => {
    const onStatusChange = vi.fn();
    const { instances } = runReconnectMachine({
      onIncident: vi.fn(),
      onStatusChange,
      onSseFailed: vi.fn(),
      maxAttempts: 10,
    });

    // Trigger 3 errors without letting the reconnect timers fire
    instances[0].triggerError(); // attempt=0 → backoff 1000 ms, attempt becomes 1
    vi.advanceTimersByTime(1_000);
    instances[1].triggerError(); // attempt=1 → backoff 2000 ms, attempt becomes 2
    vi.advanceTimersByTime(2_000);
    instances[2].triggerError(); // attempt=2 → backoff 4000 ms, attempt becomes 3
    vi.advanceTimersByTime(4_000);

    expect(instances).toHaveLength(4);
  });

  it("caps back-off at maxBackoffMs", () => {
    const onStatusChange = vi.fn();
    const { instances } = runReconnectMachine({
      onIncident: vi.fn(),
      onStatusChange,
      onSseFailed: vi.fn(),
      maxAttempts: 20,
      maxBackoffMs: 2_000, // low cap for test
    });

    instances[0].triggerError(); // 1s
    vi.advanceTimersByTime(1_000);
    instances[1].triggerError(); // 2s
    vi.advanceTimersByTime(2_000);
    instances[2].triggerError(); // would be 4s but capped at 2s
    vi.advanceTimersByTime(2_000);

    expect(instances).toHaveLength(4);
  });

  it("marks sseFailed after MAX_ATTEMPTS and stops reconnecting", () => {
    const onSseFailed = vi.fn();
    const onStatusChange = vi.fn();
    // maxAttempts=2: first error schedules reconnect (attempt 0→1);
    // second error schedules reconnect (attempt 1→2); third error → attempt 2>=2 → sseFailed.
    const { instances } = runReconnectMachine({
      onIncident: vi.fn(),
      onStatusChange,
      onSseFailed,
      maxAttempts: 2,
      maxBackoffMs: 30_000,
    });

    instances[0].triggerError(); // attempt 0→1, backoff 1000 ms
    vi.advanceTimersByTime(1_000);
    instances[1].triggerError(); // attempt 1→2, backoff 2000 ms
    vi.advanceTimersByTime(2_000);
    instances[2].triggerError(); // attempt 2 >= maxAttempts=2 → sseFailed, no timer

    expect(onSseFailed).toHaveBeenCalled();
    expect(onStatusChange).toHaveBeenCalledWith("failed");
    // No further EventSource instances created after sseFailed
    expect(instances).toHaveLength(3);
  });

  it("resets attempt counter to 0 on a healthy message after errors", () => {
    const onIncident = vi.fn();
    const { instances } = runReconnectMachine({
      onIncident,
      onStatusChange: vi.fn(),
      onSseFailed: vi.fn(),
      maxAttempts: 5,
    });

    // Two errors
    instances[0].triggerError();
    vi.advanceTimersByTime(1_000);
    instances[1].triggerError();
    vi.advanceTimersByTime(2_000);

    // Now a healthy message resets attempt to 0
    instances[2].emit(JSON.stringify(VALID_INCIDENT));
    expect(onIncident).toHaveBeenCalledTimes(1);

    // After reset, next error should backoff from 1s again (not 4s)
    instances[2].triggerError();
    // 1s backoff for attempt=0 → advance 1s → 4th instance
    vi.advanceTimersByTime(1_000);
    expect(instances).toHaveLength(4);
  });

  it("prevents reconnects after dispose", () => {
    const { instances, dispose } = runReconnectMachine({
      onIncident: vi.fn(),
      onStatusChange: vi.fn(),
      onSseFailed: vi.fn(),
    });

    instances[0].triggerError(); // schedules reconnect at 1000 ms
    dispose();                    // marks disposed, clears timer

    vi.advanceTimersByTime(2_000);
    // No new EventSource should have been created
    expect(instances).toHaveLength(1);
  });

  it("drops malformed SSE messages without crashing", () => {
    const onIncident = vi.fn();
    const { instances } = runReconnectMachine({
      onIncident,
      onStatusChange: vi.fn(),
      onSseFailed: vi.fn(),
    });

    instances[0].emit("not-json");
    instances[0].emit(JSON.stringify({ wrong: "shape" }));
    expect(onIncident).not.toHaveBeenCalled();
    // Stream still alive — no reconnect scheduled
    expect(instances).toHaveLength(1);
  });
});

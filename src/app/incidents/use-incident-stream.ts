"use client";

/**
 * useIncidentStream — SSE subscription for /api/incidents/live
 *
 * Mirrors the proven topology-page pattern:
 * - Opens an EventSource and reconnects on error with exponential back-off
 *   (1 s → 2 s → 4 s … capped at 30 s, up to MAX_ATTEMPTS before marking
 *   sseFailed=true).
 * - While sseFailed, the caller should poll /api/incidents?limit=50 instead
 *   (done in page.tsx via a useQuery enabled: sseFailed).
 * - Exposes `streamStatus` so the "● Live" badge can reflect real state:
 *     "connected"    → green ● Live
 *     "reconnecting" → amber ● Reconnecting…
 *     "failed"       → amber ● Reconnecting… (polling active)
 * - `lastEventAt` tracks the timestamp of the most recent SSE incident so the
 *   badge can reflect reality rather than just connection readiness.
 * - Calls `onIncident` for each validated SSE event; caller owns dedup +
 *   state merge.
 * - Cleans up (close + clear timers) on unmount.
 */

import { useEffect, useRef, useState } from "react";
import { IncidentSchema } from "@/lib/schemas";
import type { Incident } from "@/lib/types";

export type StreamStatus = "connected" | "reconnecting" | "failed";

const MAX_ATTEMPTS = 5;
const MAX_BACKOFF_MS = 30_000;

interface UseIncidentStreamOptions {
  onIncident: (inc: Incident) => void;
}

interface UseIncidentStreamResult {
  streamStatus: StreamStatus;
  sseFailed: boolean;
  lastEventAt: Date | null;
}

export function useIncidentStream({
  onIncident,
}: UseIncidentStreamOptions): UseIncidentStreamResult {
  const [streamStatus, setStreamStatus] = useState<StreamStatus>("reconnecting");
  const [sseFailed, setSseFailed] = useState(false);
  const [lastEventAt, setLastEventAt] = useState<Date | null>(null);

  // Stable ref so the closure inside connect() always calls the latest onIncident
  // without re-running the effect when the caller memoises differently.
  const onIncidentRef = useRef(onIncident);
  useEffect(() => {
    onIncidentRef.current = onIncident;
  });

  useEffect(() => {
    let es: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    let disposed = false;

    function scheduleReconnect() {
      if (disposed) return;
      if (attempt >= MAX_ATTEMPTS) {
        setSseFailed(true);
        setStreamStatus("failed");
        return;
      }
      setStreamStatus("reconnecting");
      const backoff = Math.min(1_000 * 2 ** attempt, MAX_BACKOFF_MS);
      attempt += 1;
      reconnectTimer = setTimeout(connect, backoff);
    }

    function connect() {
      if (disposed) return;
      es = new EventSource("/api/incidents/live");

      es.onmessage = (event: MessageEvent<string>) => {
        try {
          const parsed = IncidentSchema.parse(JSON.parse(event.data)) as Incident;
          // Reset back-off on a healthy message
          attempt = 0;
          setSseFailed(false);
          setStreamStatus("connected");
          setLastEventAt(new Date());
          onIncidentRef.current(parsed);
        } catch {
          // Malformed event — ignore; keep the stream open.
        }
      };

      // Mark connected on open (before any message arrives) so the badge turns
      // green as soon as the HTTP connection is established.
      es.onopen = () => {
        if (disposed) return;
        attempt = 0;
        setSseFailed(false);
        setStreamStatus("connected");
      };

      es.onerror = () => {
        es?.close();
        es = null;
        scheduleReconnect();
      };
    }

    connect();

    return () => {
      disposed = true;
      if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
      es?.close();
    };
  }, []);

  return { streamStatus, sseFailed, lastEventAt };
}

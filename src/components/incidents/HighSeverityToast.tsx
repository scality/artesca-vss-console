"use client";

import { useEffect, useState, useCallback } from "react";
import type { Incident } from "@/lib/types";

const TOAST_DURATION_MS = 8_000;
const MAX_VISIBLE = 2;

interface ToastEntry {
  id: string;
  incident: Incident;
}

interface HighSeverityToastProps {
  /**
   * Changing this prop to a new Incident triggers a new corner banner.
   * Pass the most recent high-severity incident from the live SSE stream.
   * null = no trigger pending.
   */
  triggerIncident: Incident | null;
}

function thumbUrl(sensorId: string, ts: string): string {
  return `/api/clips/${encodeURIComponent(sensorId)}/${encodeURIComponent(ts)}/thumb`;
}

/**
 * Transient high-severity alert banners for kiosk mode.
 *
 * Mounted only in kiosk mode (/incidents?mode=kiosk). Each new high-severity
 * incident from the live SSE stream produces a corner banner (snapshot +
 * camera + scenario) that auto-dismisses after 8 s. A burst is debounced so
 * at most 2 banners are visible simultaneously — the oldest is dropped when
 * the cap is reached.
 */
export function HighSeverityToast({ triggerIncident }: HighSeverityToastProps) {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  useEffect(() => {
    if (!triggerIncident) return;
    const id = `${triggerIncident.ts}::${triggerIncident.sensorId}`;

    // eslint-disable-next-line react-hooks/set-state-in-effect
    setToasts((prev) => {
      // Deduplicate — the same incident should not produce two banners.
      if (prev.some((t) => t.id === id)) return prev;
      // Cap at MAX_VISIBLE: drop the oldest entry when at the limit.
      const capped =
        prev.length >= MAX_VISIBLE ? prev.slice(-(MAX_VISIBLE - 1)) : prev;
      return [...capped, { id, incident: triggerIncident }];
    });

    // Auto-dismiss after TOAST_DURATION_MS.
    const timer = setTimeout(() => dismiss(id), TOAST_DURATION_MS);
    return () => clearTimeout(timer);
  }, [triggerIncident, dismiss]);

  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2">
      {toasts.map(({ id, incident }) => (
        <div
          key={id}
          className="flex w-80 items-start gap-3 rounded-lg border border-red-200 bg-red-50 p-3 shadow-lg"
        >
          {/* Snapshot thumbnail */}
          <div className="h-14 w-20 shrink-0 overflow-hidden rounded bg-muted">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={thumbUrl(incident.sensorId, incident.ts)}
              alt={`${incident.sensorId} snapshot`}
              className="h-full w-full object-cover"
              onError={(e) => {
                (e.currentTarget as HTMLImageElement).style.display = "none";
              }}
            />
          </div>
          {/* Alert content */}
          <div className="min-w-0 flex-1">
            <p className="text-[10px] font-bold uppercase tracking-wide text-red-800">
              High Severity Alert
            </p>
            <p className="truncate text-sm font-semibold text-red-900">
              {incident.scenarioName}
            </p>
            <p className="truncate font-mono text-xs text-red-700">
              {incident.sensorId}
            </p>
          </div>
          {/* Dismiss button */}
          <button
            type="button"
            onClick={() => dismiss(id)}
            aria-label="Dismiss alert"
            className="shrink-0 rounded p-0.5 text-red-400 transition-colors hover:text-red-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500"
          >
            <span aria-hidden="true">✕</span>
          </button>
        </div>
      ))}
    </div>
  );
}

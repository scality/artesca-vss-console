"use client";

import { useEffect, useRef, useState, useMemo, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { Shell } from "@/components/Shell";
import { IncidentRow } from "@/components/incidents/IncidentRow";
import { IncidentDetail } from "@/components/incidents/IncidentDetail";
import {
  IncidentsFilters,
  DEFAULT_FILTERS,
  type FilterState,
  type TimeWindow,
} from "@/components/incidents/IncidentsFilters";
import { IncidentSchema } from "@/lib/schemas";
import type { Incident, Scenario } from "@/lib/types";
import { z } from "zod";
import { useIncidentStream } from "./use-incident-stream";

/**
 * Format elapsed seconds as a compact human-readable age string.
 * E.g. 3 → "3s", 75 → "1m 15s", 3725 → "1h 2m".
 */
export function formatAge(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m < 60) return s > 0 ? `${m}m ${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm > 0 ? `${h}h ${rm}m` : `${h}h`;
}

const TIME_WINDOW_MS: Record<TimeWindow, number> = {
  "15m": 15 * 60 * 1000,
  "1h": 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  all: Infinity,
};

function filterIncidents(incidents: Incident[], filters: FilterState): Incident[] {
  const now = Date.now();
  const windowMs = TIME_WINDOW_MS[filters.timeWindow];

  return incidents.filter((inc) => {
    // Time window
    if (windowMs !== Infinity) {
      const age = now - new Date(inc.ts).getTime();
      if (age > windowMs) return false;
    }
    // Scenario filter
    if (
      filters.scenarios.length > 0 &&
      !filters.scenarios.includes(inc.scenarioId)
    ) {
      return false;
    }
    // Severity filter
    if (
      filters.severities.length > 0 &&
      !filters.severities.includes(inc.severity)
    ) {
      return false;
    }
    // Sensor filter
    if (filters.sensors.length > 0 && !filters.sensors.includes(inc.sensorId)) {
      return false;
    }
    return true;
  });
}

const FILTERS_LS_KEY = "console:incidents:filters:v1";
const TIME_WINDOW_VALUES: TimeWindow[] = ["15m", "1h", "24h", "all"];
const SEVERITY_VALUES: Incident["severity"][] = ["low", "medium", "high"];

/** Read persisted filters from localStorage, coercing each field to a safe value. */
function loadPersistedFilters(): FilterState {
  try {
    const raw = localStorage.getItem(FILTERS_LS_KEY);
    if (!raw) return DEFAULT_FILTERS;
    const p = JSON.parse(raw) as Partial<FilterState>;
    return {
      scenarios: Array.isArray(p.scenarios)
        ? p.scenarios.filter((x): x is string => typeof x === "string")
        : [],
      sensors: Array.isArray(p.sensors)
        ? p.sensors.filter((x): x is string => typeof x === "string")
        : [],
      severities: Array.isArray(p.severities)
        ? p.severities.filter((x): x is Incident["severity"] =>
            SEVERITY_VALUES.includes(x as Incident["severity"])
          )
        : [],
      timeWindow: TIME_WINDOW_VALUES.includes(p.timeWindow as TimeWindow)
        ? (p.timeWindow as TimeWindow)
        : DEFAULT_FILTERS.timeWindow,
    };
  } catch {
    return DEFAULT_FILTERS;
  }
}

/** Parse the /api/incidents response, which may be a plain array or { incidents: [] } */
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

export default function IncidentsPage() {
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [filters, setFilters] = useState<FilterState>(DEFAULT_FILTERS);
  const [selected, setSelected] = useState<Incident | null>(null);

  // Hydrate persisted filters after mount (not a lazy initializer) so server
  // and first client render both start from DEFAULT_FILTERS — no hydration
  // mismatch. Save on every change so the selection survives reload/reconnect.
  const filtersHydrated = useRef(false);
  useEffect(() => {
    // Read persisted filters only after mount so SSR + first client render both
    // start from DEFAULT_FILTERS (no hydration mismatch). This is the localStorage
    // read-after-mount exception, not synchronous derived state.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setFilters(loadPersistedFilters());
    filtersHydrated.current = true;
  }, []);
  useEffect(() => {
    if (!filtersHydrated.current) return;
    try {
      localStorage.setItem(FILTERS_LS_KEY, JSON.stringify(filters));
    } catch {
      /* storage full / unavailable — non-critical */
    }
  }, [filters]);
  // 1-second ticker drives the freshness age label without depending on new events.
  const [now, setNow] = useState<number>(() => Date.now());
  const preloadFiredRef = useRef(false);

  /** Merge a new incident into state: prepend, deduplicate by ts+sensorId. */
  const mergeIncident = useCallback((inc: Incident) => {
    setIncidents((prev) => {
      const key = `${inc.ts}::${inc.sensorId}`;
      if (prev.some((i) => `${i.ts}::${i.sensorId}` === key)) return prev;
      return [inc, ...prev];
    });
  }, []);

  // SSE subscription with exponential back-off reconnect (topology-mirrored pattern).
  const { streamStatus, sseFailed, lastEventAt } = useIncidentStream({ onIncident: mergeIncident });

  // 1-second ticker so the freshness label stays accurate between events.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, []);

  // Initial fetch (SSR-style client fetch on mount)
  useQuery<Incident[]>({
    queryKey: ["incidents-initial"],
    queryFn: async () => {
      const res = await fetch("/api/incidents?limit=50");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: unknown = await res.json();
      const parsed = parseIncidentsResponse(data);
      setIncidents(parsed);
      return parsed;
    },
    staleTime: Infinity, // SSE handles updates after initial load
    refetchOnWindowFocus: false,
  });

  // Available scenarios for filter chips
  const { data: scenarios = [] } = useQuery<Pick<Scenario, "id" | "name">[]>({
    queryKey: ["scenarios-list"],
    queryFn: async () => {
      const res = await fetch("/api/scenarios");
      if (!res.ok) return [];
      const data = await res.json();
      return z
        .array(z.object({ id: z.string(), name: z.string() }))
        .parse(data);
    },
    staleTime: 5 * 60 * 1000,
  });

  // Polling fallback: while SSE is down, poll every 10 s so the timeline keeps
  // updating. Enabled only when sseFailed=true (SSE is active when false).
  useQuery<Incident[]>({
    queryKey: ["incidents-poll"],
    queryFn: async () => {
      const res = await fetch("/api/incidents?limit=50");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: unknown = await res.json();
      const parsed = parseIncidentsResponse(data);
      // Merge each polled incident so we don't drop items received via SSE
      // before the fallback kicked in. setIncidents full-replace would lose
      // SSE-received items that aren't yet in the server window.
      parsed.forEach(mergeIncident);
      return parsed;
    },
    refetchInterval: 10_000,
    staleTime: 0,
    enabled: sseFailed,
  });

  const filtered = useMemo(
    () => filterIncidents(incidents, filters),
    [incidents, filters]
  );

  // Distinct sensors seen in the loaded incidents — populates the Sensor dropdown.
  const availableSensors = useMemo(
    () => Array.from(new Set(incidents.map((i) => i.sensorId))).sort(),
    [incidents]
  );

  // Client-side preload: fire POST for top 10 incidents once after initial render
  useEffect(() => {
    if (preloadFiredRef.current || incidents.length === 0) return;
    preloadFiredRef.current = true;
    const top10 = incidents.slice(0, 10).map((i) => ({
      sensorId: i.sensorId,
      ts: i.ts,
    }));
    fetch("/api/clips/preload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clips: top10 }),
    }).catch(() => { /* non-critical */ });
  }, [incidents]);

  const handleRowClick = useCallback((inc: Incident) => {
    setSelected(inc);
  }, []);

  return (
    <Shell>
      <div className="space-y-4">
        {/* Header */}
        <div className="flex items-start justify-between flex-wrap gap-2">
          <div>
            <h1 className="text-2xl font-bold">Incidents</h1>
            <p className="text-sm text-muted-foreground">
              {filtered.length} incident{filtered.length !== 1 ? "s" : ""}{" "}
              {incidents.length > filtered.length &&
                `(${incidents.length} total)`}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {streamStatus === "connected" ? (
              <span className="inline-flex items-center gap-1.5 text-xs text-emerald-700">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
                Live
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 text-xs text-amber-700">
                <span className="h-1.5 w-1.5 rounded-full bg-amber-500 animate-pulse" />
                Reconnecting…
              </span>
            )}
            {/* Freshness indicator: shows how long ago the last incident arrived.
                Turns amber after 60 s of quiet on a connected stream so showroom
                guests can tell "calm" from "stalled". Not shown when the stream is
                known-disconnected (the reconnect banner already covers that). */}
            {lastEventAt !== null && streamStatus === "connected" && (() => {
              const ageS = Math.floor((now - lastEventAt.getTime()) / 1_000);
              const stale = ageS >= 60;
              return (
                <span
                  className={`text-xs tabular-nums ${
                    stale ? "text-amber-700" : "text-muted-foreground"
                  }`}
                  title="Time since the last incident was received"
                >
                  last {formatAge(ageS)} ago
                </span>
              );
            })()}
          </div>
        </div>

        {/* Kiosk-friendly reconnect banner — non-modal, auto-clears when SSE recovers */}
        {streamStatus !== "connected" && (
          <div className="flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500 animate-pulse" />
            <span>
              Live stream interrupted — reconnecting
              {sseFailed ? " (polling for updates)" : "…"}
            </span>
          </div>
        )}

        {/* Filters */}
        <IncidentsFilters
          filters={filters}
          onChange={setFilters}
          availableScenarios={scenarios}
          availableSensors={availableSensors}
        />

        {/* Table */}
        <div className="rounded-lg border border-border overflow-hidden">
          {filtered.length === 0 ? (
            <div className="p-8 text-center text-sm text-muted-foreground">
              No incidents match the current filters.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-border bg-muted/30">
                    <th className="px-3 py-2 text-left text-xs font-medium uppercase text-muted-foreground">
                      Time
                    </th>
                    <th className="px-3 py-2 text-left text-xs font-medium uppercase text-muted-foreground">
                      Severity
                    </th>
                    <th className="px-3 py-2 text-left text-xs font-medium uppercase text-muted-foreground">
                      Scenario
                    </th>
                    <th className="px-3 py-2 text-left text-xs font-medium uppercase text-muted-foreground">
                      Sensor
                    </th>
                    <th className="px-3 py-2 text-left text-xs font-medium uppercase text-muted-foreground">
                      Summary
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((inc) => (
                    <IncidentRow
                      key={`${inc.ts}::${inc.sensorId}`}
                      incident={inc}
                      onClick={() => handleRowClick(inc)}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* Detail dialog */}
      <IncidentDetail incident={selected} onClose={() => setSelected(null)} />
    </Shell>
  );
}

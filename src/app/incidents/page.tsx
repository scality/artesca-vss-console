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
import { glob2regex } from "@/lib/utils";
import type { Incident, Scenario } from "@/lib/types";
import { z } from "zod";

const TIME_WINDOW_MS: Record<TimeWindow, number> = {
  "15m": 15 * 60 * 1000,
  "1h": 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  all: Infinity,
};

function filterIncidents(incidents: Incident[], filters: FilterState): Incident[] {
  const now = Date.now();
  const windowMs = TIME_WINDOW_MS[filters.timeWindow];
  const sensorRegex =
    filters.sensorGlob ? glob2regex(filters.sensorGlob) : null;

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
    // Sensor glob
    if (sensorRegex && !sensorRegex.test(inc.sensorId)) {
      return false;
    }
    return true;
  });
}

export default function IncidentsPage() {
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [filters, setFilters] = useState<FilterState>(DEFAULT_FILTERS);
  const [selected, setSelected] = useState<Incident | null>(null);
  const sseRef = useRef<EventSource | null>(null);
  const preloadFiredRef = useRef(false);

  // Initial fetch (SSR-style client fetch on mount)
  useQuery<Incident[]>({
    queryKey: ["incidents-initial"],
    queryFn: async () => {
      const res = await fetch("/api/incidents?limit=50");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const raw: unknown[] = await res.json();
      const parsed = raw
        .map((r) => {
          try { return IncidentSchema.parse(r); } catch { return null; }
        })
        .filter(Boolean) as Incident[];
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

  // SSE subscription for real-time appends
  useEffect(() => {
    const es = new EventSource("/api/incidents/live");
    sseRef.current = es;

    es.onmessage = (event) => {
      try {
        const parsed = IncidentSchema.parse(JSON.parse(event.data)) as Incident;
        setIncidents((prev) => {
          // Prepend newest, deduplicate by ts+sensorId
          const key = `${parsed.ts}::${parsed.sensorId}`;
          if (prev.some((i) => `${i.ts}::${i.sensorId}` === key)) return prev;
          return [parsed, ...prev];
        });
      } catch {
        // ignore malformed events
      }
    };

    return () => es.close();
  }, []);

  const filtered = useMemo(
    () => filterIncidents(incidents, filters),
    [incidents, filters]
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
            <span className="inline-flex items-center gap-1.5 text-xs text-green-400">
              <span className="h-1.5 w-1.5 rounded-full bg-green-500 animate-pulse" />
              Live
            </span>
          </div>
        </div>

        {/* Filters */}
        <IncidentsFilters
          filters={filters}
          onChange={setFilters}
          availableScenarios={scenarios}
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

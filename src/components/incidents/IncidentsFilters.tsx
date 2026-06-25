"use client";

import type { Scenario, Incident } from "@/lib/types";

export type TimeWindow = "15m" | "1h" | "24h" | "all";

export interface FilterState {
  scenarios: string[]; // scenarioId values; empty = all
  sensorGlob: string;
  severities: Array<Incident["severity"]>; // empty = all
  timeWindow: TimeWindow;
}

export const DEFAULT_FILTERS: FilterState = {
  scenarios: [],
  sensorGlob: "",
  severities: [],
  timeWindow: "1h",
};

interface IncidentsFiltersProps {
  filters: FilterState;
  onChange: (f: FilterState) => void;
  availableScenarios: Pick<Scenario, "id" | "name">[];
}

const TIME_WINDOWS: Array<{ value: TimeWindow; label: string }> = [
  { value: "15m", label: "15 min" },
  { value: "1h", label: "1 h" },
  { value: "24h", label: "24 h" },
  { value: "all", label: "All" },
];

const SEVERITIES: Array<Incident["severity"]> = ["low", "medium", "high"];

const SEVERITY_COLORS: Record<Incident["severity"], string> = {
  low: "text-blue-700 border-blue-200 bg-blue-50",
  medium: "text-amber-700 border-amber-200 bg-amber-50",
  high: "text-red-700 border-red-200 bg-red-50",
};

export function IncidentsFilters({
  filters,
  onChange,
  availableScenarios,
}: IncidentsFiltersProps) {
  function toggleScenario(id: string) {
    const next = filters.scenarios.includes(id)
      ? filters.scenarios.filter((s) => s !== id)
      : [...filters.scenarios, id];
    onChange({ ...filters, scenarios: next });
  }

  function toggleSeverity(sev: Incident["severity"]) {
    const next = filters.severities.includes(sev)
      ? filters.severities.filter((s) => s !== sev)
      : [...filters.severities, sev];
    onChange({ ...filters, severities: next });
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      {/* Time window */}
      <div className="flex items-center gap-1 rounded-lg border border-border bg-muted/30 p-0.5">
        {TIME_WINDOWS.map(({ value, label }) => (
          <button
            key={value}
            onClick={() => onChange({ ...filters, timeWindow: value })}
            className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${
              filters.timeWindow === value
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Severity filter */}
      <div className="flex gap-1">
        {SEVERITIES.map((sev) => (
          <button
            key={sev}
            onClick={() => toggleSeverity(sev)}
            className={`rounded border px-2 py-0.5 text-xs font-medium transition-all ${
              filters.severities.includes(sev)
                ? SEVERITY_COLORS[sev]
                : "border-border text-muted-foreground hover:border-border/80"
            }`}
          >
            {sev}
          </button>
        ))}
      </div>

      {/* Scenario filter */}
      {availableScenarios.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {availableScenarios.map((sc) => (
            <button
              key={sc.id}
              onClick={() => toggleScenario(sc.id)}
              className={`rounded border px-2 py-0.5 text-xs transition-colors ${
                filters.scenarios.includes(sc.id)
                  ? "border-primary/60 bg-primary/10 text-primary"
                  : "border-border text-muted-foreground hover:border-border/80"
              }`}
            >
              {sc.name}
            </button>
          ))}
        </div>
      )}

      {/* Sensor glob */}
      <input
        type="text"
        placeholder="sensor glob (e.g. checkout-*)"
        value={filters.sensorGlob}
        onChange={(e) => onChange({ ...filters, sensorGlob: e.target.value })}
        className="rounded border border-border bg-background px-2.5 py-1 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
      />

      {/* Clear */}
      {(filters.scenarios.length > 0 ||
        filters.severities.length > 0 ||
        filters.sensorGlob) && (
        <button
          onClick={() =>
            onChange({
              ...DEFAULT_FILTERS,
              timeWindow: filters.timeWindow,
            })
          }
          className="text-xs text-muted-foreground hover:text-foreground underline"
        >
          Clear filters
        </button>
      )}
    </div>
  );
}

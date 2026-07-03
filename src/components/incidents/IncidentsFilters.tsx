"use client";

import type { Scenario, Incident } from "@/lib/types";
import { MultiSelectDropdown } from "./MultiSelectDropdown";

export type TimeWindow = "15m" | "1h" | "24h" | "all";

export interface FilterState {
  scenarios: string[]; // scenarioId values; empty = all
  sensors: string[]; // sensorId values; empty = all
  severities: Array<Incident["severity"]>; // empty = all
  timeWindow: TimeWindow;
}

export const DEFAULT_FILTERS: FilterState = {
  scenarios: [],
  sensors: [],
  severities: [],
  timeWindow: "1h",
};

interface IncidentsFiltersProps {
  filters: FilterState;
  onChange: (f: FilterState) => void;
  availableScenarios: Pick<Scenario, "id" | "name">[];
  /** Distinct sensorIds seen in the currently-loaded incidents. */
  availableSensors: string[];
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
  availableSensors,
}: IncidentsFiltersProps) {
  function toggleSeverity(sev: Incident["severity"]) {
    const next = filters.severities.includes(sev)
      ? filters.severities.filter((s) => s !== sev)
      : [...filters.severities, sev];
    onChange({ ...filters, severities: next });
  }

  // Always include the currently-selected values as options, even if they're
  // not in the live set (e.g. a persisted selection whose incidents aren't
  // loaded yet) so the operator can always see and clear them.
  const scenarioLabelById = new Map(
    availableScenarios.map((s) => [s.id, s.name])
  );
  const scenarioOptions = Array.from(
    new Set([...availableScenarios.map((s) => s.id), ...filters.scenarios])
  ).map((id) => ({ value: id, label: scenarioLabelById.get(id) ?? id }));

  const sensorOptions = Array.from(
    new Set([...availableSensors, ...filters.sensors])
  )
    .sort()
    .map((s) => ({ value: s, label: s }));

  const hasActiveFilters =
    filters.scenarios.length > 0 ||
    filters.sensors.length > 0 ||
    filters.severities.length > 0;

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

      {/* Scenario filter (multi-select dropdown) */}
      <MultiSelectDropdown
        label="Scenario"
        options={scenarioOptions}
        selected={filters.scenarios}
        onChange={(next) => onChange({ ...filters, scenarios: next })}
        emptyHint="No scenarios available"
      />

      {/* Sensor filter (multi-select dropdown) */}
      <MultiSelectDropdown
        label="Sensor"
        options={sensorOptions}
        selected={filters.sensors}
        onChange={(next) => onChange({ ...filters, sensors: next })}
        emptyHint="No sensors in view"
      />

      {/* Clear */}
      {hasActiveFilters && (
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

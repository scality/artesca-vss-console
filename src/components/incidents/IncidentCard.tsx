"use client";

import type { Incident } from "@/lib/types";
import { formatAge } from "@/lib/format-age";

interface IncidentCardProps {
  incident: Incident;
  /** Current epoch (ms) — passed from the parent ticker so all cards update in
   *  sync without each mounting their own interval. */
  now: number;
  onClick: () => void;
}

const SEVERITY_BADGE: Record<Incident["severity"], string> = {
  low: "bg-blue-50 text-blue-700 border-blue-200",
  medium: "bg-amber-50 text-amber-700 border-amber-200",
  high: "bg-red-50 text-red-700 border-red-200",
};

function buildThumbUrl(sensorId: string, ts: string): string {
  return `/api/clips/${encodeURIComponent(sensorId)}/${encodeURIComponent(ts)}/thumb`;
}

export function IncidentCard({ incident, now, onClick }: IncidentCardProps) {
  const ts = new Date(incident.ts);
  const ageS = Math.max(0, Math.floor((now - ts.getTime()) / 1_000));
  const relTime = formatAge(ageS);
  const absTime = ts.toLocaleString();
  const thumbUrl = buildThumbUrl(incident.sensorId, incident.ts);

  return (
    <button
      type="button"
      onClick={onClick}
      className="group relative flex flex-col overflow-hidden rounded-lg border border-border bg-card text-left shadow-sm transition-all hover:shadow-md hover:border-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {/* Thumbnail — 16:9 aspect ratio */}
      <div className="relative aspect-video w-full overflow-hidden bg-muted">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={thumbUrl}
          alt={`Snapshot for ${incident.sensorId}`}
          loading="lazy"
          className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-105"
          onError={(e) => {
            // Hide broken image; the bg-muted fallback shows through.
            (e.currentTarget as HTMLImageElement).style.display = "none";
          }}
        />
        {/* Severity badge overlaid on thumbnail */}
        <span
          className={`absolute bottom-1.5 right-1.5 inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase backdrop-blur-sm ${SEVERITY_BADGE[incident.severity]}`}
        >
          {incident.severity}
        </span>
      </div>

      {/* Metadata block below the thumbnail */}
      <div className="flex flex-col gap-0.5 px-2 py-2">
        {/* Camera (sensorId) */}
        <p className="truncate font-mono text-xs font-medium text-foreground">
          {incident.sensorId}
        </p>
        {/* Scenario */}
        <p className="truncate text-xs text-muted-foreground">
          {incident.scenarioName}
        </p>
        {/* Relative time, absolute on hover via title */}
        <p
          className="text-[11px] tabular-nums text-muted-foreground"
          title={absTime}
        >
          {relTime} ago
        </p>
      </div>
    </button>
  );
}

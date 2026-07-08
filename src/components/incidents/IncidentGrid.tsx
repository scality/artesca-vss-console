"use client";

import type { Incident } from "@/lib/types";
import { IncidentCard } from "./IncidentCard";

interface IncidentGridProps {
  incidents: Incident[];
  /** Current epoch (ms) for relative-time labels — updated by the parent ticker. */
  now: number;
  onCardClick: (incident: Incident) => void;
}

export function IncidentGrid({ incidents, now, onCardClick }: IncidentGridProps) {
  if (incidents.length === 0) {
    return (
      <div className="p-8 text-center text-sm text-muted-foreground">
        No incidents match the current filters.
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
      {incidents.map((inc) => (
        <IncidentCard
          key={`${inc.ts}::${inc.sensorId}`}
          incident={inc}
          now={now}
          onClick={() => onCardClick(inc)}
        />
      ))}
    </div>
  );
}

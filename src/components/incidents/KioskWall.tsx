"use client";

import type { Incident } from "@/lib/types";
import type { StreamStatus } from "@/app/incidents/use-incident-stream";
import { IncidentCard } from "./IncidentCard";
import { formatAge } from "@/lib/format-age";

/** Maximum tiles displayed on the wall so it never scrolls. */
const KIOSK_MAX_TILES = 20;

interface KioskWallProps {
  /** Incidents to display — already filtered by the parent page (newest-first). */
  incidents: Incident[];
  /** Current epoch ms — passed from the parent's 1 s ticker so tiles update in sync. */
  now: number;
  /** SSE connection state — drives the LIVE badge colour. */
  streamStatus: StreamStatus;
  /** Timestamp of the most recent SSE event, for the "updated Xs ago" label. */
  lastEventAt: Date | null;
}

/**
 * Full-bleed kiosk video-wall — shown at /incidents?mode=kiosk.
 *
 * Renders a responsive grid of IncidentCards (thumbnail + severity + camera +
 * scenario + relative time), newest-first, capped to KIOSK_MAX_TILES so the
 * wall never scrolls. A slim status bar shows the live/reconnecting state and
 * how recently the last incident arrived.
 */
export function KioskWall({
  incidents,
  now,
  streamStatus,
  lastEventAt,
}: KioskWallProps) {
  const tiles = incidents.slice(0, KIOSK_MAX_TILES);

  const lastUpdatedAgoS =
    lastEventAt !== null
      ? Math.floor((now - lastEventAt.getTime()) / 1_000)
      : null;

  return (
    <div className="flex min-h-screen flex-col bg-background">
      {/* Slim status bar */}
      <div className="flex shrink-0 items-center gap-3 border-b border-border bg-card px-4 py-2">
        {streamStatus === "connected" ? (
          <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-emerald-700">
            <span className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
            LIVE
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-amber-700">
            <span className="h-2 w-2 rounded-full bg-amber-500 animate-pulse" />
            Reconnecting…
          </span>
        )}
        {lastUpdatedAgoS !== null && (
          <span className="text-xs tabular-nums text-muted-foreground">
            updated {formatAge(lastUpdatedAgoS)} ago
          </span>
        )}
        <span className="ml-auto text-xs text-muted-foreground">
          {tiles.length} incident{tiles.length !== 1 ? "s" : ""}
        </span>
      </div>

      {/* Incident grid */}
      <div className="flex-1 p-4">
        {tiles.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            No incidents yet — the wall will fill as alerts arrive.
          </div>
        ) : (
          <div className="grid grid-cols-3 gap-3 xl:grid-cols-4 2xl:grid-cols-5">
            {tiles.map((inc) => (
              <IncidentCard
                key={`${inc.ts}::${inc.sensorId}`}
                incident={inc}
                now={now}
                onClick={() => {}}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

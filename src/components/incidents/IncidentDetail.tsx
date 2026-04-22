"use client";

import dynamic from "next/dynamic";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ClipPlayer } from "./ClipPlayer";
import type { Incident } from "@/lib/types";

// Monaco is heavy — load it lazily so the incidents table renders fast
const MonacoEditor = dynamic(
  () => import("@monaco-editor/react").then((m) => m.default),
  { ssr: false, loading: () => <div className="h-48 animate-pulse rounded bg-muted" /> }
);

interface IncidentDetailProps {
  incident: Incident | null;
  onClose: () => void;
}

function buildClipUrl(sensorId: string, ts: string) {
  // Encode the timestamp so slashes / colons don't break the URL
  const safeTs = encodeURIComponent(ts);
  return `/api/clips/${encodeURIComponent(sensorId)}/${safeTs}/index.m3u8`;
}

/** How many seconds into the clip the incident occurred.
 *  Without clip_start metadata we default to 0 (seek to beginning). */
const SEEK_OFFSET = 0;

const SEVERITY_BADGE: Record<Incident["severity"], string> = {
  low: "bg-blue-500/15 text-blue-400 border-blue-500/30",
  medium: "bg-yellow-500/15 text-yellow-400 border-yellow-500/30",
  high: "bg-red-500/15 text-red-400 border-red-500/30",
};

export function IncidentDetail({ incident, onClose }: IncidentDetailProps) {
  if (!incident) return null;

  const clipUrl = buildClipUrl(incident.sensorId, incident.ts);
  const rawJson = JSON.stringify(incident.raw, null, 2);

  return (
    <Dialog open={!!incident} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 flex-wrap">
            <span
              className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase ${SEVERITY_BADGE[incident.severity]}`}
            >
              {incident.severity}
            </span>
            <span className="font-mono text-sm">{incident.sensorId}</span>
            <span className="text-xs text-muted-foreground">
              {new Date(incident.ts).toLocaleString()}
            </span>
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* Metadata */}
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <p className="text-xs text-muted-foreground">Scenario</p>
              <p className="font-medium">{incident.scenarioName}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Topic</p>
              <p className="font-mono text-xs">{incident.topic}</p>
            </div>
          </div>

          {/* Summary */}
          <div>
            <p className="text-xs text-muted-foreground mb-1">Summary</p>
            <p className="text-sm">{incident.summary}</p>
          </div>

          {/* HLS Clip */}
          <div>
            <p className="text-xs text-muted-foreground mb-1.5">Clip</p>
            <ClipPlayer src={clipUrl} seekOffset={SEEK_OFFSET} />
          </div>

          {/* Raw payload */}
          <div>
            <p className="text-xs text-muted-foreground mb-1.5">Raw Payload</p>
            <div className="h-48 overflow-hidden rounded border border-border">
              <MonacoEditor
                height="192px"
                defaultLanguage="json"
                value={rawJson}
                theme="vs-dark"
                options={{
                  readOnly: true,
                  minimap: { enabled: false },
                  scrollBeyondLastLine: false,
                  fontSize: 11,
                  lineNumbers: "off",
                  folding: true,
                }}
              />
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

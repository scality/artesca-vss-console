"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { MarkdownReport, isSafeUrl } from "@/components/MarkdownReport";
import { useToast } from "@/hooks/use-toast";
import { FileText, Loader2, RefreshCw } from "lucide-react";
import { ClipPlayer } from "./ClipPlayer";
import type { Incident } from "@/lib/types";

// Monaco is heavy — load it lazily so the incidents table renders fast
const MonacoEditor = dynamic(
  () => import("@/components/monaco").then((m) => m.MonacoEditor),
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
  low: "bg-blue-50 text-blue-700 border-blue-200",
  medium: "bg-amber-50 text-amber-700 border-amber-200",
  high: "bg-red-50 text-red-700 border-red-200",
};

/**
 * Client-side view of the POST/GET /api/incidents/report contract:
 *   POST { sensorId, ts, raw?, force? } → { ok:true, markdown, frames, clipUrl?, cached, warnings? } | { error }
 *   GET  ?sensorId=&ts=                 → { ok:true, markdown, frames, clipUrl?, cached:true, generatedAt } | { ok:false }
 */
type ReportState =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | {
      phase: "ready";
      markdown: string;
      frames: string[];
      clipUrl?: string;
      cached: boolean;
      warnings?: string[];
      generatedAt?: string;
    };

/** Narrow an arbitrary parsed JSON body down to the report success shape,
 *  without trusting the server to always return well-formed fields. */
function asReportSuccess(j: unknown): {
  markdown: string;
  frames: string[];
  clipUrl?: string;
  cached: boolean;
  warnings?: string[];
  generatedAt?: string;
} | null {
  if (!j || typeof j !== "object") return null;
  const r = j as Record<string, unknown>;
  if (r.ok !== true || typeof r.markdown !== "string") return null;
  return {
    markdown: r.markdown,
    frames: Array.isArray(r.frames) ? r.frames.filter((f): f is string => typeof f === "string") : [],
    clipUrl: typeof r.clipUrl === "string" ? r.clipUrl : undefined,
    cached: r.cached === true,
    warnings: Array.isArray(r.warnings) ? r.warnings.filter((w): w is string => typeof w === "string") : undefined,
    generatedAt: typeof r.generatedAt === "string" ? r.generatedAt : undefined,
  };
}

export function IncidentDetail({ incident, onClose }: IncidentDetailProps) {
  const [rawExpanded, setRawExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const [report, setReport] = useState<ReportState>({ phase: "idle" });
  const { toast } = useToast();

  const sensorId = incident?.sensorId;
  const ts = incident?.ts;

  // Reset the report panel and probe for a previously-cached report whenever
  // the dialog is (re)opened on a — possibly different — incident, so a
  // Generate Report already run for this incident shows up immediately with
  // a "Regenerate" affordance instead of forcing the operator to re-click.
  useEffect(() => {
    // Dialog closed (no incident) — nothing to reset yet; the branch below
    // resets to idle the next time it opens on a (possibly different)
    // incident, and this component renders null while closed regardless.
    if (!sensorId || !ts) return;
    let alive = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- clearing any stale report before probing the new incident
    setReport({ phase: "idle" });
    const params = new URLSearchParams({ sensorId, ts });
    fetch(`/api/incidents/report?${params.toString()}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!alive || !j) return;
        const parsed = asReportSuccess(j);
        if (parsed) setReport({ phase: "ready", ...parsed, cached: true });
      })
      .catch(() => {
        /* no cached report reachable — leave idle, "Generate Report" is the affordance */
      });
    return () => {
      alive = false;
    };
  }, [sensorId, ts]);

  if (!incident) return null;

  const clipUrl = buildClipUrl(incident.sensorId, incident.ts);
  const rawJson = JSON.stringify(incident.raw, null, 2);

  const copyRaw = async () => {
    try {
      await navigator.clipboard.writeText(rawJson);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };

  const generateReport = async (force: boolean) => {
    setReport({ phase: "loading" });
    try {
      const res = await fetch("/api/incidents/report", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sensorId: incident.sensorId,
          ts: incident.ts,
          raw: incident.raw,
          ...(force ? { force: true } : {}),
        }),
      });
      const j = await res.json().catch(() => null);
      const parsed = asReportSuccess(j);
      if (!res.ok || !parsed) {
        const message =
          (j && typeof j === "object" && typeof (j as Record<string, unknown>).error === "string"
            ? (j as Record<string, unknown>).error
            : null) ?? `HTTP ${res.status}`;
        throw new Error(String(message));
      }
      setReport({ phase: "ready", ...parsed });
      toast({ title: "Incident report generated" });
    } catch (e) {
      const message = (e as Error).message || "Report generation failed";
      setReport({ phase: "error", message });
      toast({ title: "Failed to generate report", description: message, variant: "destructive" });
    }
  };

  const reportButtonLabel =
    report.phase === "loading"
      ? "Generating…"
      : report.phase === "error"
      ? "Retry"
      : report.phase === "ready"
      ? "Regenerate"
      : "Generate Report";
  // Re-run after a report already exists (or failed) always forces a fresh
  // generation rather than silently re-serving the cache.
  const reportButtonForce = report.phase === "ready" || report.phase === "error";
  const safeFrames = report.phase === "ready" ? report.frames.filter(isSafeUrl) : [];
  const safeClipUrl = report.phase === "ready" && isSafeUrl(report.clipUrl) ? report.clipUrl : undefined;

  return (
    <Dialog open={!!incident} onOpenChange={(v) => !v && onClose()}>
      <DialogContent
        className={`max-h-[92vh] overflow-y-auto transition-[max-width] ${
          rawExpanded ? "max-w-6xl" : "max-w-3xl"
        }`}
      >
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

        {/* When the payload is expanded, split into two columns: incident
            details on the left, the full raw payload on the right. */}
        <div className={rawExpanded ? "grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]" : "space-y-4"}>
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
              <p className="text-xs text-muted-foreground mb-1">What triggered this</p>
              <p className="text-sm">{incident.summary || "—"}</p>
            </div>

            {/* HLS Clip */}
            <div>
              <p className="text-xs text-muted-foreground mb-1.5">Clip</p>
              <div className="space-y-2">
                {incident.clipStatus === "ready" && (
                  <div className="flex items-center justify-between text-xs">
                    <span>Replay</span>
                    <span className="text-emerald-700">● clip ready (S3)</span>
                  </div>
                )}
                <ClipPlayer
                  src={clipUrl}
                  seekOffset={SEEK_OFFSET}
                  clipStatus={incident.clipStatus}
                  fallbackMeta={{
                    ts: incident.ts,
                    sensorId: incident.sensorId,
                    severity: incident.severity,
                    summary: incident.summary,
                    scenarioName: incident.scenarioName,
                  }}
                />
              </div>
            </div>

            {/* Generated incident report */}
            <div>
              <div className="mb-1.5 flex items-center justify-between gap-2">
                <p className="text-xs text-muted-foreground">Incident Report</p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 px-2 text-[11px]"
                  disabled={report.phase === "loading"}
                  onClick={() => void generateReport(reportButtonForce)}
                >
                  {report.phase === "loading" ? (
                    <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
                  ) : report.phase === "ready" ? (
                    <RefreshCw className="mr-1.5 h-3 w-3" />
                  ) : (
                    <FileText className="mr-1.5 h-3 w-3" />
                  )}
                  {reportButtonLabel}
                </Button>
              </div>

              {report.phase === "error" && (
                <div className="rounded border border-red-200 bg-red-50 p-2 text-xs text-brand-red">
                  <p className="font-medium">Report generation failed.</p>
                  <p className="mt-0.5 font-mono text-[11px]">{report.message}</p>
                </div>
              )}

              {report.phase === "ready" && (
                <div className="space-y-3">
                  {(report.cached || (report.warnings && report.warnings.length > 0)) && (
                    <div className="flex flex-wrap items-center gap-1.5">
                      {report.cached && (
                        <Badge
                          variant="outline"
                          className="border-brand-light-gray text-[10px] font-normal text-muted-foreground"
                          title={report.generatedAt ? `Generated ${new Date(report.generatedAt).toLocaleString()}` : undefined}
                        >
                          cached
                          {report.generatedAt ? ` · ${new Date(report.generatedAt).toLocaleString()}` : ""}
                        </Badge>
                      )}
                      {report.warnings?.map((w, i) => (
                        <Badge
                          key={i}
                          variant="outline"
                          className="border-amber-200 bg-amber-50 text-[10px] font-normal text-amber-700"
                        >
                          {w}
                        </Badge>
                      ))}
                    </div>
                  )}

                  <Card className="space-y-0 p-3 text-sm">
                    <MarkdownReport markdown={report.markdown} className="text-foreground" />
                  </Card>

                  {safeFrames.length > 0 && (
                    <div>
                      <p className="mb-1.5 text-xs text-muted-foreground">Frames</p>
                      <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                        {safeFrames.map((src, i) => (
                          <img
                            key={i}
                            src={src}
                            alt={`Report frame ${i + 1}`}
                            loading="lazy"
                            className="aspect-video w-full rounded border border-border object-cover"
                          />
                        ))}
                      </div>
                    </div>
                  )}

                  {safeClipUrl && (
                    <div>
                      <p className="mb-1.5 text-xs text-muted-foreground">Report clip</p>
                      <video
                        src={safeClipUrl}
                        controls
                        preload="metadata"
                        className="block w-full max-w-md max-h-64 rounded border border-border bg-black object-contain"
                      />
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Raw payload — moves to the right column (taller) when expanded. */}
          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <p className="text-xs text-muted-foreground">Raw Payload</p>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={copyRaw}
                  className="rounded border border-border px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-muted"
                >
                  {copied ? "Copied" : "Copy"}
                </button>
                <button
                  type="button"
                  onClick={() => setRawExpanded((v) => !v)}
                  className="rounded border border-border px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-muted"
                >
                  {rawExpanded ? "Collapse" : "View entire payload"}
                </button>
              </div>
            </div>
            <div
              className="overflow-hidden rounded border border-border"
              style={{ height: rawExpanded ? "80vh" : "192px" }}
            >
              <MonacoEditor
                height={rawExpanded ? "80vh" : "192px"}
                defaultLanguage="json"
                value={rawJson}
                theme="vs-dark"
                options={{
                  readOnly: true,
                  minimap: { enabled: rawExpanded },
                  scrollBeyondLastLine: false,
                  fontSize: 11,
                  lineNumbers: rawExpanded ? "on" : "off",
                  folding: true,
                  wordWrap: "on",
                }}
              />
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

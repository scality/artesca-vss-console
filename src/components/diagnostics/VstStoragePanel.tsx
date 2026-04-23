"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import {
  AlertTriangle,
  Info,
  AlertCircle,
  Loader2,
  AlertOctagon,
} from "lucide-react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from "recharts";
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from "@/components/ui/table";

// ──────────────────────────────────────────────
// Format helpers
// ──────────────────────────────────────────────

function formatBytes(n: number): string {
  if (n >= 1e12) return `${(n / 1e12).toFixed(2)} TB`;
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)} MB`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(2)} KB`;
  return `${n} B`;
}

function formatAge(secs: number): string {
  if (secs < 60) return `${Math.round(secs)}s`;
  const m = Math.floor(secs / 60);
  const s = Math.round(secs % 60);
  if (m < 60) return s > 0 ? `${m}m ${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm > 0 ? `${h}h ${rm}m` : `${h}h`;
}

function formatSizeBucket(minKB: number, maxKB: number | null): string {
  const fmt = (kb: number): string => {
    if (kb >= 1024 * 1024) return `${kb / (1024 * 1024)} TB`;
    if (kb >= 1024) return `${kb / 1024} MB`;
    return `${kb} KB`;
  };
  if (maxKB === null) return `${fmt(minKB)}+`;
  return `${fmt(minKB)}–${fmt(maxKB)}`;
}

// ──────────────────────────────────────────────
// API schema
// ──────────────────────────────────────────────

const HistogramBucketSchema = z.object({
  bucketMinKB: z.number(),
  bucketMaxKB: z.number().nullable(),
  count: z.number(),
});

const AlertSchema = z.object({
  severity: z.enum(["info", "warn", "crit"]),
  message: z.string(),
});

const RecentObjectSchema = z.object({
  key: z.string(),
  sensorId: z.string(),
  ts: z.string(),
  sizeBytes: z.number(),
  ageSecs: z.number(),
});

const VstStorageResponseSchema = z.object({
  putRateObjectsPerSec: z.number(),
  putRateBytesPerSec: z.number(),
  objectCount: z.number(),
  bytesTotal: z.number(),
  localCacheFillPercent: z.number().nullable(),
  segmentSizeKBHistogram: z.array(HistogramBucketSchema),
  segmentDurationSecsP50: z.number().nullable(),
  segmentDurationSecsP95: z.number().nullable(),
  frameDropCount: z.number().nullable(),
  recentObjects: z.array(RecentObjectSchema),
  alerts: z.array(AlertSchema),
});

type VstStorageData = z.infer<typeof VstStorageResponseSchema>;

// ──────────────────────────────────────────────
// Sub-components
// ──────────────────────────────────────────────

// Local cache progress bar (no shadcn Progress available)
function CacheProgressBar({ pct }: { pct: number }) {
  const colorClass =
    pct > 90
      ? "bg-red-500"
      : pct > 75
        ? "bg-yellow-500"
        : "bg-green-500";

  return (
    <div className="space-y-1">
      <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${colorClass}`}
          style={{ width: `${Math.min(100, pct)}%` }}
        />
      </div>
      <p className="text-xs text-muted-foreground">
        {pct.toFixed(1)}% of 500 GiB{" "}
        <span className="italic">(emptyDir sizeLimit)</span>
      </p>
    </div>
  );
}

// Frame drops badge (top-right corner usage)
function FrameDropsBadge({ count }: { count: number | null }) {
  if (count === null) {
    return (
      <span className="text-xs text-muted-foreground">drops: —</span>
    );
  }
  if (count === 0) {
    return <span className="text-xs text-green-400">no drops</span>;
  }
  return (
    <span className="flex items-center gap-1 text-xs text-yellow-400">
      <AlertTriangle className="h-3 w-3" />
      {count.toLocaleString()} drop{count !== 1 ? "s" : ""}
    </span>
  );
}

// Alerts strip
function AlertsStrip({ alerts }: { alerts: VstStorageData["alerts"] }) {
  if (alerts.length === 0) return null;

  const iconFor = (sev: "info" | "warn" | "crit") => {
    if (sev === "crit")
      return <AlertOctagon className="h-4 w-4 shrink-0 text-red-400" />;
    if (sev === "warn")
      return <AlertTriangle className="h-4 w-4 shrink-0 text-yellow-400" />;
    return <Info className="h-4 w-4 shrink-0 text-muted-foreground" />;
  };

  const bgFor = (sev: "info" | "warn" | "crit") => {
    if (sev === "crit") return "bg-red-950/40 border-red-800/50 text-red-300";
    if (sev === "warn")
      return "bg-yellow-950/40 border-yellow-800/50 text-yellow-200";
    return "bg-muted/30 border-border text-muted-foreground";
  };

  return (
    <div className="space-y-1.5">
      {alerts.map((a, i) => (
        <div
          key={i}
          className={`flex items-start gap-2 rounded-md border px-3 py-2 text-sm ${bgFor(a.severity)}`}
        >
          {iconFor(a.severity)}
          <span>{a.message}</span>
        </div>
      ))}
    </div>
  );
}

// Segment size histogram using Recharts
function SegmentHistogram({
  data,
}: {
  data: VstStorageData["segmentSizeKBHistogram"];
}) {
  if (data.length === 0) {
    return (
      <p className="text-sm text-muted-foreground py-4 text-center">
        No histogram data yet.
      </p>
    );
  }

  const chartData = data.map((b) => ({
    label: formatSizeBucket(b.bucketMinKB, b.bucketMaxKB),
    count: b.count,
  }));

  return (
    <ResponsiveContainer width="100%" height={180}>
      <BarChart data={chartData} layout="vertical" margin={{ left: 8, right: 16, top: 4, bottom: 4 }}>
        <XAxis type="number" dataKey="count" tick={{ fontSize: 11 }} />
        <YAxis
          type="category"
          dataKey="label"
          width={90}
          tick={{ fontSize: 11 }}
        />
        <Tooltip
          formatter={(value: number) => [value, "segments"]}
          contentStyle={{ fontSize: 12 }}
        />
        <Bar dataKey="count" radius={[0, 3, 3, 0]}>
          {chartData.map((_, i) => (
            <Cell key={i} fill="hsl(var(--primary) / 0.7)" />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

// Segment duration stats block
function SegmentDurationStats({
  p50,
  p95,
}: {
  p50: number | null;
  p95: number | null;
}) {
  if (p50 === null && p95 === null) {
    return (
      <p className="text-sm text-muted-foreground py-4">
        Not enough samples yet (need ≥2 objects per sensor).
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-4">
        <div>
          <p className="text-xs text-muted-foreground uppercase tracking-wide">
            P50
          </p>
          <p className="text-3xl font-mono font-semibold">
            {p50 !== null ? p50.toFixed(1) : "—"}
            <span className="text-base font-normal text-muted-foreground ml-1">
              s
            </span>
          </p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground uppercase tracking-wide">
            P95
          </p>
          <p className="text-3xl font-mono font-semibold">
            {p95 !== null ? p95.toFixed(1) : "—"}
            <span className="text-base font-normal text-muted-foreground ml-1">
              s
            </span>
          </p>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        Expected ~10 s — higher P95 means VST is batching more GoPs per file.
      </p>
    </div>
  );
}

// Recent objects table
function RecentObjectsTable({
  objects,
}: {
  objects: VstStorageData["recentObjects"];
}) {
  const rows = objects.slice(0, 20);
  return (
    <div className="max-h-72 overflow-y-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Sensor</TableHead>
            <TableHead>Timestamp</TableHead>
            <TableHead>Size</TableHead>
            <TableHead>Age</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={4} className="text-center text-muted-foreground py-6">
                No objects yet.
              </TableCell>
            </TableRow>
          ) : (
            rows.map((obj, i) => (
              <TableRow key={i}>
                <TableCell className="font-mono text-xs">{obj.sensorId}</TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {new Date(obj.ts).toLocaleString(undefined, {
                    month: "short",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                    second: "2-digit",
                  })}
                </TableCell>
                <TableCell className="text-xs font-mono">{formatBytes(obj.sizeBytes)}</TableCell>
                <TableCell className="text-xs">{formatAge(obj.ageSecs)}</TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}

// ──────────────────────────────────────────────
// Main panel
// ──────────────────────────────────────────────

export function VstStoragePanel() {
  const { data, isLoading, isError, isFetching, isFetched } = useQuery({
    queryKey: ["storage", "vst"],
    queryFn: async () => {
      const res = await fetch("/api/storage/vst");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const raw = await res.json();
      return VstStorageResponseSchema.parse(raw);
    },
    refetchInterval: 5_000,
    retry: 2,
  });

  // First-load spinner — before any data arrives
  if (isLoading && !isFetched) {
    return (
      <div className="flex items-center justify-center py-12 text-muted-foreground gap-2">
        <Loader2 className="h-5 w-5 animate-spin" />
        <span className="text-sm">Loading VST storage metrics…</span>
      </div>
    );
  }

  // Error state — show banner, grey out
  if (isError && !data) {
    return (
      <div className="rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive flex items-center gap-2">
        <AlertCircle className="h-4 w-4 shrink-0" />
        Unable to fetch VST storage metrics. Retrying…
      </div>
    );
  }

  const d = data!;

  const putRateMBps = (d.putRateBytesPerSec / 1e6).toFixed(2);
  const totalGB = (d.bytesTotal / 1e9).toFixed(2);

  return (
    <div className="relative space-y-5">
      {/* Top-right indicators: frame drops + updating badge */}
      <div className="absolute top-0 right-0 flex items-center gap-3">
        {isFetching && isFetched && (
          <span className="text-xs text-muted-foreground flex items-center gap-1">
            <Loader2 className="h-3 w-3 animate-spin" />
            updating…
          </span>
        )}
        <FrameDropsBadge count={d.frameDropCount} />
      </div>

      {/* Error banner over stale data */}
      {isError && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 px-4 py-2 text-sm text-destructive flex items-center gap-2">
          <AlertCircle className="h-4 w-4 shrink-0" />
          Unable to refresh — showing stale data.
        </div>
      )}

      {/* Alerts strip */}
      <AlertsStrip alerts={d.alerts} />

      {/* Top row: 3 tiles */}
      <div className="grid grid-cols-3 gap-4">
        {/* PUT rate tile */}
        <div className="rounded-lg border border-border bg-muted/10 p-4 space-y-1">
          <p className="text-xs text-muted-foreground uppercase tracking-wide">
            S3 PUT rate
          </p>
          <p className="text-3xl font-mono font-semibold">
            {putRateMBps}
            <span className="text-base font-normal text-muted-foreground ml-1">
              MB/s
            </span>
          </p>
          <p className="text-sm text-muted-foreground">
            {d.putRateObjectsPerSec.toFixed(1)} obj/s
          </p>
        </div>

        {/* Objects tile */}
        <div className="rounded-lg border border-border bg-muted/10 p-4 space-y-1">
          <p className="text-xs text-muted-foreground uppercase tracking-wide">
            Objects in vss-video
          </p>
          <p className="text-3xl font-mono font-semibold">
            {d.objectCount.toLocaleString()}
          </p>
          <p className="text-sm text-muted-foreground">{totalGB} GB total</p>
        </div>

        {/* Local cache tile */}
        <div className="rounded-lg border border-border bg-muted/10 p-4 space-y-2">
          <p className="text-xs text-muted-foreground uppercase tracking-wide">
            Local cache
          </p>
          {d.localCacheFillPercent === null ? (
            <p className="text-sm text-muted-foreground italic">unavailable</p>
          ) : (
            <>
              <p className="text-3xl font-mono font-semibold">
                {d.localCacheFillPercent.toFixed(1)}
                <span className="text-base font-normal text-muted-foreground ml-0.5">
                  %
                </span>
              </p>
              <CacheProgressBar pct={d.localCacheFillPercent} />
            </>
          )}
        </div>
      </div>

      {/* Middle row: histogram + duration stats */}
      <div className="grid grid-cols-2 gap-4">
        <div className="rounded-lg border border-border bg-muted/10 p-4">
          <h3 className="text-sm font-medium mb-3">Segment size distribution</h3>
          <SegmentHistogram data={d.segmentSizeKBHistogram} />
        </div>

        <div className="rounded-lg border border-border bg-muted/10 p-4">
          <h3 className="text-sm font-medium mb-3">Segment duration</h3>
          <SegmentDurationStats
            p50={d.segmentDurationSecsP50}
            p95={d.segmentDurationSecsP95}
          />
        </div>
      </div>

      {/* Recent objects */}
      <div className="rounded-lg border border-border bg-muted/10 p-4">
        <h3 className="text-sm font-medium mb-3">Recent objects</h3>
        <RecentObjectsTable objects={d.recentObjects} />
      </div>
    </div>
  );
}

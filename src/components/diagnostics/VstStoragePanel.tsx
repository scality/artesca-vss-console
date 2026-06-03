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
  AreaChart,
  Area,
} from "recharts";
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from "@/components/ui/table";
import { Progress } from "@/components/ui/progress";

// ──────────────────────────────────────────────
// Format helpers
// ──────────────────────────────────────────────

/** All byte sizes use base-2 (KiB / MiB / GiB / TiB). */
function formatBytes(n: number): string {
  const TiB = 2 ** 40;
  const GiB = 2 ** 30;
  const MiB = 2 ** 20;
  const KiB = 2 ** 10;
  if (n >= TiB) return `${(n / TiB).toFixed(2)} TiB`;
  if (n >= GiB) return `${(n / GiB).toFixed(2)} GiB`;
  if (n >= MiB) return `${(n / MiB).toFixed(1)} MiB`;
  if (n >= KiB) return `${Math.round(n / KiB)} KiB`;
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
// Ring buffer — 60 samples, client-side only
// ──────────────────────────────────────────────

const SPARKLINE_CAPACITY = 60;

interface SparkSample {
  t: number;    // epoch ms, for uniqueness
  v: number;    // MB/s
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
  /** NEW — frame drops per minute (null = not yet available from sensor-ms) */
  frameDropRatePerMin: z.number().nullable().optional(),
  recentObjects: z.array(RecentObjectSchema),
  alerts: z.array(AlertSchema),
  /** NEW — bucket scan was capped at 5000 objects */
  bucketScanTruncated: z.boolean().optional(),
  /** NEW — seconds since object totals were last refreshed */
  bucketScanStaleSecs: z.number().optional(),
});

type VstStorageData = z.infer<typeof VstStorageResponseSchema>;

// ──────────────────────────────────────────────
// Sub-components
// ──────────────────────────────────────────────

/** PUT-rate sparkline — 60 samples, ~40 px tall, no axes/grid/tooltip. */
function PutRateSparkline({ samples }: { samples: SparkSample[] }) {
  // Need at least 3 samples to draw a meaningful line
  if (samples.length < 3) {
    return (
      <p className="text-xs text-muted-foreground italic mt-1">
        collecting…
      </p>
    );
  }

  const chartData = samples.map((s, i) => ({ i, v: s.v }));

  return (
    <div className="mt-2 h-10 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart
          data={chartData}
          margin={{ top: 2, right: 0, bottom: 2, left: 0 }}
        >
          <defs>
            <linearGradient id="sparkGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.3} />
              <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0} />
            </linearGradient>
          </defs>
          <Area
            type="monotone"
            dataKey="v"
            stroke="hsl(var(--primary))"
            strokeWidth={1.5}
            fill="url(#sparkGrad)"
            dot={false}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Local cache progress bar — uses shadcn Progress component. */
function CacheProgressBar({ pct }: { pct: number }) {
  const colorClass =
    pct > 90
      ? "[&>div]:bg-red-500"
      : pct > 75
        ? "[&>div]:bg-yellow-500"
        : "[&>div]:bg-green-500";

  return (
    <div className="space-y-1">
      <Progress value={Math.min(100, pct)} className={`h-2 ${colorClass}`} />
      <p className="text-xs text-muted-foreground">
        {pct.toFixed(1)}% of 500 GiB{" "}
        <span className="italic">(emptyDir sizeLimit)</span>
      </p>
    </div>
  );
}

/**
 * Frame drops badge — top-right corner.
 * Shows rate (drops/min) from the new field; lifetime count in a title tooltip.
 */
function FrameDropsBadge({
  count,
  ratePerMin,
}: {
  count: number | null;
  ratePerMin?: number | null;
}) {
  // rate is undefined → new field not yet in payload → fall back to lifetime count display
  const rate = ratePerMin ?? null;

  const lifetimeTitle =
    count !== null
      ? `${count.toLocaleString()} total drop${count !== 1 ? "s" : ""} since sensor-ms started`
      : undefined;

  if (rate === null && count === null) {
    return (
      <span className="text-xs text-muted-foreground" title={lifetimeTitle}>
        drops: —
      </span>
    );
  }

  if (rate === 0 || (rate === null && count === 0)) {
    return (
      <span className="text-xs text-green-400" title={lifetimeTitle}>
        no drops
      </span>
    );
  }

  // rate > 0 — yellow or red
  const displayRate = rate !== null ? rate : null;
  const isCrit = displayRate !== null && displayRate >= 5;

  return (
    <span
      className={`flex items-center gap-1 text-xs ${isCrit ? "text-red-400" : "text-yellow-400"}`}
      title={lifetimeTitle}
    >
      {isCrit ? (
        <AlertOctagon className="h-3 w-3" />
      ) : (
        <AlertTriangle className="h-3 w-3" />
      )}
      {displayRate !== null
        ? `${displayRate.toFixed(1)} drops/min`
        : `${(count ?? 0).toLocaleString()} drops`}
    </span>
  );
}

/** Alerts strip — renders both backend alerts and any client-injected alerts. */
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
  // Ring buffer stored in a ref — no re-render on every append.
  // The ref holds the array; state holds a stable snapshot used for rendering,
  // updated only when the query succeeds (same cadence as the rest of the UI).
  const ringRef = React.useRef<SparkSample[]>([]);
  const [sparkSamples, setSparkSamples] = React.useState<SparkSample[]>([]);
  const consecutiveErrorsRef = React.useRef(0);

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

  // Append MB/s sample to ring buffer on each successful fetch.
  // Reset buffer after ≥2 consecutive errors (gap is more honest than a bridged line).
  React.useEffect(() => {
    if (data) {
      consecutiveErrorsRef.current = 0;
      const mbps = data.putRateBytesPerSec / 1_048_576; // bytes → MiB/s
      const ring = ringRef.current;
      if (ring.length >= SPARKLINE_CAPACITY) {
        ring.shift();
      }
      ring.push({ t: Date.now(), v: mbps });
      setSparkSamples([...ring]);
    }
  }, [data]);

  React.useEffect(() => {
    if (isError) {
      consecutiveErrorsRef.current += 1;
      if (consecutiveErrorsRef.current >= 2) {
        ringRef.current = [];
        setSparkSamples([]);
      }
    }
  }, [isError]);

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

  // Guard: isFetched becomes true after the first failed attempt in RQ v5
  // (before retries complete), so isLoading && !isFetched may be false while
  // data is still undefined. Render nothing until data arrives.
  if (!data) {
    return (
      <div className="flex items-center justify-center py-12 text-muted-foreground gap-2">
        <Loader2 className="h-5 w-5 animate-spin" />
        <span className="text-sm">Loading VST storage metrics…</span>
      </div>
    );
  }

  const d = data;

  // MB/s for display — note: display label stays "MB/s" (industry convention for network
  // throughput; the sparkline also tracks MiB/s under the hood but the label says MB/s
  // since that is what VST documentation uses for PUT rate).
  const putRateMBps = (d.putRateBytesPerSec / 1_000_000).toFixed(2);

  // GiB for storage totals — base-2 throughout
  const GiB = 2 ** 30;
  const totalGiB = (d.bytesTotal / GiB).toFixed(2);

  // ── Client-injected alerts ──────────────────
  const clientAlerts: VstStorageData["alerts"] = [...d.alerts];

  // Bucket scan truncated → info alert at top
  if (d.bucketScanTruncated) {
    clientAlerts.unshift({
      severity: "info",
      message:
        "Total object count is a conservative estimate — full bucket scan truncated at 5000 objects for latency. Will refresh in background.",
    });
  }

  // High frame-drop rate → crit alert at top
  const dropRate = d.frameDropRatePerMin ?? null;
  if (dropRate !== null && dropRate >= 5) {
    clientAlerts.unshift({
      severity: "crit",
      message: `High frame-drop rate: ${dropRate.toFixed(1)}/min (sensor-ms is dropping frames, likely recorder saturation)`,
    });
  }

  // Objects tile stale tooltip — show when > 120 s stale
  const scanStaleSecs = d.bucketScanStaleSecs ?? 0;
  const showStaleHint = scanStaleSecs > 120;
  const staleMins = Math.round(scanStaleSecs / 60);

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
        <FrameDropsBadge
          count={d.frameDropCount}
          ratePerMin={d.frameDropRatePerMin}
        />
      </div>

      {/* Error banner over stale data */}
      {isError && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 px-4 py-2 text-sm text-destructive flex items-center gap-2">
          <AlertCircle className="h-4 w-4 shrink-0" />
          Unable to refresh — showing stale data.
        </div>
      )}

      {/* Alerts strip (backend + client-injected) */}
      <AlertsStrip alerts={clientAlerts} />

      {/* Top row: 3 tiles */}
      <div className="grid grid-cols-3 gap-4">
        {/* PUT rate tile — with sparkline */}
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
          <PutRateSparkline samples={sparkSamples} />
        </div>

        {/* Objects tile — with optional stale hint */}
        <div className="rounded-lg border border-border bg-muted/10 p-4 space-y-1">
          <p className="text-xs text-muted-foreground uppercase tracking-wide">
            Objects in nvidia-vss-video
          </p>
          <p className="text-3xl font-mono font-semibold">
            {d.objectCount.toLocaleString()}
            {showStaleHint && (
              <span
                className="ml-2 text-sm font-normal text-muted-foreground cursor-help"
                title={`Totals cached ~${staleMins} min ago — refreshing.`}
              >
                <Info className="inline h-3.5 w-3.5" />
              </span>
            )}
          </p>
          <p className="text-sm text-muted-foreground">{totalGiB} GiB total</p>
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

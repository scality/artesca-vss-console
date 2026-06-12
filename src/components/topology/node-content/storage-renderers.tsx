"use client";

// storage-renderers.tsx — JSX tab renderers for storage nodes (Agent 4).
// Imported by storage.ts which re-exports as STORAGE_CONTENT.

import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Info,
  AlertTriangle,
  AlertOctagon,
  ExternalLink,
  Loader2,
} from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Progress } from "@/components/ui/progress";
import { Button } from "@/components/ui/button";
import type { NodeContentMap, TabRendererProps } from "../registry";
import type { S3State, CacheState, DbState, RedisState } from "@/lib/types/pipeline";

// ─── Format helpers ────────────────────────────────────────────────────────────

function formatBytes(n: number): string {
  const GiB = 2 ** 30;
  const MiB = 2 ** 20;
  const KiB = 2 ** 10;
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

// ─── Ceiling gauge ─────────────────────────────────────────────────────────────

function CeilingGauge({ s3 }: { s3: S3State }) {
  const pct = s3.ceilingPct;
  const ceilingGiB = s3.ceilingGiB;
  const colorClass =
    pct > 90
      ? "[&>div]:bg-red-500"
      : pct > 70
        ? "[&>div]:bg-yellow-500"
        : "[&>div]:bg-green-500";

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>Storage ceiling</span>
        <span className={pct > 90 ? "text-red-400 font-medium" : pct > 70 ? "text-yellow-400 font-medium" : "text-green-400"}>
          {pct.toFixed(1)}%
        </span>
      </div>
      <Progress value={Math.min(100, pct)} className={`h-2 ${colorClass}`} />
      <p className="text-[11px] text-muted-foreground">
        {pct.toFixed(1)}% of {ceilingGiB} GiB ceiling (demo profile) ·{" "}
        <a href="#" className="underline underline-offset-2 opacity-60 hover:opacity-100">
          read more
        </a>
      </p>
    </div>
  );
}

// ─── Recent objects table ─────────────────────────────────────────────────────

interface RecentObject {
  key: string;
  sensorId: string;
  ts: string;
  sizeBytes: number;
  ageSecs: number;
}

function RecentObjectsTable({ objects }: { objects: RecentObject[] }) {
  const rows = objects.slice(0, 6);
  return (
    <div className="max-h-40 overflow-y-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="text-[11px]">Sensor</TableHead>
            <TableHead className="text-[11px]">Timestamp</TableHead>
            <TableHead className="text-[11px]">Size</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={3} className="text-center text-muted-foreground py-4 text-xs">
                No objects yet.
              </TableCell>
            </TableRow>
          ) : (
            rows.map((obj, i) => (
              <TableRow key={i}>
                <TableCell className="font-mono text-[11px]">
                  {obj.sensorId || obj.key.slice(0, 12)}
                </TableCell>
                <TableCell className="text-[11px] text-muted-foreground">
                  {formatAge(obj.ageSecs)} ago
                </TableCell>
                <TableCell className="text-[11px] font-mono">
                  {formatBytes(obj.sizeBytes)}
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}

// ─── Full recent objects modal (browse) ───────────────────────────────────────

interface BrowseModalProps {
  onClose: () => void;
}

function BrowseModal({ onClose }: BrowseModalProps) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["storage", "vst", "browse"],
    queryFn: async () => {
      const res = await fetch("/api/storage/vst");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json() as Promise<{ recentObjects: RecentObject[] }>;
    },
  });

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        className="bg-card border border-border rounded-xl shadow-2xl w-[640px] max-h-[70vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h3 className="text-sm font-semibold">Recent recordings — nvidia-vss-recordings</h3>
          <Button variant="ghost" size="sm" onClick={onClose}>Close</Button>
        </div>
        <div className="flex-1 overflow-y-auto p-4">
          {isLoading && (
            <div className="flex items-center justify-center py-8 gap-2 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span className="text-sm">Loading…</span>
            </div>
          )}
          {isError && (
            <p className="text-sm text-destructive">Failed to fetch objects.</p>
          )}
          {data && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Sensor</TableHead>
                  <TableHead>Key</TableHead>
                  <TableHead>Age</TableHead>
                  <TableHead>Size</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.recentObjects.slice(0, 50).map((obj, i) => (
                  <TableRow key={i}>
                    <TableCell className="font-mono text-xs">{obj.sensorId}</TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground max-w-[200px] truncate">
                      {obj.key}
                    </TableCell>
                    <TableCell className="text-xs">{formatAge(obj.ageSecs)} ago</TableCell>
                    <TableCell className="text-xs font-mono">{formatBytes(obj.sizeBytes)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── PUT test state ────────────────────────────────────────────────────────────

function TestPutButton() {
  const [state, setState] = useState<"idle" | "running" | "ok" | "err">("idle");
  const [msg, setMsg] = useState("");

  async function run() {
    setState("running");
    const t0 = Date.now();
    try {
      // s3-write is not yet in the diagnostics map → call disabled path
      // Endpoint exists at /api/diagnostics/[test] — s3-write is not registered.
      // Once added to DIAGNOSTICS in route.ts this will go live.
      const res = await fetch("/api/diagnostics/s3-write", { method: "POST" });
      const elapsed = Date.now() - t0;
      if (res.ok) {
        setState("ok");
        setMsg(`PUT succeeded in ${elapsed} ms`);
      } else {
        setState("err");
        setMsg(`HTTP ${res.status}`);
      }
    } catch (e) {
      setState("err");
      setMsg(String(e));
    }
    setTimeout(() => setState("idle"), 4000);
  }

  return (
    <div className="space-y-1">
      <Button
        size="sm"
        variant="outline"
        onClick={run}
        disabled={state === "running"}
        title="endpoint not yet implemented"
      >
        {state === "running" ? (
          <><Loader2 className="h-3 w-3 animate-spin mr-1" /> Testing…</>
        ) : (
          "Test PUT"
        )}
      </Button>
      {msg && (
        <p className={`text-xs ${state === "ok" ? "text-green-400" : "text-red-400"}`}>
          {msg}
        </p>
      )}
    </div>
  );
}

// ─── artesca-s3 — Status tab ──────────────────────────────────────────────────

function ArtescaS3Status({ runtimeState }: TabRendererProps) {
  const s3: S3State | undefined = runtimeState?.s3;

  // Local ring buffer for instantaneous PUT rate display (sparkline deferred to Phase 7).
  // Kept as state so the ring is available immutably when the sparkline renderer lands.
  // _ring prefix: not yet consumed in render (sparkline deferred to Phase 7)
  const [_ring, setRing] = useState<Array<{ t: number; v: number }>>([]);

  useEffect(() => {
    if (s3) {
      // reason: accumulating a rolling history buffer from a streaming prop;
      // this is the correct subscription pattern (setState in callback of external update).
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setRing((prev) => [...prev.slice(-59), { t: Date.now(), v: s3.putRateMBps }]);
    }
  }, [s3]);

  if (!s3) {
    return (
      <div className="py-6 text-center text-sm text-muted-foreground">
        S3 state not available — pipeline snapshot may be loading.
      </div>
    );
  }

  const GiB = 2 ** 30;
  const totalGiB = (s3.bytesTotal / GiB).toFixed(2);
  const putRateMBps = s3.putRateMBps.toFixed(2);
  const putRateObjMin = s3.putRateObjPerMin.toFixed(1);

  return (
    <div className="space-y-4">
      {/* Primary: PUT rate headline */}
      <div className="rounded-lg border border-border bg-muted/10 px-4 py-3">
        <p className="text-xs text-muted-foreground mb-1">PUT rate</p>
        <p className="text-3xl font-mono font-semibold leading-none">
          {putRateMBps}
          <span className="text-base font-normal text-muted-foreground ml-1">MB/s</span>
        </p>
        <p className="text-xs text-muted-foreground mt-1">{putRateObjMin} obj/min</p>
        {/* Sparkline deferred to Phase 7 — shows instantaneous rate only */}
      </div>

      {/* Supporting stats */}
      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-lg border border-border bg-muted/10 p-3 space-y-0.5">
          <p className="text-xs text-muted-foreground">Objects</p>
          <p className="text-xl font-mono font-semibold">{s3.objectCount.toLocaleString()}</p>
          <p className="text-xs text-muted-foreground">{totalGiB} GiB</p>
        </div>
        {/* Ceiling gauge — reads ceilingGiB from runtime.s3.ceilingGiB */}
        <div className="rounded-lg border border-border bg-muted/10 p-3">
          <CeilingGauge s3={s3} />
        </div>
      </div>

      {/* Recent objects */}
      <div className="border-t border-border pt-3">
        <h4 className="text-sm font-semibold mb-2">Recent objects</h4>
        <RecentObjectsFromRuntime s3={s3} />
      </div>

      {/* Meta: scan freshness + truncation notice — de-emphasized */}
      <div className="space-y-1">
        <p className="text-xs text-muted-foreground">
          Totals refreshed {s3.bucketScanStaleSecs}s ago
          {s3.bucketScanTruncated && (
            <span className="ml-2 inline-flex items-center gap-1">
              <Info className="h-3 w-3 shrink-0" />
              count estimated (scan truncated at 5 000)
            </span>
          )}
        </p>
      </div>
    </div>
  );
}

// Recent objects: fetch from /api/storage/vst if not in snapshot, else use runtime data.
// The snapshot's s3 state doesn't carry recentObjects (pipeline type doesn't include them),
// so we always fetch from the storage API to get the list.
function RecentObjectsFromRuntime({ s3 }: { s3: S3State }) {
  const { data, isLoading } = useQuery({
    queryKey: ["storage", "vst", "recent"],
    queryFn: async () => {
      const res = await fetch("/api/storage/vst");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json() as Promise<{ recentObjects: RecentObject[] }>;
    },
    refetchInterval: 10_000,
    staleTime: 8_000,
  });

  // Suppress unused warning — s3 is passed in for possible future use (e.g. bucket name)
  void s3;

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 py-2 text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" />
        <span className="text-xs">Loading objects…</span>
      </div>
    );
  }

  return <RecentObjectsTable objects={data?.recentObjects ?? []} />;
}

// ─── artesca-s3 — Config tab ──────────────────────────────────────────────────

function ArtescaS3Config({ runtimeState }: TabRendererProps) {
  const s3 = runtimeState?.s3;
  // Private IP is not directly in pipeline snapshot; pod state has namespace.
  // We can hint the user to the ARTESCA UI but can't resolve the private IP from client-side.

  return (
    <div className="space-y-3 text-sm">
      <dl className="space-y-2">
        <div className="grid grid-cols-3 gap-2">
          <dt className="text-xs text-muted-foreground self-center">Bucket</dt>
          <dd className="col-span-2 font-mono text-xs bg-muted/30 px-2 py-1 rounded">
            {s3?.bucket ?? "nvidia-vss-recordings"}
          </dd>
        </div>
        <div className="grid grid-cols-3 gap-2">
          <dt className="text-xs text-muted-foreground self-center">Region</dt>
          <dd className="col-span-2 font-mono text-xs bg-muted/30 px-2 py-1 rounded">
            {process.env.NEXT_PUBLIC_AWS_REGION ?? "us-east-1"}
          </dd>
        </div>
        <div className="grid grid-cols-3 gap-2">
          <dt className="text-xs text-muted-foreground self-center">Endpoint</dt>
          <dd className="col-span-2 font-mono text-xs bg-muted/30 px-2 py-1 rounded truncate">
            (in-cluster — read from S3_ENDPOINT env)
          </dd>
        </div>
      </dl>

      <p className="text-[11px] text-muted-foreground">
        Credentials and endpoint rotate through{" "}
        <span className="font-mono bg-muted/30 px-1 rounded">/secrets</span>.
      </p>

      <div className="pt-1">
        <span className="text-xs text-muted-foreground">ARTESCA UI: </span>
        <span className="text-xs text-muted-foreground italic">
          private IP unavailable from console — open{" "}
          <code className="bg-muted/30 px-1 rounded">https://&lt;private-ip&gt;:8443/</code>
          {" "}from the node.
        </span>
      </div>
    </div>
  );
}

// ─── artesca-s3 — Actions tab ─────────────────────────────────────────────────

function ArtescaS3Actions(_props: TabRendererProps) {
  const [showBrowse, setShowBrowse] = useState(false);

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <p className="text-xs font-medium">Test write</p>
        <p className="text-[11px] text-muted-foreground mb-2">
          PUT a small test object to verify S3 credentials and connectivity.
        </p>
        <TestPutButton />
      </div>

      <div className="space-y-1">
        <p className="text-xs font-medium">Browse recordings</p>
        <p className="text-[11px] text-muted-foreground mb-2">
          List last 50 objects in the nvidia-vss-recordings bucket.
        </p>
        <Button size="sm" variant="outline" onClick={() => setShowBrowse(true)}>
          Browse recent recordings
        </Button>
      </div>

      {showBrowse && <BrowseModal onClose={() => setShowBrowse(false)} />}
    </div>
  );
}

// ─── vst-local-cache — Status tab ────────────────────────────────────────────

function VstLocalCacheStatus({ runtimeState }: TabRendererProps) {
  const cache: CacheState | undefined = runtimeState?.cache;

  if (!cache) {
    return (
      <div className="py-6 text-center text-sm text-muted-foreground">
        Cache state not available.
      </div>
    );
  }

  const pct = cache.fillPct;
  const barColor =
    pct !== null && pct > 90
      ? "[&>div]:bg-red-500"
      : pct !== null && pct > 75
        ? "[&>div]:bg-yellow-500"
        : "[&>div]:bg-green-500";

  const dropRate = cache.frameDropRatePerMin;
  const dropCount = cache.frameDropCount;
  const isDropCrit = dropRate !== null && dropRate >= 5;

  return (
    <div className="space-y-4">
      {/* Fill gauge */}
      <div className="space-y-1">
        <div className="flex items-center justify-between text-xs">
          <span className="text-muted-foreground">Fill level</span>
          <span
            className={
              pct !== null && pct > 90
                ? "text-red-400 font-medium"
                : pct !== null && pct > 75
                  ? "text-yellow-400 font-medium"
                  : "text-green-400"
            }
          >
            {pct !== null ? `${pct.toFixed(1)}%` : "—"}
          </span>
        </div>
        <Progress value={pct ?? 0} className={`h-2 ${barColor}`} />
        <p className="text-[11px] text-muted-foreground">
          {pct !== null ? `${pct.toFixed(1)}%` : "—"} of {cache.sizeGiB} GiB · evict at{" "}
          {cache.thresholdPct}%
        </p>
      </div>

      {/* Frame drops */}
      <div className="rounded-lg border border-border bg-muted/10 p-3 space-y-1">
        <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Frame drops</p>
        <div className="flex items-center gap-2">
          {isDropCrit ? (
            <AlertOctagon className="h-4 w-4 text-red-400" />
          ) : dropRate !== null && dropRate > 0 ? (
            <AlertTriangle className="h-4 w-4 text-yellow-400" />
          ) : null}
          <span
            className={`text-xl font-mono font-semibold ${
              isDropCrit ? "text-red-400" : dropRate !== null && dropRate > 0 ? "text-yellow-400" : ""
            }`}
          >
            {dropRate !== null ? dropRate.toFixed(1) : dropCount !== null ? dropCount.toLocaleString() : "—"}
          </span>
          <span className="text-xs text-muted-foreground">
            {dropRate !== null ? "drops/min" : dropCount !== null ? "total drops" : ""}
          </span>
        </div>
      </div>
    </div>
  );
}

// ─── vst-local-cache — Config tab ────────────────────────────────────────────

function VstLocalCacheConfig(_props: TabRendererProps) {
  return (
    <div className="space-y-3 text-sm">
      <p className="text-xs text-muted-foreground">
        Storage threshold and monitoring frequency are managed in the tuning page.
      </p>
      <Button
        size="sm"
        variant="outline"
        asChild
      >
        <a href="/tuning">
          <ExternalLink className="h-3.5 w-3.5 mr-1.5" />
          Edit in /tuning
        </a>
      </Button>
      <p className="text-[11px] text-muted-foreground">
        Navigates to the VST Recording form on the tuning page.
      </p>
    </div>
  );
}

// ─── vst-postgres — Status tab ────────────────────────────────────────────────

function VstPostgresStatus({ runtimeState }: TabRendererProps) {
  const db: DbState | undefined = runtimeState?.db;

  if (!db) {
    return (
      <div className="py-6 text-center text-sm text-muted-foreground">
        Database state not available.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Up/down */}
      <div className="flex items-center gap-2">
        <span
          className={`h-2.5 w-2.5 rounded-full ${db.up ? "bg-green-500" : "bg-red-500"}`}
        />
        <span className="text-sm font-medium">{db.up ? "Connected" : "Unavailable"}</span>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-lg border border-border bg-muted/10 p-3 space-y-0.5">
          <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Connections</p>
          <p className="text-2xl font-mono font-semibold">
            {db.connections !== null ? db.connections : "—"}
          </p>
        </div>
        <div className="rounded-lg border border-border bg-muted/10 p-3 space-y-0.5">
          <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Size</p>
          <p className="text-2xl font-mono font-semibold">
            {db.sizeMiB !== null ? db.sizeMiB.toFixed(0) : "—"}
            <span className="text-sm font-normal text-muted-foreground ml-1">MiB</span>
          </p>
        </div>
      </div>

      <p className="text-[11px] text-muted-foreground">
        VST-owned schema. Not editable from this console.
      </p>
    </div>
  );
}

// ─── Redis — Status tab ──────────────────────────────────────────────────────
// Single Redis node: vst-redis. It backs both the VST internal
// vst.event topic AND the alert-worker cooldown keys (k8s/nvidia-vss/alerts/README.md
// § "Known gaps"). nodeId is left in the signature for symmetry with the
// other tab renderers.

function RedisStatus(
  { runtimeState, nodeId: _nodeId }: TabRendererProps
) {
  const redis: RedisState | undefined = runtimeState?.redis;

  const note =
    "Serves vst.event (VST internal) + alert-worker cooldown keys (reused).";

  if (!redis) {
    return (
      <div className="py-6 text-center text-sm text-muted-foreground">
        Redis state not available.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Up/down */}
      <div className="flex items-center gap-2">
        <span
          className={`h-2.5 w-2.5 rounded-full ${redis.up ? "bg-green-500" : "bg-red-500"}`}
        />
        <span className="text-sm font-medium">{redis.up ? "Connected" : "Unavailable"}</span>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-lg border border-border bg-muted/10 p-3 space-y-0.5">
          <p className="text-[10px] text-muted-foreground uppercase tracking-wide">
            Connected clients
          </p>
          <p className="text-2xl font-mono font-semibold">
            {redis.connectedClients !== null ? redis.connectedClients : "—"}
          </p>
        </div>
        <div className="rounded-lg border border-border bg-muted/10 p-3 space-y-0.5">
          <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Memory</p>
          <p className="text-2xl font-mono font-semibold">
            {redis.memUsedMiB !== null ? redis.memUsedMiB.toFixed(1) : "—"}
            <span className="text-sm font-normal text-muted-foreground ml-1">MiB</span>
          </p>
        </div>
      </div>

      <p className="text-[11px] text-muted-foreground">{note}</p>
    </div>
  );
}

// ─── Export: NodeContentMap ────────────────────────────────────────────────────

export const STORAGE_RENDERERS: NodeContentMap = {
  "artesca-s3": {
    status: (props) => <ArtescaS3Status {...props} />,
    config: (props) => <ArtescaS3Config {...props} />,
    actions: (props) => <ArtescaS3Actions {...props} />,
  },
  "vst-local-cache": {
    status: (props) => <VstLocalCacheStatus {...props} />,
    config: (props) => <VstLocalCacheConfig {...props} />,
  },
  "vst-postgres": {
    status: (props) => <VstPostgresStatus {...props} />,
  },
  "vst-redis": {
    status: (props) => <RedisStatus {...props} />,
  },
};

"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Activity, Gauge, Timer, Video, Zap, AlertTriangle, CheckCircle2 } from "lucide-react";
import { cn } from "@/lib/utils";

interface GpuDensity {
  index: number;
  name: string;
  utilPct: number;
  memUsedMiB: number;
  memTotalMiB: number;
}

interface StreamDensitySnapshot {
  reqPerSec: number | null;
  pctOver1s: number | null;
  chunkBudgetUsed: number | null;
  latencyP95Ms: number | null;
  tokensPerSec: number | null;
  activeStreams: number | null;
  gpus: GpuDensity[];
  gpu: GpuDensity | null;
  chunkDurationSecs: number;
  estimatedActiveStreams: number | null;
  verdict: "ok" | "warn" | "saturated" | "unknown";
  warnings: string[];
}

const fmt = (n: number | null, dp = 0, suffix = "") =>
  n === null || n === undefined ? "—" : `${n.toFixed(dp)}${suffix}`;

function Metric({
  icon: Icon,
  label,
  value,
  sub,
}: {
  icon: React.ElementType;
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="rounded-md border border-border bg-card p-3">
      <p className="text-xs text-muted-foreground flex items-center gap-1">
        <Icon className="h-3 w-3" />
        {label}
      </p>
      <p className="text-xl font-semibold mt-1">{value}</p>
      {sub && <p className="text-[10px] text-muted-foreground mt-0.5">{sub}</p>}
    </div>
  );
}

const VERDICTS = {
  ok: { label: "Keeping real time — each chunk is analysed well inside its own duration", cls: "text-emerald-700 bg-emerald-50 border-emerald-200", Icon: CheckCircle2 },
  warn: { label: "Tight — a chunk's analysis uses over half its duration; a burst queues the next one", cls: "text-amber-700 bg-amber-50 border-amber-200", Icon: AlertTriangle },
  saturated: {
    label: "Behind real time — chunks queue or drop. Cut per-chunk cost (reasoning off / fewer tokens / smaller vision / longer chunk) or route streams to a second VLM replica",
    cls: "text-red-700 bg-red-50 border-red-200",
    Icon: AlertTriangle,
  },
  unknown: { label: "No VLM metrics yet", cls: "text-muted-foreground bg-muted/30 border-border", Icon: Activity },
} as const;

export function StreamDensityCard() {
  const { data } = useQuery({
    queryKey: ["stream-density"],
    queryFn: async (): Promise<StreamDensitySnapshot> => {
      const res = await fetch("/api/stream-density");
      if (!res.ok) throw new Error("failed to fetch stream density");
      return res.json();
    },
    refetchInterval: 5000,
    staleTime: 5000,
  });

  const meta = VERDICTS[data?.verdict ?? "unknown"];
  const VerdictIcon = meta.Icon;
  // The headline card is the busiest one. A node whose workloads are unevenly
  // placed has an idle card and a saturated one, and reporting whichever GPU
  // DCGM listed first answers the wrong question.
  const busiest = data?.gpu ?? null;
  const vramPct =
    busiest && busiest.memTotalMiB > 0
      ? Math.round((busiest.memUsedMiB / busiest.memTotalMiB) * 100)
      : null;
  const gpus = data?.gpus ?? [];

  return (
    <div className="rounded-lg border border-border p-5 space-y-4">
      <div>
        <h3 className="text-base font-semibold">Stream Density / Headroom</h3>
        <p className="text-sm text-muted-foreground">
          Live VLM headroom. Real time holds while a chunk is analysed inside its own duration: the verdict
          is P95 latency over chunk length (tight past 50&nbsp;%, behind past 80&nbsp;%), and streams the VLM holds
          without serving one request per chunk. Implied streams ≈ requests/sec × chunk duration.
        </p>
      </div>

      <div className={cn("flex items-center gap-2 rounded-md border p-3 text-sm", meta.cls)}>
        <VerdictIcon className="h-4 w-4 shrink-0" />
        {meta.label}
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <Metric icon={Gauge} label="Chunk budget used" value={data?.chunkBudgetUsed != null ? `${Math.round(data.chunkBudgetUsed * 100)}%` : "—"} sub="P95 ÷ chunk · tight ≥ 50%, behind ≥ 80%" />
        <Metric icon={AlertTriangle} label="Requests > 1s" value={data?.pctOver1s != null ? `${Math.round(data.pctOver1s * 100)}%` : "—"} sub="NVIDIA HPA signal — meaningful for ~1 s chunks" />
        <Metric icon={Timer} label="P95 latency" value={fmt(data?.latencyP95Ms ?? null, 0, " ms")} sub={`chunk ${data?.chunkDurationSecs ?? "?"}s`} />
        <Metric icon={Activity} label="Est. active streams" value={data?.estimatedActiveStreams != null ? String(data.estimatedActiveStreams) : "—"} sub={`${fmt(data?.reqPerSec ?? null, 2)} req/s × chunk`} />
        <Metric icon={Video} label="Streams the VLM sees" value={data?.activeStreams != null ? String(data.activeStreams) : "—"} sub="active_live_streams" />
        <Metric icon={Zap} label="Tokens/sec" value={fmt(data?.tokensPerSec ?? null, 0)} />
        <Metric icon={Gauge} label="GPU util (busiest)" value={busiest ? `${Math.round(busiest.utilPct)}%` : "—"} sub={busiest ? `GPU ${busiest.index}` : undefined} />
        <Metric icon={Gauge} label="GPU VRAM (busiest)" value={vramPct != null ? `${vramPct}%` : "—"} sub={busiest && busiest.memTotalMiB > 0 ? `GPU ${busiest.index} · ${Math.round(busiest.memUsedMiB / 1024)}/${Math.round(busiest.memTotalMiB / 1024)} GiB` : undefined} />
      </div>

      {gpus.length > 1 && (
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">
            Per card. The VLM runs on one card and the recorder on the other; a second VLM replica on the idle
            card becomes headroom only once streams are routed to it.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {gpus.map((g) => (
              <div
                key={g.index}
                className="flex items-baseline justify-between rounded-md border border-border bg-card px-3 py-2 text-xs"
              >
                <span className="font-medium">GPU {g.index}</span>
                <span className="text-muted-foreground truncate px-2">{g.name}</span>
                <span className="tabular-nums">
                  {Math.round(g.utilPct)}%
                  {g.memTotalMiB > 0 &&
                    ` · ${Math.round(g.memUsedMiB / 1024)}/${Math.round(g.memTotalMiB / 1024)} GiB`}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

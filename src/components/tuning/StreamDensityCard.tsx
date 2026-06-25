"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Activity, Gauge, Timer, Zap, AlertTriangle, CheckCircle2 } from "lucide-react";
import { cn } from "@/lib/utils";

interface StreamDensitySnapshot {
  reqPerSec: number | null;
  pctOver1s: number | null;
  latencyP95Ms: number | null;
  tokensPerSec: number | null;
  gpu: { utilPct: number; memUsedMiB: number; memTotalMiB: number } | null;
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
  ok: { label: "Headroom available", cls: "text-emerald-700 bg-emerald-50 border-emerald-200", Icon: CheckCircle2 },
  warn: { label: "Approaching saturation", cls: "text-amber-700 bg-amber-50 border-amber-200", Icon: AlertTriangle },
  saturated: {
    label: "Saturated — cut per-chunk cost (reasoning off / fewer tokens / smaller vision / longer chunk) or add a VLM replica",
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
  const vramPct = data?.gpu ? Math.round((data.gpu.memUsedMiB / data.gpu.memTotalMiB) * 100) : null;

  return (
    <div className="rounded-lg border border-border p-5 space-y-4">
      <div>
        <h3 className="text-base font-semibold">Stream Density / Headroom</h3>
        <p className="text-sm text-muted-foreground">
          Live VLM saturation. The scale signal is the fraction of requests over 1s — at ≥40% the VLM
          can&apos;t keep real time and you need fewer per-chunk tokens or another replica. Implied streams ≈
          requests/sec × chunk duration.
        </p>
      </div>

      <div className={cn("flex items-center gap-2 rounded-md border p-3 text-sm", meta.cls)}>
        <VerdictIcon className="h-4 w-4 shrink-0" />
        {meta.label}
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <Metric icon={AlertTriangle} label="Requests > 1s" value={data?.pctOver1s != null ? `${Math.round(data.pctOver1s * 100)}%` : "—"} sub="scale at ≥ 40%" />
        <Metric icon={Timer} label="P95 latency" value={fmt(data?.latencyP95Ms ?? null, 0, " ms")} sub={`chunk ${data?.chunkDurationSecs ?? "?"}s`} />
        <Metric icon={Activity} label="Est. active streams" value={data?.estimatedActiveStreams != null ? String(data.estimatedActiveStreams) : "—"} sub={`${fmt(data?.reqPerSec ?? null, 2)} req/s × chunk`} />
        <Metric icon={Zap} label="Tokens/sec" value={fmt(data?.tokensPerSec ?? null, 0)} />
        <Metric icon={Gauge} label="GPU util" value={data?.gpu ? `${Math.round(data.gpu.utilPct)}%` : "—"} />
        <Metric icon={Gauge} label="GPU VRAM" value={vramPct != null ? `${vramPct}%` : "—"} sub={data?.gpu ? `${Math.round(data.gpu.memUsedMiB / 1024)}/${Math.round(data.gpu.memTotalMiB / 1024)} GiB` : undefined} />
      </div>
    </div>
  );
}

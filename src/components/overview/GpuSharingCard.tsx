"use client";

import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Cloud, Loader2 } from "lucide-react";
import type {
  GpuAllocationSnapshot,
  GpuAllocation,
  GpuSharingMode,
  GpuSharingStrategy,
  WorkloadHealth,
  NimConfig,
  GpuConfigEntry,
} from "@/lib/gpu-allocation";

/** GPU-memory budget knobs under a workload (kv-cache, gpu-mem, max-len, …) —
 *  TP/profile are already shown by NimChip, so they're filtered out here. */
function ConfigLine({ config }: { config?: GpuConfigEntry[] }) {
  const entries = (config ?? []).filter((e) => e.label !== "TP" && e.label !== "profile");
  if (entries.length === 0) return null;
  return (
    <div className="ml-[18px] flex flex-wrap gap-x-2 gap-y-0.5 text-[10px] text-muted-foreground/80">
      {entries.map((e) => (
        <span key={e.label} className="font-mono">
          <span className="text-muted-foreground/60">{e.label}</span> {e.value}
        </span>
      ))}
    </div>
  );
}

/** NIM tensor-parallel + profile chip — placed next to the health chip so a
 *  crash that stems from a TP/profile mismatch reads as cause-and-effect. */
function NimChip({ nim }: { nim?: NimConfig }) {
  if (!nim) return null;
  const tp = nim.tensorParallel !== null ? `TP=${nim.tensorParallel}` : "TP=auto";
  const prof = nim.modelProfile ? nim.modelProfile.slice(0, 10) : "auto";
  return (
    <span
      className="shrink-0 rounded border border-border bg-muted/40 px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground"
      title={`NIM tensor-parallel size + model profile${nim.modelProfile ? "" : " (auto-selected)"}`}
    >
      {tp} · {prof}
    </span>
  );
}

/** Compact live-health chip — shows crashloops/restarts so the allocation view
 *  reveals what's actually happening, not just static placement. */
function HealthChip({ health }: { health?: WorkloadHealth }) {
  if (!health) return null;
  const { restartCount, ready, stateReason } = health;
  if (ready && restartCount === 0 && !stateReason) return null; // healthy → no chip

  const bad = !!stateReason || !ready;
  const cls = bad
    ? "border-red-500/40 bg-red-500/10 text-red-300"
    : "border-amber-500/40 bg-amber-500/10 text-amber-300";
  const text = stateReason
    ? `⟳${restartCount} · ${stateReason}`
    : !ready
      ? restartCount > 0
        ? `⟳${restartCount} · not ready`
        : "not ready"
      : `⟳${restartCount} restarts`;

  return (
    <span className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-medium ${cls}`}>
      {text}
    </span>
  );
}

// Always-on, self-explaining descriptions of each GPU sharing strategy, so an
// operator reading the panel understands the active mode and the alternatives
// without leaving the page.
const SHARING_INFO: Record<
  GpuSharingStrategy,
  { label: string; blurb: string }
> = {
  exclusive: {
    label: "Exclusive (whole-GPU)",
    blurb:
      "Each pod gets a whole physical GPU to itself — the default. No sharing: N GPUs means at most N GPU pods; any extra stay Pending.",
  },
  "time-slicing": {
    label: "Time-slicing",
    blurb:
      "The device plugin advertises each GPU as several replicas; pods take turns on it (context-switched). Oversubscribes compute, NOT memory — co-scheduled pods can OOM each other since there's no VRAM isolation.",
  },
  mps: {
    label: "MPS (Multi-Process Service)",
    blurb:
      "Pods' CUDA work runs in one shared context for true concurrent execution on a single GPU — lower latency than time-slicing. Still no hard memory isolation between pods.",
  },
  mig: {
    label: "MIG (Multi-Instance GPU)",
    blurb:
      "The GPU is partitioned into hardware-isolated slices, each with dedicated compute + VRAM — the strongest isolation. Available on A100/H100-class and RTX PRO Blackwell.",
  },
  unknown: {
    label: "Unknown",
    blurb:
      "Couldn't read the GPU sharing labels (GPU Feature Discovery not present). Defaulting to a scheduler-only view.",
  },
};

function SharingModePanel({ sharing }: { sharing: GpuSharingMode }) {
  const info = SHARING_INFO[sharing.strategy];
  const badgeColor =
    sharing.strategy === "mig"
      ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
      : sharing.strategy === "exclusive"
        ? "border-sky-500/40 bg-sky-500/10 text-sky-300"
        : sharing.strategy === "unknown"
          ? "border-border bg-muted/30 text-muted-foreground"
          : "border-amber-500/40 bg-amber-500/10 text-amber-300";

  const cfg: string[] = [];
  if (sharing.physicalGpu !== null) cfg.push(`${sharing.physicalGpu} physical`);
  if (sharing.schedulableGpu !== null) cfg.push(`${sharing.schedulableGpu} schedulable`);
  if (sharing.replicas !== null && sharing.replicas > 1) cfg.push(`${sharing.replicas}× replicas`);
  if (sharing.migStrategy) cfg.push(`MIG: ${sharing.migStrategy}`);
  if (sharing.product) cfg.push(sharing.product);

  return (
    <div className="rounded-lg border border-border bg-card p-4 space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Sharing mode
        </span>
        <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${badgeColor}`}>
          {info.label}
        </span>
        {cfg.length > 0 && (
          <span className="text-[11px] font-mono text-muted-foreground tabular-nums">
            {cfg.join(" · ")}
          </span>
        )}
      </div>
      <p className="text-[11px] leading-relaxed text-muted-foreground">{info.blurb}</p>
    </div>
  );
}

// Distinct hues for the workloads sharing a GPU (cycled by index). Tailwind
// can't see dynamic class names, so use inline backgroundColor.
const WORKLOAD_COLORS = [
  "#38bdf8", // sky
  "#a78bfa", // violet
  "#34d399", // emerald
  "#fbbf24", // amber
  "#f472b6", // pink
  "#fb923c", // orange
];

const GiB = 1024;
const fmtGiB = (mib: number) => `${(mib / GiB).toFixed(1)} GiB`;

/** Trim the ReplicaSet hash + pod suffix to a readable workload name. */
function shortName(pod: string): string {
  // e.g. vss-rtvi-vlm-7c9d8f6b5-x2k9p → vss-rtvi-vlm
  return pod.replace(/-[a-z0-9]{8,10}-[a-z0-9]{5}$/, "").replace(/-[a-z0-9]{5}$/, "");
}

function GpuRow({ gpu, perWorkload }: { gpu: GpuAllocation; perWorkload: boolean }) {
  const usedPct =
    gpu.memTotalMiB > 0 ? (gpu.memUsedMiB / gpu.memTotalMiB) * 100 : 0;

  return (
    <div className="rounded-lg border border-border bg-card p-4 space-y-2">
      <div className="flex items-baseline justify-between gap-2">
        <div className="min-w-0">
          <span className="text-xs font-medium text-muted-foreground">GPU {gpu.index}</span>
          <span className="ml-2 text-sm font-semibold truncate">{gpu.name}</span>
        </div>
        <div className="flex items-center gap-3 text-xs text-muted-foreground tabular-nums shrink-0">
          <span>{Math.round(gpu.utilGpu)}% util</span>
          <span>{Math.round(gpu.tempC)}°C</span>
          <span>{Math.round(gpu.powerW)} W</span>
        </div>
      </div>

      {/* Stacked VRAM bar — one segment per workload sharing this GPU */}
      <div className="h-4 w-full rounded-md bg-muted overflow-hidden flex">
        {perWorkload && gpu.workloads.length > 0 ? (
          gpu.workloads.map((w, i) => {
            const pct = gpu.memTotalMiB > 0 ? (w.memUsedMiB / gpu.memTotalMiB) * 100 : 0;
            return (
              <div
                key={`${w.namespace}/${w.pod}`}
                style={{ width: `${pct}%`, backgroundColor: WORKLOAD_COLORS[i % WORKLOAD_COLORS.length] }}
                title={`${w.pod} — ${fmtGiB(w.memUsedMiB)}`}
              />
            );
          })
        ) : (
          // No per-pod attribution: show device-level fill only.
          <div
            style={{ width: `${Math.min(100, usedPct)}%` }}
            className="bg-sky-500/70"
          />
        )}
      </div>
      <p className="text-[11px] text-muted-foreground tabular-nums">
        {fmtGiB(gpu.memUsedMiB)} / {fmtGiB(gpu.memTotalMiB)} VRAM ({Math.round(usedPct)}%)
      </p>

      {/* Legend: which workloads share this GPU + their VRAM share */}
      {perWorkload && gpu.workloads.length > 0 ? (
        <ul className="space-y-1 pt-1">
          {gpu.workloads.map((w, i) => (
            <li key={`${w.namespace}/${w.pod}`} className="text-xs">
              <div className="flex items-center gap-2">
                <span
                  className="h-2.5 w-2.5 rounded-sm shrink-0"
                  style={{ backgroundColor: WORKLOAD_COLORS[i % WORKLOAD_COLORS.length] }}
                />
                <span className="font-mono truncate flex-1" title={`${w.namespace}/${w.pod}`}>
                  {shortName(w.pod)}
                </span>
                <NimChip nim={w.nim} />
                <HealthChip health={w.health} />
                <span className="text-muted-foreground tabular-nums shrink-0">
                  {fmtGiB(w.memUsedMiB)}
                </span>
              </div>
              <ConfigLine config={w.gpuConfig} />
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[11px] text-muted-foreground/70 pt-1">
          Per-workload attribution unavailable (DCGM pod labels missing).
        </p>
      )}
    </div>
  );
}

export function GpuSharingCard() {
  const { data, isLoading, isError } = useQuery<GpuAllocationSnapshot>({
    queryKey: ["gpu", "allocation"],
    queryFn: async () => {
      const res = await fetch("/api/gpu/allocation");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json() as Promise<GpuAllocationSnapshot>;
    },
    refetchInterval: 5_000,
    staleTime: 4_000,
  });

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-border bg-card p-4 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading GPU allocation…
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="rounded-lg border border-border bg-card p-4 text-sm text-muted-foreground">
        GPU allocation unavailable.
      </div>
    );
  }

  // Fallback (off-cluster / no DCGM): the K8s scheduler view — GPU capacity and
  // which Running workloads hold GPUs, without live per-pod VRAM.
  if (data.gpus.length === 0) {
    const { totalGpu, allocatedGpu, workloads } = data.scheduler;
    const hasSchedulerData = workloads.length > 0 || totalGpu !== null;
    return (
      <div className="space-y-3">
        <SharingModePanel sharing={data.sharing} />
        <div className="rounded-lg border border-border bg-card p-4 space-y-3">
          <p className="text-[11px] text-muted-foreground">
            Scheduler view — live per-pod VRAM needs in-cluster Prometheus (DCGM).
          </p>
          {hasSchedulerData ? (
            <>
              <div className="flex items-baseline justify-between text-sm">
                <span className="text-muted-foreground">GPUs allocated</span>
                <span className="font-mono tabular-nums">
                  {allocatedGpu}
                  {totalGpu !== null ? ` / ${totalGpu}` : ""}
                </span>
              </div>
              {totalGpu !== null && totalGpu > 0 && (
                <div className="h-4 w-full rounded-md bg-muted overflow-hidden flex">
                  {workloads.map((w, i) => (
                    <div
                      key={`${w.namespace}/${w.pod}`}
                      style={{
                        width: `${(w.gpuCount / totalGpu) * 100}%`,
                        backgroundColor: WORKLOAD_COLORS[i % WORKLOAD_COLORS.length],
                      }}
                      title={`${w.pod} — ${w.gpuCount} GPU`}
                    />
                  ))}
                </div>
              )}
              <ul className="space-y-1 pt-1">
                {workloads.map((w, i) => (
                  <li key={`${w.namespace}/${w.pod}`} className="text-xs">
                    <div className="flex items-center gap-2">
                      <span
                        className="h-2.5 w-2.5 rounded-sm shrink-0"
                        style={{ backgroundColor: WORKLOAD_COLORS[i % WORKLOAD_COLORS.length] }}
                      />
                      <span className="font-mono truncate flex-1" title={`${w.namespace}/${w.pod}`}>
                        {shortName(w.pod)}
                      </span>
                      <NimChip nim={w.nim} />
                      <HealthChip health={w.health} />
                      <span className="text-muted-foreground tabular-nums shrink-0">
                        {w.gpuCount} GPU
                      </span>
                    </div>
                    <ConfigLine config={w.gpuConfig} />
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">No GPU workloads found.</p>
          )}
        </div>
        <RemoteModelsPanel models={data.remoteModels} />
        <PendingPanel pending={data.pending} />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <SharingModePanel sharing={data.sharing} />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {data.gpus.map((gpu) => (
          <GpuRow key={gpu.index} gpu={gpu} perWorkload={data.perWorkload} />
        ))}
      </div>

      <RemoteModelsPanel models={data.remoteModels} />
      <PendingPanel pending={data.pending} />
    </div>
  );
}

/** Models the agent uses that run off-cluster (not on any local GPU) — makes
 *  "the LLM is remote, served at <host>" explicit next to the GPU allocation. */
function RemoteModelsPanel({ models }: { models: GpuAllocationSnapshot["remoteModels"] }) {
  if (!models || models.length === 0) return null;
  return (
    <div className="rounded-lg border border-sky-500/40 bg-sky-500/10 p-4 space-y-2">
      <div className="flex items-center gap-2 text-sm font-medium text-sky-300">
        <Cloud className="h-4 w-4" />
        Remote models — served off-cluster, not on a local GPU
      </div>
      <ul className="space-y-1">
        {models.map((m) => (
          <li key={`${m.role}/${m.name}`} className="text-xs flex items-center gap-2 flex-wrap">
            <span className="shrink-0 rounded border border-sky-500/40 bg-sky-500/15 px-1.5 py-0.5 text-[10px] font-medium text-sky-300">
              {m.role} · Remote
            </span>
            <span className="font-mono text-foreground">{m.name}</span>
            <span className="text-muted-foreground">→ {m.endpoint}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function PendingPanel({ pending }: { pending: GpuAllocationSnapshot["pending"] }) {
  if (pending.length === 0) return null;
  return (
    <>
      {/* Over-subscription: GPU workloads the scheduler couldn't place */}
      {pending.length > 0 && (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 p-4 space-y-2">
          <div className="flex items-center gap-2 text-sm font-medium text-red-300">
            <AlertTriangle className="h-4 w-4" />
            {pending.length} GPU workload{pending.length !== 1 ? "s" : ""} unscheduled
          </div>
          <ul className="space-y-1">
            {pending.map((p) => (
              <li key={`${p.namespace}/${p.pod}`} className="text-xs">
                <span className="font-mono">{shortName(p.pod)}</span>
                <span className="text-muted-foreground"> · {p.namespace} · needs {p.gpuRequest} GPU</span>
                <p className="text-[11px] text-red-300/70 mt-0.5">{p.reason}</p>
              </li>
            ))}
          </ul>
          <p className="text-[11px] text-muted-foreground">
            More GPU workloads than devices — with whole-GPU allocation (no
            time-slicing/MIG) each pod needs its own GPU.
          </p>
        </div>
      )}
    </>
  );
}

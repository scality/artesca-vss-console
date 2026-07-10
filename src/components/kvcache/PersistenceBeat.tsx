"use client";

import { Power, RotateCcw, Cpu, Loader2, CheckCircle2, UserCheck, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { LaneCard } from "./RaceBeat";
import { DEMO_QUESTION, useKvRestart, type RestartPhase } from "./use-mock-kv-telemetry";

const POD_STATUS: Record<RestartPhase, { label: string; tone: string; spin?: boolean }> = {
  idle: { label: "Running", tone: "border-emerald-200 bg-emerald-50 text-emerald-700" },
  terminating: { label: "Terminating", tone: "border-amber-200 bg-amber-50 text-amber-700", spin: true },
  creating: { label: "ContainerCreating", tone: "border-amber-200 bg-amber-50 text-amber-700", spin: true },
  running: { label: "Running", tone: "border-emerald-200 bg-emerald-50 text-emerald-700" },
  querying: { label: "Running", tone: "border-emerald-200 bg-emerald-50 text-emerald-700" },
  done: { label: "Running", tone: "border-emerald-200 bg-emerald-50 text-emerald-700" },
};

export function PersistenceBeat() {
  const { phase, lane, start, reset } = useKvRestart();
  const busy = phase !== "idle" && phase !== "done";
  const status = POD_STATUS[phase];
  const showQuery = phase === "querying" || phase === "done";

  return (
    <section className="rounded-lg border border-border bg-card p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-bold">
            <Power className="h-5 w-5 text-brand-teal" />
            It survives the GPU
          </h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            GPUs restart — for upgrades, crashes, or scaling. The KV cache doesn&rsquo;t live in
            GPU memory anymore, so a restart doesn&rsquo;t erase it.
          </p>
          <p className="mt-1 text-[11px] italic text-muted-foreground">
            Illustrative — a real GPU pod restart is a slower, asynchronous operation than this
            animation shows; live restart timing is a later phase of this prototype.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button size="sm" variant="outline" onClick={reset} disabled={busy}>
            <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
            Reset
          </Button>
          <Button size="sm" onClick={start} disabled={busy}>
            <Power className="mr-1.5 h-3.5 w-3.5" />
            Restart the GPU
          </Button>
        </div>
      </div>

      {/* Static contrast */}
      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="flex items-start gap-2 rounded border border-destructive/20 bg-destructive/5 p-3">
          <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
          <p className="text-xs text-foreground">
            <span className="font-semibold">Without ARTESCA: </span>
            <span className="text-muted-foreground">
              cold recompute on every restart — the model has no memory of anything it computed
              before the pod came down.
            </span>
          </p>
        </div>
        <div className="flex items-start gap-2 rounded border border-brand-teal/20 bg-brand-teal-soft/60 p-3">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-brand-teal" />
          <p className="text-xs text-foreground">
            <span className="font-semibold">With ARTESCA: </span>
            <span className="text-muted-foreground">
              memory reloads from storage — the very first query after a restart is still fast.
            </span>
          </p>
        </div>
      </div>

      {/* Pod status */}
      <div className="mt-4 flex items-center gap-3 rounded border border-border bg-muted/40 p-3">
        <Cpu className="h-5 w-5 shrink-0 text-brand-teal" />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-foreground">vss-rtvi-vlm pod</p>
          <p className="text-[11px] text-muted-foreground">
            {phase === "idle" ? "steady state" : phase === "done" ? "back to steady state" : "restart in progress"}
          </p>
        </div>
        <span
          className={cn(
            "inline-flex shrink-0 items-center gap-1.5 rounded border px-2 py-0.5 text-[11px] font-medium",
            status.tone
          )}
        >
          {status.spin && <Loader2 className="h-3 w-3 animate-spin" />}
          {status.label}
        </span>
      </div>

      {!showQuery && (
        <p className="mt-4 rounded border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
          Click &ldquo;Restart the GPU&rdquo; to watch the first query land right after it comes
          back up.
        </p>
      )}

      {showQuery && (
        <div className="mt-4 max-w-md">
          <LaneCard
            title="First query after restart"
            subtitle="KV source: ARTESCA S3 — no recompute needed"
            icon={UserCheck}
            badgeLabel="KV source: ARTESCA S3"
            badgeTone="border-brand-teal/30 bg-brand-teal-soft text-brand-teal"
            lane={lane}
            withKv={true}
            question={DEMO_QUESTION}
          />
        </div>
      )}
    </section>
  );
}

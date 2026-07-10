"use client";

import { useMemo } from "react";
import { Play, RotateCcw, Coins, Timer } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DAILY_QUESTIONS,
  GPU_COST_PER_HOUR_USD,
  computeCostTotals,
  useKvCostSim,
} from "./use-mock-kv-telemetry";

function formatUsd(n: number, digits = 5): string {
  return `$${n.toFixed(digits)}`;
}

export interface CostBeatLiveTimings {
  /** Real measured cold time-to-first-token (ms) from the last live race. */
  coldTtftMs: number;
  /** Real measured warm time-to-first-token (ms) from the last live race. */
  warmTtftMs: number;
}

interface CostBeatProps {
  /** True once the console has confirmed the vllm-lmcache backend is reachable. */
  live?: boolean;
  /** When set, the cost math below runs on these REAL measured TTFTs instead
   *  of the fixed mock GPU-seconds constants — same formulas, real inputs.
   *  The $/GPU-hour price itself stays illustrative either way. */
  liveTimings?: CostBeatLiveTimings | null;
}

export function CostBeat({ live = false, liveTimings }: CostBeatProps = {}) {
  const totals = useMemo(
    () =>
      liveTimings
        ? computeCostTotals(
            DAILY_QUESTIONS,
            liveTimings.coldTtftMs / 1000,
            liveTimings.warmTtftMs / 1000,
          )
        : computeCostTotals(DAILY_QUESTIONS),
    [liveTimings],
  );
  const { queriesDone, running, done, gpuSecondsSaved, dollarsSaved, start, reset } =
    useKvCostSim(totals);

  const bucketPct = Math.min(100, (queriesDone / totals.n) * 100);
  const coldBarPct = 100;
  const warmBarPct = Math.max(2, (totals.warmCostPerQuery / totals.coldCostPerQuery) * 100);

  return (
    <section className="rounded-lg border border-border bg-card p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-bold">
            <Coins className="h-5 w-5 text-brand-teal" />
            What it saves
          </h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            A showroom day of {totals.n.toLocaleString()} store-knowledge questions, with vs
            without the cache.
          </p>
          {liveTimings && (
            <p className="mt-0.5 text-[11px] font-medium text-emerald-700">
              Using the real cold/warm time-to-first-token from your last live race — the
              $/GPU-hour price is still illustrative.
            </p>
          )}
          {live && !liveTimings && (
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              Run the race above at least once to switch this math to real measured numbers.
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button size="sm" variant="outline" onClick={reset} disabled={running}>
            <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
            Reset
          </Button>
          <Button size="sm" onClick={start} disabled={running}>
            <Play className="mr-1.5 h-3.5 w-3.5" />
            Simulate a day of questions
          </Button>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
        {/* $/query */}
        <div className="rounded-lg border border-border bg-muted/30 p-4">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Cost per query</p>
          <div className="mt-2 flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Without cache</span>
            <span className="font-semibold tabular-nums text-destructive">
              {formatUsd(totals.coldCostPerQuery)}
            </span>
          </div>
          <div className="mt-1 flex items-center justify-between text-sm">
            <span className="text-muted-foreground">With ARTESCA cache</span>
            <span className="font-semibold tabular-nums text-brand-teal">
              {formatUsd(totals.warmCostPerQuery)}
            </span>
          </div>
          <p className="mt-2 text-[11px] font-medium text-emerald-700">
            −{totals.pctCostReduction.toFixed(1)}% cost per query
          </p>
        </div>

        {/* GPU-seconds saved (ticking) */}
        <div className="rounded-lg border border-border bg-muted/30 p-4">
          <p className="flex items-center gap-1.5 text-xs uppercase tracking-wide text-muted-foreground">
            <Timer className="h-3.5 w-3.5" />
            GPU-seconds saved today
          </p>
          <p className="mt-2 text-3xl font-bold tabular-nums text-foreground">
            {gpuSecondsSaved.toFixed(0)}s
          </p>
          <p className="mt-1 text-[11px] text-muted-foreground">
            ≈ {(gpuSecondsSaved / 60).toFixed(1)} GPU-minutes of recompute avoided
          </p>
        </div>

        {/* Bucket fill */}
        <div className="rounded-lg border border-border bg-muted/30 p-4">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">
            Questions answered from cache
          </p>
          <div className="mt-2 flex items-end gap-3">
            <div className="relative h-16 w-11 shrink-0 overflow-hidden rounded-b-lg rounded-t-sm border-2 border-border bg-background">
              <div
                className="absolute bottom-0 left-0 right-0 bg-brand-teal transition-all duration-150"
                style={{ height: `${bucketPct}%` }}
              />
            </div>
            <div>
              <p className="text-xl font-bold tabular-nums">
                {queriesDone}
                <span className="text-sm font-normal text-muted-foreground">/{totals.n}</span>
              </p>
              <p className="text-[11px] font-semibold tabular-nums text-emerald-700">
                {formatUsd(dollarsSaved, 3)} saved so far
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Cost bars */}
      <div className="mt-4 rounded-lg border border-border bg-muted/30 p-4">
        <p className="mb-3 text-xs uppercase tracking-wide text-muted-foreground">
          Daily GPU cost for this question batch (at ${GPU_COST_PER_HOUR_USD.toFixed(2)}/GPU-hour)
        </p>
        <div className="space-y-2">
          <div>
            <div className="mb-1 flex items-center justify-between text-xs">
              <span className="text-muted-foreground">Without cache</span>
              <span className="font-semibold tabular-nums">{formatUsd(totals.totalColdCostUsd, 2)}</span>
            </div>
            <div className="h-2.5 w-full overflow-hidden rounded-full bg-background">
              <div className="h-full rounded-full bg-destructive/70" style={{ width: `${coldBarPct}%` }} />
            </div>
          </div>
          <div>
            <div className="mb-1 flex items-center justify-between text-xs">
              <span className="text-muted-foreground">With ARTESCA cache</span>
              <span className="font-semibold tabular-nums">{formatUsd(totals.totalWarmCostUsd, 3)}</span>
            </div>
            <div className="h-2.5 w-full overflow-hidden rounded-full bg-background">
              <div className="h-full rounded-full bg-brand-teal" style={{ width: `${warmBarPct}%` }} />
            </div>
          </div>
        </div>
        <p className="mt-3 text-[11px] text-muted-foreground">
          {formatUsd(totals.totalSavedUsd, 2)} saved per day at this question volume — roughly{" "}
          {formatUsd(totals.totalSavedUsd * 365, 0)}/year, and it keeps growing with every extra
          camera and every extra visitor question.
        </p>
        {done && (
          <p className="mt-1 text-[11px] font-medium text-brand-teal">
            Simulation complete — {totals.n.toLocaleString()} questions answered, none of them
            recomputing the store knowledge base from scratch.
          </p>
        )}
      </div>
    </section>
  );
}

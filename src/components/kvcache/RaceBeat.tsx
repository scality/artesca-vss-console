"use client";

import { useState } from "react";
import { Play, RotateCcw, UserPlus, UserCheck, Zap, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatBytes } from "@/lib/format-bytes";
import { cn } from "@/lib/utils";
import {
  ANSWER_TOKENS,
  DEMO_QUESTION,
  KV_NUM_BLOCKS,
  KV_TOTAL_BYTES,
  useKvRace,
  type LaneState,
} from "./use-mock-kv-telemetry";

interface LaneCardProps {
  title: string;
  subtitle: string;
  icon: React.ComponentType<{ className?: string }>;
  badgeLabel: string;
  badgeTone: string;
  lane: LaneState;
  withKv: boolean;
  question: string;
}

/** One "visitor asks a question" lane — reused by the restart beat too. */
export function LaneCard({
  title,
  subtitle,
  icon: Icon,
  badgeLabel,
  badgeTone,
  lane,
  withKv,
  question,
}: LaneCardProps) {
  const ttftSeconds = (lane.elapsedMs / 1000).toFixed(2);
  const locked = lane.phase === "streaming" || lane.phase === "done";
  const answerSoFar = ANSWER_TOKENS.slice(0, lane.tokensShown).join(" ");

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Icon className="h-4 w-4 text-brand-teal" />
          <span className="text-sm font-semibold">{title}</span>
        </div>
        <span
          className={cn(
            "inline-flex shrink-0 items-center gap-1 rounded border px-2 py-0.5 text-[11px] font-medium",
            badgeTone
          )}
        >
          {badgeLabel}
        </span>
      </div>
      <p className="mt-0.5 text-xs text-muted-foreground">{subtitle}</p>

      <div className="mt-4 flex items-baseline gap-2">
        <span
          className={cn(
            "text-3xl font-bold tabular-nums tracking-tight",
            lane.phase === "idle"
              ? "text-muted-foreground"
              : locked
                ? "text-foreground"
                : "text-brand-teal"
          )}
        >
          {lane.phase === "idle" ? "—" : `${ttftSeconds}s`}
        </span>
        <span className="text-xs text-muted-foreground">time to first token</span>
      </div>

      <div className="mt-1 h-4 text-[11px] tabular-nums text-muted-foreground">
        {withKv &&
          lane.phase !== "idle" &&
          `${lane.kvBlocksRead}/${KV_NUM_BLOCKS} KV blocks · ${formatBytes(lane.kvBytesRead)} / ${formatBytes(
            KV_TOTAL_BYTES
          )} read from ARTESCA`}
      </div>

      <div className="mt-2 min-h-[4.75rem] rounded border border-border bg-muted/40 p-2.5 text-sm">
        <p className="text-[11px] text-muted-foreground">&ldquo;{question}&rdquo;</p>
        <p className="mt-1.5 leading-snug text-foreground">
          {answerSoFar}
          {lane.phase === "streaming" && <span className="animate-pulse">▍</span>}
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Live race — mirrors the shape returned by POST /api/kvcache/race
// (src/lib/kvcache.ts::KvRaceResult). Defined locally rather than imported
// from the server-only collector, matching the console's convention of
// client pages/components owning their own mirrored response shapes.
// ---------------------------------------------------------------------------

export interface LiveRaceTiming {
  ttftMs: number;
  totalMs: number;
}

export type LiveRaceResult =
  | {
      ok: true;
      model: string;
      cold: LiveRaceTiming;
      warm: LiveRaceTiming;
      speedup: number;
      bucketObjectsBefore: number;
      bucketObjectsAfter: number;
    }
  | { ok: false; error: string };

interface RaceBeatProps {
  /** True once the console has confirmed the vllm-lmcache backend is reachable. */
  live?: boolean;
  /** Called with the last successful live race so sibling sections (CostBeat)
   *  can derive their numbers from the same real measurement. */
  onLiveResult?: (result: LiveRaceResult & { ok: true }) => void;
}

export function RaceBeat({ live = false, onLiveResult }: RaceBeatProps = {}) {
  const mock = useKvRace();
  const [liveResult, setLiveResult] = useState<LiveRaceResult | null>(null);
  const [liveRunning, setLiveRunning] = useState(false);
  const [liveFellBack, setLiveFellBack] = useState(false);

  const running = liveRunning || mock.running;
  const showLiveResult = live && !liveFellBack && liveResult?.ok === true;
  const showMockLanes = !live || liveFellBack;
  const anyMockStarted = mock.cold.phase !== "idle" || mock.warm.phase !== "idle";

  async function start() {
    if (!live) {
      mock.start();
      return;
    }
    setLiveFellBack(false);
    setLiveResult(null);
    setLiveRunning(true);
    try {
      const resp = await fetch("/api/kvcache/race", { method: "POST", cache: "no-store" });
      const json = (await resp.json()) as LiveRaceResult;
      if (!resp.ok || !json.ok) {
        setLiveFellBack(true);
        mock.start();
        return;
      }
      setLiveResult(json);
      onLiveResult?.(json);
    } catch {
      setLiveFellBack(true);
      mock.start();
    } finally {
      setLiveRunning(false);
    }
  }

  function reset() {
    setLiveResult(null);
    setLiveFellBack(false);
    mock.reset();
  }

  const delta =
    showLiveResult && liveResult?.ok
      ? Math.max(0, liveResult.bucketObjectsAfter - liveResult.bucketObjectsBefore)
      : 0;

  return (
    <section className="rounded-lg border border-border bg-card p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-bold">
            <Zap className="h-5 w-5 text-brand-teal" />
            Watch it — the race
          </h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {live && !liveFellBack
              ? "The identical prompt, sent twice to the live vLLM+LMCache backend — once as a guaranteed KV miss, once as a guaranteed KV hit."
              : "Same question, two visitors, one asked seconds after the other. Same GPU, two very different amounts of work."}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button size="sm" variant="outline" onClick={reset} disabled={running}>
            <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
            Reset
          </Button>
          <Button size="sm" onClick={start} disabled={running}>
            {liveRunning ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Play className="mr-1.5 h-3.5 w-3.5" />
            )}
            {liveRunning ? "Running against the live backend…" : "Run the race"}
          </Button>
        </div>
      </div>

      {liveRunning && (
        <p className="mt-4 rounded border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
          Warmup, then a cold (guaranteed-miss) prompt, then a pause for LMCache to finish
          storing, then the identical warm prompt — real network + real GPU, ~10-30s.
        </p>
      )}

      {live && !liveRunning && liveFellBack && (
        <p className="mt-2 text-[11px] font-medium text-amber-700">
          Live backend unreachable — showing the illustrative demo instead.
        </p>
      )}

      {showLiveResult && liveResult?.ok && (
        <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4">
            <div className="flex items-center gap-2">
              <UserPlus className="h-4 w-4 text-destructive" />
              <span className="text-sm font-semibold">Cold — guaranteed KV miss</span>
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              a freshly-nonced prompt this vLLM instance has never seen
            </p>
            <p className="mt-4 text-3xl font-bold tabular-nums text-destructive">
              {(liveResult.cold.ttftMs / 1000).toFixed(2)}s
            </p>
            <p className="text-xs text-muted-foreground">time to first token (measured)</p>
          </div>
          <div className="rounded-lg border border-brand-teal/30 bg-brand-teal-soft p-4">
            <div className="flex items-center gap-2">
              <UserCheck className="h-4 w-4 text-brand-teal" />
              <span className="text-sm font-semibold">Warm — guaranteed KV hit</span>
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              the identical prompt, KV blocks reloaded from ARTESCA S3
            </p>
            <p className="mt-4 text-3xl font-bold tabular-nums text-brand-teal">
              {(liveResult.warm.ttftMs / 1000).toFixed(2)}s
            </p>
            <p className="text-xs text-muted-foreground">time to first token (measured)</p>
          </div>
          <div className="rounded border border-border bg-muted/40 p-3 text-center text-sm md:col-span-2">
            <span className="font-semibold text-brand-teal">{liveResult.speedup.toFixed(1)}×</span>{" "}
            faster time to first token, measured live against{" "}
            <span className="font-medium text-foreground">{liveResult.model}</span>.{" "}
            <span className="text-muted-foreground">
              {delta} new KV block{delta === 1 ? "" : "s"} landed on ARTESCA S3 in between (
              {liveResult.bucketObjectsAfter.toLocaleString()} total now).
            </span>
          </div>
        </div>
      )}

      {showMockLanes && !liveRunning && (
        <>
          {!anyMockStarted && (
            <p className="mt-4 rounded border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
              Click &ldquo;Run the race&rdquo; to send the same question to both visitors at once.
            </p>
          )}

          {anyMockStarted && (
            <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
              <LaneCard
                title="First-time visitor"
                subtitle="cold — nobody has asked this yet"
                icon={UserPlus}
                badgeLabel="KV source: GPU compute"
                badgeTone="border-destructive/30 bg-destructive/10 text-destructive"
                lane={mock.cold}
                withKv={false}
                question={DEMO_QUESTION}
              />
              <LaneCard
                title="Returning visitor"
                subtitle="warm — same question, KV cache already computed"
                icon={UserCheck}
                badgeLabel="KV source: ARTESCA S3"
                badgeTone="border-brand-teal/30 bg-brand-teal-soft text-brand-teal"
                lane={mock.warm}
                withKv={true}
                question={DEMO_QUESTION}
              />
            </div>
          )}
        </>
      )}
    </section>
  );
}

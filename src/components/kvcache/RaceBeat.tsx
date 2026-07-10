"use client";

import { Play, RotateCcw, UserPlus, UserCheck, Zap } from "lucide-react";
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

export function RaceBeat() {
  const { cold, warm, running, start, reset } = useKvRace();
  const anyStarted = cold.phase !== "idle" || warm.phase !== "idle";

  return (
    <section className="rounded-lg border border-border bg-card p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-bold">
            <Zap className="h-5 w-5 text-brand-teal" />
            Watch it — the race
          </h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Same question, two visitors, one asked seconds after the other. Same GPU, two very
            different amounts of work.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button size="sm" variant="outline" onClick={reset} disabled={running}>
            <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
            Reset
          </Button>
          <Button size="sm" onClick={start} disabled={running}>
            <Play className="mr-1.5 h-3.5 w-3.5" />
            Run the race
          </Button>
        </div>
      </div>

      {!anyStarted && (
        <p className="mt-4 rounded border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
          Click &ldquo;Run the race&rdquo; to send the same question to both visitors at once.
        </p>
      )}

      {anyStarted && (
        <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
          <LaneCard
            title="First-time visitor"
            subtitle="cold — nobody has asked this yet"
            icon={UserPlus}
            badgeLabel="KV source: GPU compute"
            badgeTone="border-destructive/30 bg-destructive/10 text-destructive"
            lane={cold}
            withKv={false}
            question={DEMO_QUESTION}
          />
          <LaneCard
            title="Returning visitor"
            subtitle="warm — same question, KV cache already computed"
            icon={UserCheck}
            badgeLabel="KV source: ARTESCA S3"
            badgeTone="border-brand-teal/30 bg-brand-teal-soft text-brand-teal"
            lane={warm}
            withKv={true}
            question={DEMO_QUESTION}
          />
        </div>
      )}
    </section>
  );
}

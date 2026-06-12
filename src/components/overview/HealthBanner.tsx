import type { OverviewSnapshot } from "@/lib/types";
import { cn } from "@/lib/utils";

type H = "ok" | "warn" | "fail";

const RANK: Record<H, number> = { ok: 0, warn: 1, fail: 2 };
const worst = (hs: H[]): H =>
  hs.reduce<H>((a, b) => (RANK[b] > RANK[a] ? b : a), "ok");

interface Signal {
  label: string;
  health: H;
  detail: string;
}

const DOT: Record<H, string> = {
  ok: "bg-green-500",
  warn: "bg-yellow-500",
  fail: "bg-red-500",
};

const OVERALL: Record<H, { box: string; text: string; word: string }> = {
  ok: {
    box: "border-green-500/30 bg-green-500/10",
    text: "text-green-300",
    word: "All systems operational",
  },
  warn: {
    box: "border-yellow-500/30 bg-yellow-500/10",
    text: "text-yellow-300",
    word: "Degraded",
  },
  fail: {
    box: "border-red-500/30 bg-red-500/10",
    text: "text-red-300",
    word: "Critical",
  },
};

// Roll the snapshot's individual probes into one operator-facing verdict.
// Each signal is only emitted when there's data behind it, so a compose box
// with no GPUs doesn't get scored on GPU health.
function buildSignals(overview: OverviewSnapshot, warningCount: number): Signal[] {
  const signals: Signal[] = [];

  const nsVals = Object.values(overview.namespaces);
  if (nsVals.length > 0) {
    const total = nsVals.reduce((s, n) => s + n.total, 0);
    const ready = nsVals.reduce((s, n) => s + n.ready, 0);
    const failed = nsVals.reduce((s, n) => s + n.failed, 0);
    const health: H =
      failed > 0 || ready < total * 0.5 ? "fail" : ready < total ? "warn" : "ok";
    signals.push({
      label: "Pods",
      health,
      detail: `${ready}/${total} ready${failed > 0 ? `, ${failed} failed` : ""}`,
    });
  }

  signals.push({
    label: "NIM",
    health: overview.nim.ready ? "ok" : "warn",
    detail: overview.nim.ready ? "ready" : `warming ${overview.nim.warmupPct}%`,
  });

  if (overview.gpus.length > 0) {
    const maxTemp = Math.max(...overview.gpus.map((g) => g.tempC));
    const health: H = maxTemp >= 85 ? "fail" : maxTemp >= 70 ? "warn" : "ok";
    signals.push({
      label: "GPU",
      health,
      detail: `${overview.gpus.length} GPU${overview.gpus.length !== 1 ? "s" : ""}, max ${maxTemp}°C`,
    });
  }

  const kafka = Object.values(overview.kafka);
  if (kafka.length > 0) {
    const measured = kafka
      .map((k) => k.consumerLagMsgs)
      .filter((v): v is number => v !== null);
    const unreachable = measured.length === 0;
    const lagSum = measured.reduce((s, v) => s + v, 0);
    const health: H = unreachable
      ? "warn"
      : lagSum > 1000
        ? "fail"
        : lagSum > 100
          ? "warn"
          : "ok";
    signals.push({
      label: "Kafka",
      health,
      detail: unreachable ? "unreachable" : `lag ${lagSum.toLocaleString()}`,
    });
  }

  const cs = overview.cameraSim;
  if (cs.instanceState !== "unreachable" || cs.pathsTotal > 0) {
    signals.push({
      label: "Cameras",
      health: cs.instanceState === "running" ? "ok" : "warn",
      detail: `${cs.pathsReady}/${cs.pathsTotal} paths · ${cs.instanceState}`,
    });
  }

  if (warningCount > 0) {
    signals.push({
      label: "Monitoring",
      health: "warn",
      detail: `${warningCount} probe${warningCount > 1 ? "s" : ""} degraded`,
    });
  }

  return signals;
}

export function HealthBanner({
  overview,
  warningCount,
}: {
  overview: OverviewSnapshot;
  warningCount: number;
}) {
  const signals = buildSignals(overview, warningCount);
  if (signals.length === 0) return null;

  const overall = worst(signals.map((s) => s.health));
  const issues = signals.filter((s) => s.health !== "ok").length;
  const style = OVERALL[overall];

  return (
    <div
      className={cn(
        "flex flex-wrap items-center justify-between gap-x-6 gap-y-3 rounded-lg border p-4",
        style.box
      )}
    >
      <div className="flex items-center gap-3">
        <span
          className={cn(
            "h-3 w-3 rounded-full",
            DOT[overall],
            overall !== "ok" && "animate-pulse"
          )}
        />
        <div>
          <p className={cn("text-sm font-semibold", style.text)}>{style.word}</p>
          {overall !== "ok" && (
            <p className="text-xs text-muted-foreground">
              {issues} of {signals.length} signals need attention
            </p>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
        {signals.map((s) => (
          <span key={s.label} className="inline-flex items-center gap-1.5 text-xs">
            <span className={cn("h-1.5 w-1.5 rounded-full shrink-0", DOT[s.health])} />
            <span className="font-medium text-foreground">{s.label}</span>
            <span className="text-muted-foreground">{s.detail}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

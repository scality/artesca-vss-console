import Link from "next/link";
import { StatusBadge } from "@/components/StatusBadge";
import type { PodSummary } from "@/lib/types";
import type { Health } from "@/lib/types";
import { cn } from "@/lib/utils";

interface NamespaceGroup {
  namespace: string;
  pods: PodSummary[];
  total: number;
  ready: number;
}

interface PodSummaryListProps {
  groups: NamespaceGroup[];
}

function podHealth(pod: PodSummary): Health {
  if (pod.phase === "Failed") return "fail";
  // A Succeeded pod is a completed Job — terminal success, not a degraded
  // workload. Treat it as healthy so it doesn't float into the "needs
  // attention" list or drag the namespace badge to WARN.
  if (pod.phase === "Succeeded") return "ok";
  if (pod.phase === "Running" && pod.ready) return "ok";
  if (pod.phase === "Running" && !pod.ready) return "warn";
  if (pod.phase === "Pending") return "warn";
  if (pod.restarts > 5) return "warn";
  return "unknown";
}

// Worst-first, so anything needing attention sits at the top of any list.
const HEALTH_RANK: Record<Health, number> = { fail: 0, warn: 1, unknown: 2, ok: 3 };

function podLabel(pod: PodSummary): string {
  // Running-but-not-ready is the common "still coming up" case — keep it
  // distinct from a clean Running so the breakdown line isn't misleading.
  if (pod.phase === "Running" && !pod.ready) return "NotReady";
  return pod.phase;
}

function statusBreakdown(pods: PodSummary[]): string {
  const counts = new Map<string, number>();
  for (const pod of pods) {
    const key = podLabel(pod);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([label, n]) => `${n} ${label}`)
    .join(" · ");
}

function PodRow({ pod }: { pod: PodSummary }) {
  return (
    <Link
      href={`/logs?ns=${encodeURIComponent(pod.namespace)}&pod=${encodeURIComponent(pod.name)}`}
      className="flex items-center justify-between gap-2 rounded px-2 py-1 text-xs hover:bg-accent/50 transition-colors"
    >
      <span className="font-mono truncate">{pod.name}</span>
      <div className="flex items-center gap-2 shrink-0">
        {pod.restarts > 0 && (
          <span className="text-yellow-400 tabular-nums">r:{pod.restarts}</span>
        )}
        <StatusBadge health={podHealth(pod)} label={pod.phase} />
      </div>
    </Link>
  );
}

function NamespaceCard({ group, wide }: { group: NamespaceGroup; wide: boolean }) {
  const nsHealth: Health =
    group.ready === group.total
      ? "ok"
      : group.ready < group.total * 0.5
        ? "fail"
        : "warn";

  const sorted = [...group.pods].sort(
    (a, b) => HEALTH_RANK[podHealth(a)] - HEALTH_RANK[podHealth(b)]
  );
  const unhealthy = sorted.filter((p) => podHealth(p) !== "ok");
  const hasPods = sorted.length > 0;

  return (
    <div className="rounded-lg border border-border bg-card p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-xs text-muted-foreground font-medium uppercase tracking-wider">
            namespace
          </p>
          <p className="font-mono text-sm font-semibold">{group.namespace}</p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-sm tabular-nums text-muted-foreground">
            {group.ready}/{group.total}
          </span>
          <StatusBadge health={nsHealth} />
        </div>
      </div>

      {hasPods && (
        <>
          <p className="text-xs text-muted-foreground">{statusBreakdown(sorted)}</p>

          {/* Pods needing attention are always visible — that's what an operator
              scans for. The healthy majority stays folded behind the toggle. */}
          {unhealthy.length > 0 && (
            <div className="space-y-1">
              {unhealthy.map((pod) => (
                <PodRow key={pod.name} pod={pod} />
              ))}
            </div>
          )}

          <details>
            <summary className="cursor-pointer text-xs font-medium text-muted-foreground hover:text-foreground">
              All {sorted.length} pods
            </summary>
            <div
              className={cn(
                "mt-2 grid gap-x-4 gap-y-0.5",
                wide
                  ? "sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
                  : "grid-cols-1"
              )}
            >
              {sorted.map((pod) => (
                <PodRow key={pod.name} pod={pod} />
              ))}
            </div>
          </details>
        </>
      )}
    </div>
  );
}

export function PodSummaryList({ groups }: PodSummaryListProps) {
  if (groups.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">No namespace data available.</p>
    );
  }

  // A single namespace (the Helm `alerts`-profile reality, where everything
  // lives in `vss-alerts`) gets the full row so its pod list can flow into
  // multiple columns instead of one tall stack. Multiple namespaces tile.
  const solo = groups.length === 1;

  return (
    <div className={solo ? "" : "grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3"}>
      {groups.map((group) => (
        <NamespaceCard key={group.namespace} group={group} wide={solo} />
      ))}
    </div>
  );
}

export type { NamespaceGroup };

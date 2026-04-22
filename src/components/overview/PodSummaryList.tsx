import Link from "next/link";
import { StatusBadge } from "@/components/StatusBadge";
import type { PodSummary } from "@/lib/types";
import type { Health } from "@/lib/types";

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
  if (pod.phase === "Running" && pod.ready) return "ok";
  if (pod.phase === "Running" && !pod.ready) return "warn";
  if (pod.phase === "Pending") return "warn";
  if (pod.restarts > 5) return "warn";
  return "unknown";
}

function NamespaceCard({ group }: { group: NamespaceGroup }) {
  const nsHealth: Health =
    group.ready === group.total
      ? "ok"
      : group.ready < group.total * 0.5
        ? "fail"
        : "warn";

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

      <div className="space-y-1">
        {group.pods.map((pod) => (
          <Link
            key={pod.name}
            href={`/logs?ns=${encodeURIComponent(pod.namespace)}&pod=${encodeURIComponent(pod.name)}`}
            className="flex items-center justify-between rounded px-2 py-1 text-xs hover:bg-accent/50 transition-colors"
          >
            <span className="font-mono truncate max-w-[200px]">{pod.name}</span>
            <div className="flex items-center gap-2 shrink-0">
              {pod.restarts > 0 && (
                <span className="text-yellow-400 tabular-nums">
                  r:{pod.restarts}
                </span>
              )}
              <StatusBadge health={podHealth(pod)} label={pod.phase} />
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}

export function PodSummaryList({ groups }: PodSummaryListProps) {
  if (groups.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">No namespace data available.</p>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {groups.map((group) => (
        <NamespaceCard key={group.namespace} group={group} />
      ))}
    </div>
  );
}

export type { NamespaceGroup };

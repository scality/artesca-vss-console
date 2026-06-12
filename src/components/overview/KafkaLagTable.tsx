import type { OverviewSnapshot } from "@/lib/types";
import { StatusBadge } from "@/components/StatusBadge";

interface KafkaLagTableProps {
  kafka: OverviewSnapshot["kafka"];
}

function lagHealth(lag: number | null) {
  if (lag === null) return "unknown" as const; // unreachable / not measured
  if (lag === 0) return "ok" as const;
  if (lag < 100) return "warn" as const;
  return "fail" as const;
}

export function KafkaLagTable({ kafka }: KafkaLagTableProps) {
  const entries = Object.values(kafka);

  if (entries.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">No Kafka topics found.</p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-xs text-muted-foreground uppercase">
            <th className="pb-2 text-left font-medium">Topic</th>
            <th className="pb-2 text-right font-medium">Lag (msgs)</th>
            <th className="pb-2 text-right font-medium">Status</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {entries.map((entry) => (
            <tr key={entry.topic} className="hover:bg-muted/30 transition-colors">
              <td className="py-2 font-mono text-xs">{entry.topic}</td>
              <td className="py-2 text-right tabular-nums font-medium">
                {entry.consumerLagMsgs === null
                  ? <span className="text-muted-foreground">unreachable</span>
                  : entry.consumerLagMsgs.toLocaleString()}
              </td>
              <td className="py-2 text-right">
                <StatusBadge health={lagHealth(entry.consumerLagMsgs)} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

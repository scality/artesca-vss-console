import type { Incident } from "@/lib/types";

interface IncidentRowProps {
  incident: Incident;
  onClick: () => void;
}

const SEVERITY_BADGE: Record<Incident["severity"], string> = {
  low: "bg-blue-500/15 text-blue-400 border-blue-500/30",
  medium: "bg-yellow-500/15 text-yellow-400 border-yellow-500/30",
  high: "bg-red-500/15 text-red-400 border-red-500/30",
};

export function IncidentRow({ incident, onClick }: IncidentRowProps) {
  const ts = new Date(incident.ts);
  const timeStr = ts.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const dateStr = ts.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });

  return (
    <tr
      onClick={onClick}
      className="cursor-pointer border-b border-border hover:bg-accent/30 transition-colors"
    >
      <td className="px-3 py-2 whitespace-nowrap">
        <div className="text-xs tabular-nums text-foreground">{timeStr}</div>
        <div className="text-[10px] text-muted-foreground">{dateStr}</div>
      </td>
      <td className="px-3 py-2">
        <span
          className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase ${SEVERITY_BADGE[incident.severity]}`}
        >
          {incident.severity}
        </span>
      </td>
      <td className="px-3 py-2 text-xs text-muted-foreground">
        {incident.scenarioName}
      </td>
      <td className="px-3 py-2">
        <span className="font-mono text-xs">{incident.sensorId}</span>
      </td>
      <td className="px-3 py-2 text-xs text-muted-foreground max-w-xs truncate">
        {incident.summary}
      </td>
    </tr>
  );
}

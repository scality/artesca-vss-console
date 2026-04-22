import { cn } from "@/lib/utils";

interface KpiCardProps {
  label: string;
  value: string | number;
  trend?: "up" | "down" | "flat";
  sub?: string;
  className?: string;
}

const TREND_STYLES = {
  up: "text-green-400",
  down: "text-red-400",
  flat: "text-muted-foreground",
};

const TREND_SYMBOLS = {
  up: "↑",
  down: "↓",
  flat: "→",
};

export function KpiCard({ label, value, trend, sub, className }: KpiCardProps) {
  return (
    <div
      className={cn(
        "rounded-lg border border-border bg-card p-4 space-y-1",
        className
      )}
    >
      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
        {label}
      </p>
      <div className="flex items-baseline gap-2">
        <p className="text-2xl font-bold tabular-nums">{value}</p>
        {trend && (
          <span className={cn("text-sm font-medium", TREND_STYLES[trend])}>
            {TREND_SYMBOLS[trend]}
          </span>
        )}
      </div>
      {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
    </div>
  );
}

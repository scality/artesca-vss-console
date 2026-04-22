import { type Health } from "@/lib/types";
import { cn } from "@/lib/utils";

const HEALTH_STYLES: Record<Health, string> = {
  ok: "bg-green-500/20 text-green-400 border-green-500/30",
  warn: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30",
  fail: "bg-red-500/20 text-red-400 border-red-500/30",
  unknown: "bg-muted text-muted-foreground border-border",
};

const HEALTH_LABELS: Record<Health, string> = {
  ok: "OK",
  warn: "WARN",
  fail: "FAIL",
  unknown: "UNKNOWN",
};

interface StatusBadgeProps {
  health: Health;
  label?: string;
  className?: string;
}

export function StatusBadge({ health, label, className }: StatusBadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded border px-2 py-0.5 text-xs font-medium",
        HEALTH_STYLES[health],
        className
      )}
    >
      <span className="mr-1.5 h-1.5 w-1.5 rounded-full bg-current" />
      {label ?? HEALTH_LABELS[health]}
    </span>
  );
}

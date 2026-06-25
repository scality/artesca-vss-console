import type { GpuState } from "@/lib/types";
import { cn } from "@/lib/utils";

interface GpuCardProps {
  gpu: GpuState;
}

/** L40S thresholds: warn >40 GiB used, crit >45 GiB used */
const WARN_MIB = 40 * 1024;
const CRIT_MIB = 45 * 1024;

function ProgressBar({
  value,
  max,
  warnAt,
  critAt,
}: {
  value: number;
  max: number;
  warnAt?: number;
  critAt?: number;
}) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  const isCrit = critAt !== undefined && value >= critAt;
  const isWarn = !isCrit && warnAt !== undefined && value >= warnAt;

  return (
    <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
      <div
        className={cn(
          "h-full rounded-full transition-all",
          isCrit
            ? "bg-red-600"
            : isWarn
              ? "bg-amber-500"
              : "bg-emerald-600"
        )}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

export function GpuCard({ gpu }: GpuCardProps) {
  const memGiB = (mib: number) => (mib / 1024).toFixed(1);
  const memPct =
    gpu.memoryTotalMiB > 0
      ? Math.round((gpu.memoryUsedMiB / gpu.memoryTotalMiB) * 100)
      : 0;

  const isCritTemp = gpu.tempC >= 85;
  const isWarnTemp = !isCritTemp && gpu.tempC >= 70;

  return (
    <div className="rounded-lg border border-border bg-card p-4 space-y-3">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-xs font-medium text-muted-foreground">
            GPU {gpu.index}
          </p>
          <p className="text-sm font-semibold truncate max-w-[160px]">
            {gpu.name}
          </p>
        </div>
        <span
          className={cn(
            "text-xs font-medium tabular-nums",
            isCritTemp
              ? "text-brand-red"
              : isWarnTemp
                ? "text-amber-700"
                : "text-muted-foreground"
          )}
        >
          {gpu.tempC}°C
        </span>
      </div>

      {/* GPU Utilization */}
      <div className="space-y-1">
        <div className="flex justify-between text-xs text-muted-foreground">
          <span>GPU</span>
          <span className="tabular-nums font-medium text-foreground">
            {gpu.utilGpu}%
          </span>
        </div>
        <ProgressBar
          value={gpu.utilGpu}
          max={100}
          warnAt={80}
          critAt={95}
        />
      </div>

      {/* Memory */}
      <div className="space-y-1">
        <div className="flex justify-between text-xs text-muted-foreground">
          <span>Mem</span>
          <span className="tabular-nums font-medium text-foreground">
            {memGiB(gpu.memoryUsedMiB)}/{memGiB(gpu.memoryTotalMiB)} GiB ({memPct}%)
          </span>
        </div>
        <ProgressBar
          value={gpu.memoryUsedMiB}
          max={gpu.memoryTotalMiB}
          warnAt={WARN_MIB}
          critAt={CRIT_MIB}
        />
      </div>

      {/* Power */}
      <div className="flex justify-between text-xs text-muted-foreground">
        <span>Power</span>
        <span className="tabular-nums font-medium text-foreground">
          {gpu.powerW.toFixed(0)} W
        </span>
      </div>

      {/* Active processes */}
      {gpu.processes.length > 0 && (
        <div className="space-y-0.5">
          {gpu.processes.slice(0, 3).map((proc) => (
            <div
              key={proc.pid}
              className="flex items-center justify-between text-xs text-muted-foreground"
            >
              <span className="truncate max-w-[120px]">{proc.name}</span>
              <span className="tabular-nums">
                {(proc.memMiB / 1024).toFixed(1)} GiB
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

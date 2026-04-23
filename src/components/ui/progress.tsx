import * as React from "react";
import { cn } from "@/lib/utils";

export interface ProgressProps extends React.HTMLAttributes<HTMLDivElement> {
  value?: number; // 0–100; clamped if out of range
}

export const Progress: React.FC<ProgressProps> = ({
  value,
  className,
  ...rest
}) => {
  const clamped = Math.min(100, Math.max(0, value ?? 0));

  return (
    <div
      role="progressbar"
      aria-valuenow={clamped}
      aria-valuemin={0}
      aria-valuemax={100}
      className={cn(
        "h-2 w-full overflow-hidden rounded-full bg-secondary",
        className
      )}
      {...rest}
    >
      <div
        className="h-full bg-primary transition-all"
        style={{ width: `${clamped}%` }}
      />
    </div>
  );
};

Progress.displayName = "Progress";

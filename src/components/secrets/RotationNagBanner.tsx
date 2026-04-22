"use client";

import { AlertTriangle } from "lucide-react";

interface RotationNagBannerProps {
  staleKeys: string[];
}

export function RotationNagBanner({ staleKeys }: RotationNagBannerProps) {
  if (staleKeys.length === 0) return null;

  return (
    <div className="flex items-start gap-3 rounded-md border border-destructive/60 bg-destructive/10 p-4 text-sm text-destructive">
      <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
      <div>
        <p className="font-semibold">Rotation overdue (&gt;90 days)</p>
        <p className="mt-0.5 text-destructive/80">
          {staleKeys.join(", ")} — rotate these keys before the next demo.
        </p>
      </div>
    </div>
  );
}

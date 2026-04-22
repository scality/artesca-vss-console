"use client";

import * as React from "react";
import { CheckCircle2, Circle, Loader2, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";

export type StepStatus = "pending" | "running" | "done" | "error";

export interface ProgressStep {
  label: string;
  status: StepStatus;
  detail?: string;
}

interface RegisterProgressProps {
  steps: ProgressStep[];
}

const icons: Record<StepStatus, React.ReactNode> = {
  pending: <Circle className="h-4 w-4 text-muted-foreground" />,
  running: <Loader2 className="h-4 w-4 text-primary animate-spin" />,
  done: <CheckCircle2 className="h-4 w-4 text-green-500" />,
  error: <XCircle className="h-4 w-4 text-destructive" />,
};

export function RegisterProgress({ steps }: RegisterProgressProps) {
  return (
    <ol className="space-y-2">
      {steps.map((step, idx) => (
        <li key={idx} className="flex items-start gap-2">
          <span className="mt-0.5 shrink-0">{icons[step.status]}</span>
          <div>
            <p
              className={cn(
                "text-sm",
                step.status === "done" && "text-muted-foreground line-through",
                step.status === "error" && "text-destructive",
                step.status === "running" && "font-medium"
              )}
            >
              {step.label}
            </p>
            {step.detail && (
              <p className="text-xs text-muted-foreground font-mono">
                {step.detail}
              </p>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}

export const DEFAULT_STEPS: ProgressStep[] = [
  { label: "Uploading .ts files...", status: "pending" },
  { label: "Patching ConfigMap...", status: "pending" },
  { label: "Restarting camera-sim...", status: "pending" },
  { label: "Re-registering sensors...", status: "pending" },
];

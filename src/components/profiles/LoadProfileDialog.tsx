"use client";

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type { DemoProfile } from "@/lib/types";

type Step = "idle" | "scenarios" | "prompt" | "cameras" | "tuning" | "model" | "done";

const STEPS: Step[] = ["scenarios", "prompt", "cameras", "tuning", "model", "done"];

interface DiffItem {
  label: string;
  current: string;
  incoming: string;
  changed: boolean;
}

interface LoadProfileDialogProps {
  open: boolean;
  profile: DemoProfile | null;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => Promise<void>;
}

export function LoadProfileDialog({
  open,
  profile,
  onOpenChange,
  onConfirm,
}: LoadProfileDialogProps) {
  const [step, setStep] = useState<Step>("idle");
  const [loading, setLoading] = useState(false);

  async function handleConfirm() {
    setLoading(true);
    setStep("scenarios");

    for (const s of STEPS) {
      setStep(s);
      await new Promise((r) => setTimeout(r, 400));
    }

    try {
      await onConfirm();
    } finally {
      setLoading(false);
      onOpenChange(false);
      setStep("idle");
    }
  }

  function stepLabel(s: Step): string {
    const labels: Record<Step, string> = {
      idle: "",
      scenarios: "Applying scenarios…",
      prompt: "Applying VLM prompt…",
      cameras: "Applying cameras…",
      tuning: "Applying tuning…",
      model: "Swapping NIM model…",
      done: "Done",
    };
    return labels[s];
  }

  if (!profile) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Load profile: {profile.name}</DialogTitle>
        </DialogHeader>

        {step === "idle" ? (
          <div className="space-y-3 py-2 text-sm">
            <p className="text-muted-foreground">This will replace the current config with:</p>
            <ul className="space-y-1">
              <li>
                <span className="font-medium">{profile.scenarios.length}</span> scenarios
              </li>
              <li>
                <span className="font-medium">{profile.cameras.length}</span> cameras
              </li>
              <li>
                NIM model: <span className="font-mono text-xs">{profile.nimModel}</span>
              </li>
              {profile.rtviTuning.kvCachePct != null && (
                <li>KV cache: {(profile.rtviTuning.kvCachePct * 100).toFixed(0)}%</li>
              )}
            </ul>
            <p className="text-xs text-muted-foreground mt-2">
              Saved {new Date(profile.savedAt).toLocaleString()} by {profile.savedBy}
            </p>
          </div>
        ) : (
          <div className="space-y-3 py-4 text-sm">
            {STEPS.map((s) => {
              const idx = STEPS.indexOf(s);
              const current = STEPS.indexOf(step);
              const done = idx < current || step === "done";
              const active = s === step && step !== "done";
              return (
                <div key={s} className="flex items-center gap-2">
                  <span className={done ? "text-emerald-700" : active ? "text-primary" : "text-muted-foreground"}>
                    {done ? "✓" : active ? "…" : "○"}
                  </span>
                  <span className={active ? "font-medium" : done ? "" : "text-muted-foreground"}>
                    {stepLabel(s)}
                  </span>
                </div>
              );
            })}
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={loading}>
            Cancel
          </Button>
          {step === "idle" && (
            <Button onClick={handleConfirm}>Load profile</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

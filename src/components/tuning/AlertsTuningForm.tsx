"use client";

import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { Loader2, Save, AlertTriangle, Lock } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";

const AlertsTuningResponseSchema = z.object({
  cooldownSeconds: z.number().int().nonnegative().default(120),
  slackWebhookConfigured: z.boolean().default(false),
});

type AlertsTuning = z.infer<typeof AlertsTuningResponseSchema>;

interface StepState {
  label: string;
  status: "pending" | "running" | "done" | "error";
}

const INITIAL_STEPS: StepState[] = [
  { label: "Patching ConfigMap...", status: "pending" },
  { label: "Restarting video analytics...", status: "pending" },
  { label: "Done", status: "pending" },
];

export function AlertsTuningForm() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [steps, setSteps] = React.useState<StepState[]>(INITIAL_STEPS);
  const [saving, setSaving] = React.useState(false);
  const [slackWebhook, setSlackWebhook] = React.useState("");
  const [slackDirty, setSlackDirty] = React.useState(false);

  const { data, isLoading, isError } = useQuery({
    queryKey: ["tuning", "alerts"],
    queryFn: async () => {
      const res = await fetch("/api/tuning/alerts");
      if (!res.ok) throw new Error("Failed to fetch alert tuning");
      const raw = await res.json();
      return AlertsTuningResponseSchema.parse(raw);
    },
    staleTime: 30_000,
  });

  const [localCooldown, setLocalCooldown] = React.useState<number | null>(null);

  React.useEffect(() => {
    if (data && localCooldown === null) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- initializing local edit copy from server data
      setLocalCooldown(data.cooldownSeconds);
    }
  }, [data, localCooldown]);

  const isDirty =
    (localCooldown !== null && data !== undefined && localCooldown !== data.cooldownSeconds) ||
    slackDirty;

  const setStep = (idx: number, status: StepState["status"]) => {
    setSteps((prev) =>
      prev.map((s, i) => (i === idx ? { ...s, status } : s))
    );
  };

  const doSave = async () => {
    setSaving(true);
    setSteps(INITIAL_STEPS.map((s) => ({ ...s, status: "pending" })));
    try {
      setStep(0, "running");
      const body: Record<string, unknown> = {};
      if (localCooldown !== null) body.cooldownSeconds = localCooldown;
      if (slackDirty && slackWebhook) body.slackWebhookUrl = slackWebhook;

      const res = await fetch("/api/tuning/alerts", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error("Patch failed");
      setStep(0, "done");
      setStep(1, "running");
      await new Promise((r) => setTimeout(r, 1500));
      setStep(1, "done");
      setStep(2, "done");
      setSlackWebhook("");
      setSlackDirty(false);
      await queryClient.invalidateQueries({ queryKey: ["tuning", "alerts"] });
      toast({ title: "Alert worker tuning saved" });
      setTimeout(() => setConfirmOpen(false), 1000);
    } catch (err) {
      setStep(0, "error");
      toast({
        title: "Save failed",
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-base font-semibold">Alert Worker Tuning</h3>
          <p className="text-sm text-muted-foreground">
            Cooldown and Slack integration. Changes restart the video analytics service.
          </p>
        </div>
        <Button
          size="sm"
          disabled={!isDirty || saving}
          onClick={() => setConfirmOpen(true)}
        >
          <Save className="h-4 w-4 mr-1" />
          Save + Restart
        </Button>
      </div>

      {isLoading && (
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading...
        </div>
      )}

      {isError && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
          Failed to load alert tuning values.
        </div>
      )}

      {data && localCooldown !== null && (
        <div className="space-y-5">
          <div className="space-y-1">
            <Label>cooldown_seconds</Label>
            <Input
              type="number"
              min={0}
              value={localCooldown}
              onChange={(e) =>
                setLocalCooldown(Math.max(0, parseInt(e.target.value) || 0))
              }
              className="w-32"
            />
            <p className="text-xs text-muted-foreground">
              Minimum seconds between repeated alerts for the same scenario.
              Default: 120.
            </p>
          </div>

          <div className="space-y-1">
            <Label className="flex items-center gap-1">
              Slack Webhook URL
              <Lock className="h-3 w-3 text-muted-foreground" />
            </Label>
            <div className="flex gap-2 items-center">
              <Input
                type="password"
                value={slackWebhook}
                onChange={(e) => {
                  setSlackWebhook(e.target.value);
                  setSlackDirty(true);
                }}
                placeholder={
                  data.slackWebhookConfigured
                    ? "Configured — paste new URL to replace"
                    : "https://hooks.slack.com/services/..."
                }
                className="max-w-md"
                autoComplete="off"
              />
              <span className="text-xs text-muted-foreground">
                {data.slackWebhookConfigured ? (
                  <span className="text-emerald-700">configured</span>
                ) : (
                  <span className="text-muted-foreground">not configured</span>
                )}
              </span>
            </div>
            <p className="text-xs text-muted-foreground">
              Write-only. The stored value is never shown. Paste a new URL to
              replace.
            </p>
          </div>

          {isDirty && (
            <div className="text-xs text-amber-700 bg-amber-50 rounded px-3 py-1.5 border border-amber-200">
              Unsaved changes
            </div>
          )}
        </div>
      )}

      <Dialog open={confirmOpen} onOpenChange={saving ? undefined : setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Save Alert Worker Tuning?</DialogTitle>
            <DialogDescription>
              This will patch the config and restart the video analytics service.
            </DialogDescription>
          </DialogHeader>

          {saving ? (
            <ul className="space-y-2 py-2">
              {steps.map((step, i) => (
                <li key={i} className="flex items-center gap-2 text-sm">
                  {step.status === "running" && <Loader2 className="h-4 w-4 animate-spin text-primary" />}
                  {step.status === "done" && <span className="text-emerald-700">✓</span>}
                  {step.status === "pending" && <span className="text-muted-foreground">○</span>}
                  {step.status === "error" && <span className="text-destructive">✗</span>}
                  <span className={step.status === "done" ? "line-through text-muted-foreground" : ""}>{step.label}</span>
                </li>
              ))}
            </ul>
          ) : (
            <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3">
              <AlertTriangle className="h-4 w-4 text-amber-700 mt-0.5 shrink-0" />
              <p className="text-sm text-amber-700">
                The video analytics service will restart briefly. In-flight alerts may be
                delayed.
              </p>
            </div>
          )}

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setConfirmOpen(false)}
              disabled={saving}
            >
              Cancel
            </Button>
            <Button onClick={doSave} disabled={saving}>
              {saving ? "Saving..." : "Confirm"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

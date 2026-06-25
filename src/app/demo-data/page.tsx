"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { redirect } from "next/navigation";
import { useKiosk } from "@/components/KioskProvider";
import { Shell } from "@/components/Shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { RehearsalButton } from "@/components/demo-data/RehearsalButton";
import { LiveCounter } from "@/components/demo-data/LiveCounter";
import { useToast } from "@/hooks/use-toast";

interface DemoDataState {
  enabled: boolean;
  replicas: number;
  tickRate: number;
  matchProbability: number;
}

const DEBOUNCE_MS = 600;

export default function DemoDataPage() {
  const { kiosk } = useKiosk();
  if (kiosk) redirect("/");

  const [state, setState] = useState<DemoDataState>({
    enabled: false,
    replicas: 0,
    tickRate: 1.0,
    matchProbability: 0.3,
  });
  const [loading, setLoading] = useState(true);
  const [confirmDisableOpen, setConfirmDisableOpen] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { toast } = useToast();

  useEffect(() => {
    fetch("/api/demo-data")
      .then((r) => r.json())
      .then((data: DemoDataState) => setState(data))
      .catch(() => {
        toast({ title: "Failed to load demo-data state", variant: "destructive" });
      })
      .finally(() => setLoading(false));
  }, [toast]);

  const patchState = useCallback(
    async (patch: Partial<DemoDataState>) => {
      const next = { ...state, ...patch };
      setState(next);
      try {
        const res = await fetch("/api/demo-data", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        });
        if (!res.ok) throw new Error(await res.text());
      } catch (err) {
        toast({ title: "Update failed", description: String(err), variant: "destructive" });
      }
    },
    [state, toast]
  );

  function debouncedPatch(patch: Partial<DemoDataState>) {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    setState((s) => ({ ...s, ...patch }));
    debounceRef.current = setTimeout(() => {
      patchState(patch);
    }, DEBOUNCE_MS);
  }

  if (loading) {
    return (
      <Shell>
        <div className="text-muted-foreground">Loading demo-data state…</div>
      </Shell>
    );
  }

  return (
    <Shell>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Demo Data</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Control the synthetic demo-data producer and rehearsal burst.
          </p>
        </div>

        {/* Status + toggle */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Producer status</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center gap-4">
              <Badge
                variant={state.replicas > 0 ? "default" : "secondary"}
                className={state.replicas > 0 ? "bg-emerald-700" : ""}
              >
                {state.replicas > 0 ? "Running" : "Stopped"} — {state.replicas} replica{state.replicas !== 1 ? "s" : ""}
              </Badge>
              <span className="text-sm text-muted-foreground">
                Tick rate: {state.tickRate.toFixed(1)}/s &middot; Match prob: {(state.matchProbability * 100).toFixed(0)}%
              </span>
            </div>
            <div className="flex items-center gap-3">
              <Switch
                id="enabled"
                checked={state.enabled}
                onCheckedChange={(checked) => {
                  if (!checked) {
                    setConfirmDisableOpen(true);
                  } else {
                    patchState({ enabled: true });
                  }
                }}
              />
              <Label htmlFor="enabled" className="text-sm font-medium">
                {state.enabled ? "Enabled" : "Disabled"}
              </Label>
            </div>
          </CardContent>
        </Card>

        {/* Sliders */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Tuning</CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="space-y-2">
              <Label>Tick rate: {state.tickRate.toFixed(1)} / sec</Label>
              <input
                type="range"
                min={0.1}
                max={10}
                step={0.1}
                value={state.tickRate}
                onChange={(e) => debouncedPatch({ tickRate: parseFloat(e.target.value) })}
                className="w-full accent-primary"
              />
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>0.1/s</span><span>10/s</span>
              </div>
            </div>

            <div className="space-y-2">
              <Label>Match probability: {(state.matchProbability * 100).toFixed(0)}%</Label>
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={state.matchProbability}
                onChange={(e) => debouncedPatch({ matchProbability: parseFloat(e.target.value) })}
                className="w-full accent-primary"
              />
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>0%</span><span>100%</span>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Rehearsal mode */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Rehearsal mode</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              60-second burst at high match probability — use before a live demo to verify the alert pipeline end-to-end.
            </p>
            <RehearsalButton disabled={!state.enabled} />
          </CardContent>
        </Card>

        {/* Live counter */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Live throughput</CardTitle>
          </CardHeader>
          <CardContent>
            <LiveCounter />
          </CardContent>
        </Card>
      </div>

      <Dialog open={confirmDisableOpen} onOpenChange={setConfirmDisableOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Disable demo data?</DialogTitle>
            <DialogDescription>
              The synthetic incident feed will stop. Any ongoing rehearsal will end and the
              producer pod will scale down.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setConfirmDisableOpen(false)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setConfirmDisableOpen(false);
                patchState({ enabled: false });
              }}
            >
              Disable
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Shell>
  );
}

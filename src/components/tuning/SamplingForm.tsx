"use client";

import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { Loader2, Save, Film } from "lucide-react";

const SamplingSchema = z.object({
  framesPerChunk: z.number().int().min(1).max(30),
  useFps: z.boolean(),
  chunkDuration: z.number().int().min(5).max(120),
  warning: z.string().optional(),
});
type Sampling = z.infer<typeof SamplingSchema>;
type SamplingEdit = Omit<Sampling, "warning">;

/** Human label for the effective sampling cadence. */
function cadence(s: SamplingEdit): string {
  if (s.useFps) {
    const everySec = s.framesPerChunk > 0 ? 1 / s.framesPerChunk : 0;
    return `${s.framesPerChunk} fps → 1 frame every ${everySec.toFixed(everySec < 1 ? 2 : 1)} s · ~${Math.round(s.framesPerChunk * s.chunkDuration)} frames/chunk`;
  }
  const everySec = s.framesPerChunk > 0 ? s.chunkDuration / s.framesPerChunk : 0;
  return `${s.framesPerChunk} frames per ${s.chunkDuration} s chunk → 1 frame every ${everySec.toFixed(everySec % 1 ? 1 : 0)} s`;
}

export function SamplingForm() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [saving, setSaving] = React.useState(false);
  const [local, setLocal] = React.useState<SamplingEdit | null>(null);

  const { data, isLoading, isError } = useQuery({
    queryKey: ["tuning", "sampling"],
    queryFn: async () => {
      const res = await fetch("/api/tuning/sampling");
      if (!res.ok) throw new Error("Failed to fetch sampling");
      return SamplingSchema.parse(await res.json());
    },
    staleTime: 30_000,
  });

  React.useEffect(() => {
    if (data && local === null) {
      const { warning: _w, ...rest } = data;
      void _w;
      // eslint-disable-next-line react-hooks/set-state-in-effect -- seed local edit copy from server
      setLocal(rest);
    }
  }, [data, local]);

  const isDirty = React.useMemo(() => {
    if (!local || !data) return false;
    const { warning: _w, ...rest } = data;
    void _w;
    return JSON.stringify(local) !== JSON.stringify(rest);
  }, [local, data]);

  const update = <K extends keyof SamplingEdit>(key: K, val: SamplingEdit[K]) => {
    setLocal((prev) => (prev ? { ...prev, [key]: val } : null));
  };

  const doSave = async () => {
    if (!local) return;
    setSaving(true);
    try {
      const res = await fetch("/api/tuning/sampling", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(local),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error ?? "Patch failed");
      await queryClient.invalidateQueries({ queryKey: ["tuning", "sampling"] });
      toast({
        title: "Frame sampling saved",
        description: json?.note ?? "Rules re-seeding from the updated config.",
      });
    } catch (err) {
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
          <h3 className="text-base font-semibold flex items-center gap-2">
            <Film className="h-4 w-4" />
            VLM Frame Sampling
          </h3>
          <p className="text-sm text-muted-foreground">
            How many frames per chunk the VLM analyses for realtime alerts. Fewer
            frames = lower GPU load and coarser temporal detail. Applies to all
            cameras; no VLM restart — rules re-seed within ~15&nbsp;s.
          </p>
        </div>
        <Button size="sm" disabled={!isDirty || saving} onClick={doSave}>
          {saving ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Save className="h-4 w-4 mr-1" />}
          Save
        </Button>
      </div>

      {isLoading && (
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading…
        </div>
      )}
      {isError && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
          Failed to load frame-sampling values.
        </div>
      )}

      {local && (
        <div className="space-y-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <Label htmlFor="use-fps">Interpret value as frames-per-second</Label>
              <p className="text-xs text-muted-foreground">
                Off = a fixed number of frames spread evenly across the chunk
                (recommended). On = frames sampled per second of video.
              </p>
            </div>
            <Switch id="use-fps" checked={local.useFps} onCheckedChange={(v) => update("useFps", v)} />
          </div>

          <div className="space-y-1">
            <Label htmlFor="frames">
              {local.useFps ? "Frames per second" : "Frames per chunk"}
            </Label>
            <Input
              id="frames"
              type="number"
              min={1}
              max={30}
              value={local.framesPerChunk}
              onChange={(e) =>
                update("framesPerChunk", Math.max(1, Math.min(30, parseInt(e.target.value) || 1)))
              }
              className="w-32"
            />
          </div>

          <div className="space-y-1">
            <Label htmlFor="chunk">Chunk duration (s)</Label>
            <Input
              id="chunk"
              type="number"
              min={5}
              max={120}
              value={local.chunkDuration}
              onChange={(e) =>
                update("chunkDuration", Math.max(5, Math.min(120, parseInt(e.target.value) || 30)))
              }
              className="w-32"
            />
          </div>

          <div className="rounded-md border border-border bg-muted/20 p-3 text-sm">
            <span className="text-muted-foreground">Effective cadence: </span>
            <span className="font-mono">{cadence(local)}</span>
          </div>

          {isDirty && (
            <div className="text-xs text-amber-700 bg-amber-50 rounded px-3 py-1.5 border border-amber-200">
              Unsaved changes
            </div>
          )}
        </div>
      )}
    </div>
  );
}

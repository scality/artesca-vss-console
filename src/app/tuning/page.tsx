"use client";

import { redirect } from "next/navigation";
import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { useKiosk } from "@/components/KioskProvider";
import { Shell } from "@/components/Shell";
import { RtviTuningForm } from "@/components/tuning/RtviTuningForm";
import { SamplingForm } from "@/components/tuning/SamplingForm";
import { AlertsTuningForm } from "@/components/tuning/AlertsTuningForm";
import { VstRecordingForm } from "@/components/tuning/VstRecordingForm";
import { StreamDensityCard } from "@/components/tuning/StreamDensityCard";
import { Loader2, Cpu, AlertTriangle } from "lucide-react";

const PromptResponseSchema = z.object({
  model: z.string(),
});

const OverviewSnapshotSchema = z.object({
  gpus: z
    .array(
      z.object({
        memoryUsedMiB: z.number(),
        memoryTotalMiB: z.number(),
        utilGpu: z.number(),
        name: z.string(),
      })
    )
    .optional(),
});

export default function TuningPage() {
  const { kiosk } = useKiosk();
  if (kiosk) redirect("/");

  const { data: promptData } = useQuery({
    queryKey: ["prompt"],
    queryFn: async () => {
      const res = await fetch("/api/prompt");
      if (!res.ok) return { model: "unknown" };
      const raw = await res.json();
      return PromptResponseSchema.parse(raw);
    },
    staleTime: 60_000,
  });

  const { data: overviewData } = useQuery({
    queryKey: ["status-overview"],
    queryFn: async () => {
      const res = await fetch("/api/status/overview");
      if (!res.ok) return { gpus: [] };
      const raw = await res.json();
      return OverviewSnapshotSchema.parse(raw);
    },
    staleTime: 30_000,
    refetchInterval: 30_000,
  });

  const gpuPressure = React.useMemo(() => {
    if (!overviewData?.gpus?.length) return null;
    const gpu = overviewData.gpus[0];
    const pct = Math.round((gpu.memoryUsedMiB / gpu.memoryTotalMiB) * 100);
    return { name: gpu.name, pct, utilGpu: gpu.utilGpu };
  }, [overviewData]);

  return (
    <Shell>
      <div className="max-w-3xl mx-auto space-y-8">
        <div>
          <h2 className="text-lg font-semibold">Tuning</h2>
          <p className="text-sm text-muted-foreground">
            Adjust inference and alerting parameters. All changes require a
            restart of the relevant service.
          </p>
        </div>

        {/* Context: current model + GPU pressure */}
        {(promptData || gpuPressure) && (
          <div className="rounded-lg border border-border bg-muted/20 p-4 flex flex-wrap gap-6 text-sm">
            {promptData && (
              <div>
                <p className="text-xs text-muted-foreground">Current NIM</p>
                <p className="font-mono">{promptData.model}</p>
              </div>
            )}
            {gpuPressure && (
              <div>
                <p className="text-xs text-muted-foreground flex items-center gap-1">
                  <Cpu className="h-3 w-3" />
                  {gpuPressure.name} GPU
                </p>
                <p className="font-mono">
                  {gpuPressure.pct}% VRAM · {gpuPressure.utilGpu}% util
                  {gpuPressure.pct > 85 && (
                    <span className="ml-2 text-amber-700 text-xs">
                      <AlertTriangle className="inline h-3 w-3 mr-0.5" />
                      high pressure
                    </span>
                  )}
                </p>
              </div>
            )}
          </div>
        )}

        <StreamDensityCard />

        <div className="rounded-lg border border-border p-5">
          <SamplingForm />
        </div>

        <div className="rounded-lg border border-border p-5">
          <RtviTuningForm />
        </div>

        <div className="rounded-lg border border-border p-5">
          <AlertsTuningForm />
        </div>

        <div className="rounded-lg border border-border p-5">
          <VstRecordingForm />
        </div>
      </div>
    </Shell>
  );
}

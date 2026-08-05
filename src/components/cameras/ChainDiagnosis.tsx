"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { Badge } from "@/components/ui/badge";
import { AlertTriangle, CheckCircle2, HelpCircle, MinusCircle, XCircle } from "lucide-react";

// Renders WHY a camera is not producing incidents-with-video. The badges on the
// row say what the state is (REC / VLM / PERSISTED); this says which link in the
// chain is broken and what to do — the gap that let a dead recorder S3 endpoint
// sit unnoticed behind a grey "NOT RECORDING" chip.

const StepSchema = z.object({
  id: z.string(),
  label: z.string(),
  state: z.enum(["ok", "fail", "warn", "blocked", "unknown"]),
  detail: z.string().optional(),
  fix: z.string().optional(),
});

const ChainSchema = z.object({
  cameraId: z.string(),
  rtspUrl: z.string().optional(),
  steps: z.array(StepSchema),
  verdict: z
    .object({
      state: z.enum(["ok", "fail", "warn", "blocked", "unknown"]),
      reason: z.string(),
      fix: z.string().optional(),
    })
    .optional(),
});

const StorageSchema = z.object({
  state: z.enum(["ok", "fail", "unknown"]),
  reason: z.string().optional(),
  fix: z.string().optional(),
  recorderEndpoint: z.string().optional(),
  consoleEndpoint: z.string().optional(),
  bucket: z.string().optional(),
  accessKeyId: z.string().optional(),
  checkedAt: z.string(),
});

const ReportSchema = z.object({
  cameras: z.array(ChainSchema),
  storage: StorageSchema,
  checkedAt: z.string(),
  warnings: z.array(z.string()).default([]),
  ok: z.boolean().optional(),
  unhealthy: z.array(z.string()).default([]),
});

export type ChainReport = z.infer<typeof ReportSchema>;
/** Per-camera diagnosis handed down to a row. */
export type ChainForCamera = z.infer<typeof ChainSchema>;
type Chain = ChainForCamera;
type StepState = z.infer<typeof StepSchema>["state"];

export function useCameraChain() {
  return useQuery({
    queryKey: ["camera-chain"],
    queryFn: async (): Promise<ChainReport> => {
      const res = await fetch("/api/diagnostics/camera-chain");
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: "Unknown error" }));
        throw new Error(body.error ?? "Diagnosis unavailable");
      }
      return ReportSchema.parse(await res.json());
    },
    staleTime: 20_000,
    refetchInterval: 30_000,
  });
}

function StepIcon({ state }: { state: StepState }) {
  const cls = "h-3.5 w-3.5 shrink-0";
  if (state === "ok") return <CheckCircle2 className={`${cls} text-emerald-600`} />;
  if (state === "fail") return <XCircle className={`${cls} text-red-600`} />;
  if (state === "warn") return <AlertTriangle className={`${cls} text-amber-600`} />;
  if (state === "blocked") return <MinusCircle className={`${cls} text-muted-foreground`} />;
  return <HelpCircle className={`${cls} text-muted-foreground`} />;
}

/** Compact one-line verdict for the camera row. */
export function ChainVerdictBadge({ chain }: { chain?: Chain }) {
  if (!chain) return null;
  if (!chain.verdict) {
    return (
      <Badge
        variant="outline"
        className="text-xs bg-emerald-50 border-emerald-200 text-emerald-700"
        title="Source, VST registration, recording, VLM rule and scenario binding all check out."
      >
        chain ok
      </Badge>
    );
  }
  const failing = chain.verdict.state === "fail";
  return (
    <Badge
      variant="outline"
      className={
        failing
          ? "text-xs bg-red-50 border-red-200 text-red-700"
          : "text-xs bg-amber-50 border-amber-200 text-amber-700"
      }
      title={chain.verdict.fix ?? chain.verdict.reason}
    >
      {chain.verdict.reason}
    </Badge>
  );
}

/** Full chain breakdown, shown in the expanded camera detail. */
export function ChainSteps({ chain }: { chain?: Chain }) {
  if (!chain) {
    return <p className="text-xs text-muted-foreground">Diagnosis unavailable.</p>;
  }
  return (
    <ul className="space-y-1.5">
      {chain.steps.map((s) => (
        <li key={s.id} className="flex items-start gap-2 text-xs">
          <span className="mt-0.5">
            <StepIcon state={s.state} />
          </span>
          <span className="min-w-0">
            <span className="font-medium">{s.label}</span>
            {s.detail && (
              <span className="text-muted-foreground"> — {s.detail}</span>
            )}
            {s.fix && (
              <span className="block text-muted-foreground italic mt-0.5">
                Fix: {s.fix}
              </span>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Cluster-wide object-storage banner. Recording is a shared dependency: when
 * the recorder cannot write to ARTESCA S3, every camera stops recording at once
 * and no incident has video. Surfacing it once, at the top, keeps five
 * identical per-camera errors from hiding one root cause.
 */
export function StoragePreflightBanner({ report }: { report?: ChainReport }) {
  if (!report) return null;
  const s = report.storage;
  if (s.state === "ok") return null;

  const failing = s.state === "fail";
  return (
    <div
      className={
        failing
          ? "rounded border border-red-200 bg-red-50 px-3 py-2"
          : "rounded border border-amber-200 bg-amber-50 px-3 py-2"
      }
    >
      <div className="flex items-start gap-2">
        {failing ? (
          <XCircle className="h-4 w-4 text-red-600 mt-0.5 shrink-0" />
        ) : (
          <HelpCircle className="h-4 w-4 text-amber-600 mt-0.5 shrink-0" />
        )}
        <div className="text-xs">
          <p className={failing ? "font-medium text-red-800" : "font-medium text-amber-800"}>
            Object storage: {s.reason ?? "state unknown"}
          </p>
          <p className="text-muted-foreground mt-0.5">
            No camera can record while this is broken, and incidents will have no
            video.
          </p>
          {s.fix && <p className="text-muted-foreground italic mt-0.5">Fix: {s.fix}</p>}
          <p className="text-muted-foreground mt-1 font-mono">
            recorder → {s.recorderEndpoint ?? "(unset)"}
            {s.bucket ? ` · bucket ${s.bucket}` : ""}
            {s.accessKeyId ? ` · key ${s.accessKeyId}` : ""}
          </p>
          {s.recorderEndpoint &&
            s.consoleEndpoint &&
            s.recorderEndpoint !== s.consoleEndpoint && (
              <p className="text-muted-foreground mt-0.5 font-mono">
                console → {s.consoleEndpoint} (differs from the recorder)
              </p>
            )}
        </div>
      </div>
    </div>
  );
}

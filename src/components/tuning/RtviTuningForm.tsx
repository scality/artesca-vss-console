"use client";

import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { Loader2, Save, AlertTriangle, ChevronDown, ChevronRight } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { SliderWithLabel } from "./SliderWithLabel";

const TuningResponseSchema = z.object({
  maxNumSeqs: z.number().int().default(4),
  kvCachePct: z.number().min(0).max(1).default(0.8),
  maxModelLen: z.number().int().default(32768),
  modelProfile: z.string().default(""),
  disableCudaGraph: z.boolean().default(false),
  numSchedulerSteps: z.number().int().default(8),
  maxNumBatchedTokens: z.number().int().default(5120),
});

type Tuning = z.infer<typeof TuningResponseSchema>;

interface StepState {
  label: string;
  status: "pending" | "running" | "done" | "error";
}

const INITIAL_STEPS: StepState[] = [
  { label: "Patching ConfigMap...", status: "pending" },
  { label: "Restarting VLM...", status: "pending" },
  { label: "Done", status: "pending" },
];

const MODEL_PROFILE_OPTIONS = [
  {
    value: "",
    label: "Auto-detect (default)",
    description:
      "NIM picks the best FP8 profile for the detected GPU. Recommended for development.",
  },
  {
    value: "55d063fe1cc5e3c0bd8eb943fcdaf66e9c56502a0ddb3901a9af7d86c0c1b125",
    label: "L40S FP8 tp2 (baseline)",
    description:
      "Explicit pin for 2× L40S, FP8 weights, tensor-parallel split. Same as auto-detect on this hardware.",
  },
  {
    value: "cbd8d45d270581ebba823e24cdfab3426dd82fb17a3cba9fc42b5bc802aad534",
    label: "L40S FP8 tp2 + Eagle-2 (recommended for throughput)",
    description:
      "Speculative decoding: predicts multiple tokens per forward pass, verified by the full model. ~1.5-2× throughput, <1% quality regression on standard benchmarks. Validate on a Pyramid-representative eval set before showroom deploy.",
  },
  {
    value: "f4be5f85a5619ea05f507add4d5bd91096c9793994f4f172b2797b864fbc3d73",
    label: "L40S FP8 tp1 (single GPU)",
    description:
      "Only the first GPU runs the VLM. Frees GPU #2 for rtvi-embed or a second tenant.",
  },
  {
    value: "6d3ac7d382db37f3d6af16ff882d1aaeeb769c473a48233d91db82a7a0d0a4ae",
    label: "BF16 fallback (debug)",
    description:
      "BF16 weights, tp2. ~2× weight memory. Use only when FP8 hits an unexpected kernel issue.",
  },
] as const;

interface CollapsibleSectionProps {
  title: string;
  children: React.ReactNode;
}

function CollapsibleSection({ title, children }: CollapsibleSectionProps) {
  const [open, setOpen] = React.useState(false);
  return (
    <div className="border border-border rounded-md">
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-2 text-sm font-medium text-left hover:bg-muted/50 rounded-md transition-colors"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        {open ? (
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
        )}
        {title}
      </button>
      {open && <div className="px-3 pb-4 pt-2 space-y-5">{children}</div>}
    </div>
  );
}

export function RtviTuningForm() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [steps, setSteps] = React.useState<StepState[]>(INITIAL_STEPS);
  const [saving, setSaving] = React.useState(false);

  const { data, isLoading, isError } = useQuery({
    queryKey: ["tuning", "rtvi"],
    queryFn: async () => {
      const res = await fetch("/api/tuning/rtvi");
      if (!res.ok) throw new Error("Failed to fetch tuning");
      const raw = await res.json();
      return TuningResponseSchema.parse(raw);
    },
    staleTime: 30_000,
  });

  const [local, setLocal] = React.useState<Tuning | null>(null);

  React.useEffect(() => {
    if (data && local === null) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- initializing local edit copy from server data
      setLocal(data);
    }
  }, [data, local]);

  const isDirty =
    local !== null &&
    data !== undefined &&
    JSON.stringify(local) !== JSON.stringify(data);

  const setStep = (idx: number, status: StepState["status"]) => {
    setSteps((prev) =>
      prev.map((s, i) => (i === idx ? { ...s, status } : s))
    );
  };

  const doSave = async () => {
    if (!local) return;
    setSaving(true);
    setSteps(INITIAL_STEPS.map((s) => ({ ...s, status: "pending" })));
    try {
      setStep(0, "running");
      const res = await fetch("/api/tuning/rtvi", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          maxNumSeqs: local.maxNumSeqs,
          kvCachePercent: local.kvCachePct,
          maxModelLen: local.maxModelLen,
          modelProfile: local.modelProfile,
          disableCudaGraph: local.disableCudaGraph,
          numSchedulerSteps: local.numSchedulerSteps,
          maxNumBatchedTokens: local.maxNumBatchedTokens,
        }),
      });
      if (!res.ok) throw new Error("Patch failed");
      setStep(0, "done");
      setStep(1, "running");
      // Give a moment for the restart to register
      await new Promise((r) => setTimeout(r, 2000));
      setStep(1, "done");
      setStep(2, "done");
      await queryClient.invalidateQueries({ queryKey: ["tuning", "rtvi"] });
      toast({ title: "VLM tuning saved — restarting" });
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

  const update = <K extends keyof Tuning>(key: K, val: Tuning[K]) => {
    setLocal((prev) => (prev ? { ...prev, [key]: val } : null));
  };

  const selectedProfile = MODEL_PROFILE_OPTIONS.find(
    (o) => o.value === (local?.modelProfile ?? "")
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-base font-semibold">VLM Tuning</h3>
          <p className="text-sm text-muted-foreground">
            Inference engine parameters. Changes restart the VLM (~30 s).
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
          Failed to load tuning values.
        </div>
      )}

      {local && (
        <div className="space-y-5">
          {/* ── Existing 3 knobs ─────────────────────────────────────────── */}
          <div className="space-y-1">
            <Label>max_num_seqs</Label>
            <Input
              type="number"
              min={1}
              max={16}
              value={local.maxNumSeqs}
              onChange={(e) =>
                update("maxNumSeqs", Math.max(1, Math.min(16, parseInt(e.target.value) || 1)))
              }
              className="w-32"
            />
            <p className="text-xs text-muted-foreground">
              Maximum concurrent sequences (1–16). Default: 4.
            </p>
          </div>

          <SliderWithLabel
            label="kv_cache_percent"
            value={local.kvCachePct}
            min={0}
            max={1}
            step={0.05}
            onChange={(v) => update("kvCachePct", Math.round(v * 100) / 100)}
            formatValue={(v) => v.toFixed(2)}
            description="Fraction of GPU memory allocated to KV cache (0–1). Default: 0.8."
          />

          <div className="space-y-1">
            <Label>max_model_len</Label>
            <Input
              type="number"
              min={1024}
              max={131072}
              step={1024}
              value={local.maxModelLen}
              onChange={(e) =>
                update(
                  "maxModelLen",
                  Math.max(1024, Math.min(131072, parseInt(e.target.value) || 32768))
                )
              }
              className="w-40"
            />
            <p className="text-xs text-muted-foreground">
              Maximum token context length (1024–131072). Default: 32768.
            </p>
          </div>

          {/* ── Section 1: Inference engine (advanced) ───────────────────── */}
          <CollapsibleSection title="Inference engine (advanced)">
            <div className="space-y-1">
              <div className="flex items-center gap-3">
                <Label htmlFor="disable-cuda-graph">NIM_DISABLE_CUDA_GRAPH</Label>
                <input
                  id="disable-cuda-graph"
                  type="checkbox"
                  checked={local.disableCudaGraph}
                  onChange={(e) => update("disableCudaGraph", e.target.checked)}
                  className="h-4 w-4 accent-primary cursor-pointer"
                />
                <span className="text-sm text-muted-foreground">
                  {local.disableCudaGraph ? "Disabled" : "Enabled"}
                </span>
              </div>
              <p className="text-xs text-muted-foreground">
                Capture-and-replay CUDA graphs for the model&apos;s forward pass. Adds ~10-20%
                throughput. Was disabled to save memory on smaller GPUs; on L40S (48 GB)
                there&apos;s plenty of room. Disable only if VRAM is genuinely tight.
              </p>
            </div>

            <div className="space-y-1">
              <Label>VLLM_NUM_SCHEDULER_STEPS</Label>
              <Input
                type="number"
                min={1}
                max={32}
                value={local.numSchedulerSteps}
                onChange={(e) =>
                  update(
                    "numSchedulerSteps",
                    Math.max(1, Math.min(32, parseInt(e.target.value) || 8))
                  )
                }
                className="w-32"
              />
              <p className="text-xs text-muted-foreground">
                vLLM scheduler ticks per forward pass. Higher = more pipelining, better GPU
                utilization. Default 8; 16 is a safe bump on L40S. No quality impact.
              </p>
            </div>

            <div className="space-y-1">
              <Label>VLLM_MAX_NUM_BATCHED_TOKENS</Label>
              <Input
                type="number"
                min={1024}
                max={32768}
                step={1024}
                value={local.maxNumBatchedTokens}
                onChange={(e) =>
                  update(
                    "maxNumBatchedTokens",
                    Math.max(1024, Math.min(32768, parseInt(e.target.value) || 5120))
                  )
                }
                className="w-40"
              />
              <p className="text-xs text-muted-foreground">
                Maximum tokens processed per forward pass. Higher = better GPU utilization on
                prefill-heavy workloads. Default 5120; 8192 is the sweet spot for L40S.
              </p>
            </div>
          </CollapsibleSection>

          {/* ── Section 2: Speculative decoding ──────────────────────────── */}
          <CollapsibleSection title="Speculative decoding">
            <div className="space-y-2">
              <Label htmlFor="model-profile">NIM_MODEL_PROFILE</Label>
              <select
                id="model-profile"
                value={local.modelProfile}
                onChange={(e) => update("modelProfile", e.target.value)}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
              >
                {MODEL_PROFILE_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
              {selectedProfile && (
                <p className="text-xs text-muted-foreground">
                  {selectedProfile.description}
                </p>
              )}
            </div>
          </CollapsibleSection>

          {isDirty && (
            <div className="text-xs text-yellow-400 bg-yellow-400/10 rounded px-3 py-1.5 border border-yellow-400/20">
              Unsaved changes
            </div>
          )}
        </div>
      )}

      <Dialog open={confirmOpen} onOpenChange={saving ? undefined : setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Save VLM Tuning?</DialogTitle>
            <DialogDescription>
              This will patch the deployment and restart the VLM.
            </DialogDescription>
          </DialogHeader>

          {saving ? (
            <ul className="space-y-2 py-2">
              {steps.map((step, i) => (
                <li key={i} className="flex items-center gap-2 text-sm">
                  {step.status === "running" && <Loader2 className="h-4 w-4 animate-spin text-primary" />}
                  {step.status === "done" && <span className="text-green-500">✓</span>}
                  {step.status === "pending" && <span className="text-muted-foreground">○</span>}
                  {step.status === "error" && <span className="text-destructive">✗</span>}
                  <span className={step.status === "done" ? "line-through text-muted-foreground" : ""}>{step.label}</span>
                </li>
              ))}
            </ul>
          ) : (
            <div className="flex items-start gap-2 rounded-md border border-yellow-600/40 bg-yellow-600/10 p-3">
              <AlertTriangle className="h-4 w-4 text-yellow-500 mt-0.5 shrink-0" />
              <p className="text-sm text-yellow-300">
                The VLM will restart — expect ~30 s inference downtime.
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

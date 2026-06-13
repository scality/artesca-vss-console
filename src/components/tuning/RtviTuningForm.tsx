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

/** Inline "recommended starting value" hint, shown under a knob's description. */
function Recommended({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-xs font-medium text-indigo-300">
      Recommended: {children}
    </p>
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
              How many requests / camera-chunk inferences the VLM runs in parallel. Higher =
              more throughput when several cameras fire at once, but each extra slot reserves
              VRAM. Range 1–16, default 4.
            </p>
            <Recommended>8 — headroom for concurrent cameras; go toward 16 only with many active streams.</Recommended>
          </div>

          <div className="space-y-1">
            <SliderWithLabel
              label="kv_cache_percent"
              value={local.kvCachePct}
              min={0}
              max={1}
              step={0.05}
              onChange={(v) => update("kvCachePct", Math.round(v * 100) / 100)}
              formatValue={(v) => v.toFixed(2)}
              description="Share of GPU memory reserved for the KV cache — the model's working memory holding attention state for in-flight sequences. More cache = more or longer concurrent sequences before older ones are evicted. Range 0–1, default 0.80."
            />
            <Recommended>0.85 — 96 GB allows it; keep headroom for CUDA graphs + activations, don&apos;t exceed ~0.90.</Recommended>
          </div>

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
              Largest context window (prompt + response tokens) the model accepts per request.
              Bigger lets each request carry more video frames / longer prompts, at higher
              per-sequence VRAM. Range 1024–131072, default 32768.
            </p>
            <Recommended>32768 — sufficient here; raise only if a request is being truncated.</Recommended>
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
                throughput. Disabled to save memory on smaller GPUs; on a large-VRAM GPU
                (e.g. L40S 48 GB, RTX PRO 6000 96 GB) there&apos;s plenty of room. Disable only
                if VRAM is genuinely tight.
              </p>
              <Recommended>Enabled (leave unchecked) — 96 GB has the room.</Recommended>
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
                utilization. Default 8; 16 is a safe bump on a large-VRAM GPU. No quality impact.
              </p>
              <Recommended>16</Recommended>
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
                prefill-heavy workloads. Default 5120; 8192 is a good bump on a large-VRAM GPU.
              </p>
              <Recommended>8192</Recommended>
            </div>
          </CollapsibleSection>

          {/* ── Section 2: Speculative decoding / model profile ──────────── */}
          <CollapsibleSection title="Speculative decoding">
            <div className="space-y-2">
              <Label htmlFor="model-profile">NIM_MODEL_PROFILE</Label>
              <div className="flex items-center gap-2">
                <Input
                  id="model-profile"
                  type="text"
                  value={local.modelProfile}
                  placeholder="(empty = auto-detect)"
                  onChange={(e) => update("modelProfile", e.target.value.trim())}
                  className="font-mono text-xs"
                />
                {local.modelProfile && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => update("modelProfile", "")}
                  >
                    Auto
                  </Button>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                {local.modelProfile
                  ? "Explicit profile pinned. The hash must match the detected GPU — a profile baked for a different GPU fails with “no compatible profile.”"
                  : "Auto-detect (recommended): the VLM picks the best profile for the detected GPU. This is the running default and is correct on any GPU."}
              </p>
              <p className="text-xs text-muted-foreground">
                Profile hashes are specific to (model × NIM version × GPU). To pin one,
                read it from the running model with <code>list-model-profiles</code> on the
                NIM for your actual GPU — never copy a hash baked for a different GPU.
              </p>
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

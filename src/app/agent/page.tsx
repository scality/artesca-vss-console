"use client";

import { redirect } from "next/navigation";
import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { useKiosk } from "@/components/KioskProvider";
import { Shell } from "@/components/Shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { Loader2, Save, AlertTriangle, Info } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";

const AgentConfigResponseSchema = z.object({
  prompt: z.string(),
  maxIterations: z.number().nullable(),
  llmBaseUrl: z.string(),
  llmName: z.string(),
  health: z.string(),
  healthDetail: z.string(),
  models: z.array(z.string()),
  warnings: z.array(z.string()),
});

type AgentConfig = z.infer<typeof AgentConfigResponseSchema>;

interface Draft {
  prompt: string;
  maxIterations: number;
  llmBaseUrl: string;
  llmName: string;
}

const DEFAULT_MAX_ITERATIONS = 15;

/** The two LLMs worth calling out explicitly — the blueprint's designated
 *  agent LLM vs. the small model that's weak at tool routing. */
const RECOMMENDED_MODELS = [
  {
    id: "nvidia/llama-3.3-nemotron-super-49b-v1.5",
    label: "llama-3.3-nemotron-super-49b-v1.5 — recommended",
  },
  {
    id: "nvidia/nvidia-nemotron-nano-9b-v2",
    label: "nemotron-nano-9b-v2 — small / weak at tool routing",
  },
] as const;

const HEALTH_STYLES: Record<string, { label: string; cls: string }> = {
  ok: { label: "● reachable", cls: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  "bad-url": { label: "✕ URL misconfigured", cls: "bg-red-50 text-red-700 border-red-200" },
  "auth-error": { label: "✕ auth failed", cls: "bg-red-50 text-red-700 border-red-200" },
  unreachable: { label: "▲ unreachable", cls: "bg-amber-50 text-amber-700 border-amber-200" },
  unknown: { label: "? unknown", cls: "bg-muted text-muted-foreground border-border" },
};

function HealthBadge({ health, detail }: { health: string; detail: string }) {
  const s = HEALTH_STYLES[health] ?? HEALTH_STYLES.unknown;
  return (
    <span
      title={detail || undefined}
      className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-medium ${s.cls}`}
    >
      {s.label}
    </span>
  );
}

export default function AgentConfigPage() {
  const { kiosk } = useKiosk();
  if (kiosk) redirect("/");

  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [draft, setDraft] = React.useState<Draft | null>(null);
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [saving, setSaving] = React.useState(false);

  const { data, isLoading, isError } = useQuery({
    queryKey: ["agent-config"],
    queryFn: async () => {
      const res = await fetch("/api/agent-config");
      if (!res.ok) throw new Error("Failed to fetch agent config");
      const raw = await res.json();
      return AgentConfigResponseSchema.parse(raw);
    },
    staleTime: 30_000,
  });

  React.useEffect(() => {
    if (data && draft === null) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- initializing local edit copy from server data
      setDraft({
        prompt: data.prompt,
        maxIterations: data.maxIterations ?? DEFAULT_MAX_ITERATIONS,
        llmBaseUrl: data.llmBaseUrl,
        llmName: data.llmName,
      });
    }
  }, [data, draft]);

  const isDirty =
    draft !== null &&
    data !== undefined &&
    (draft.prompt !== data.prompt ||
      draft.maxIterations !== (data.maxIterations ?? DEFAULT_MAX_ITERATIONS) ||
      draft.llmBaseUrl !== data.llmBaseUrl ||
      draft.llmName !== data.llmName);

  const trailingV1 = draft !== null && /\/v1\/?$/.test(draft.llmBaseUrl.trim());

  const update = <K extends keyof Draft>(key: K, val: Draft[K]) => {
    setDraft((prev) => (prev ? { ...prev, [key]: val } : prev));
  };

  const doSave = async () => {
    if (!draft || !data) return;
    setSaving(true);
    try {
      const body: Record<string, unknown> = {};
      if (draft.prompt !== data.prompt) body.prompt = draft.prompt;
      if (draft.maxIterations !== (data.maxIterations ?? DEFAULT_MAX_ITERATIONS)) {
        body.maxIterations = draft.maxIterations;
      }
      if (draft.llmBaseUrl !== data.llmBaseUrl) body.llmBaseUrl = draft.llmBaseUrl;
      if (draft.llmName !== data.llmName) body.llmName = draft.llmName;

      const res = await fetch("/api/agent-config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const respBody = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error((respBody as { error?: string }).error ?? "Save failed");
      }
      await queryClient.invalidateQueries({ queryKey: ["agent-config"] });
      setConfirmOpen(false);
      toast({
        title: "Agent config saved — vss-agent restarting",
        description: (respBody as { warning?: string }).warning,
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

  // Model dropdown options: the two called-out recommendations plus whatever
  // the live /v1/models probe returned plus the currently-configured model
  // (so the Select always has a matching item even for an unlisted value).
  const models = data?.models;
  const currentLlmName = draft?.llmName;
  const modelOptions = React.useMemo(() => {
    const ids = new Set<string>();
    const opts: Array<{ id: string; label: string }> = [];
    for (const m of RECOMMENDED_MODELS) {
      if (!ids.has(m.id)) {
        ids.add(m.id);
        opts.push({ id: m.id, label: m.label });
      }
    }
    for (const id of models ?? []) {
      if (!ids.has(id)) {
        ids.add(id);
        opts.push({ id, label: id });
      }
    }
    if (currentLlmName && !ids.has(currentLlmName)) {
      opts.push({ id: currentLlmName, label: `${currentLlmName} (current)` });
    }
    return opts;
  }, [models, currentLlmName]);

  return (
    <Shell>
      <div className="max-w-3xl mx-auto space-y-8">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold">Agent</h2>
            <p className="text-sm text-muted-foreground">
              Edit the VSS chat agent&apos;s LLM wiring and reasoning behavior.
              Changes require a vss-agent restart.
            </p>
          </div>
          <Button disabled={!isDirty || saving} onClick={() => setConfirmOpen(true)}>
            <Save className="h-4 w-4 mr-1" />
            Save + Restart
          </Button>
        </div>

        {/* Durable-vs-live override note — always shown, per operator caveat. */}
        <div className="flex items-start gap-2 rounded-md border border-brand-teal/30 bg-brand-teal-soft p-3 text-sm text-brand-teal">
          <Info className="h-4 w-4 mt-0.5 shrink-0" />
          <p>
            The prompt and LLM default are also enforced on every Helm redeploy by the
            overlay patch job{" "}
            <code className="font-mono text-xs">
              k8s/nvidia-vss-helm-overlay/60-agent-config-patch-job.yaml
            </code>{" "}
            — it re-injects the Pyramid deployment-context block and pins the LLM off the
            small default. Edits made here are <strong>live overrides</strong> that persist
            until the next redeploy re-asserts those durable defaults.
          </p>
        </div>

        {isLoading && (
          <div className="flex items-center gap-2 text-muted-foreground justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin" />
            Loading agent config...
          </div>
        )}

        {isError && (
          <div className="rounded-md border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive">
            Failed to load agent config.
          </div>
        )}

        {data && data.warnings.length > 0 && (
          <ul className="space-y-0.5">
            {data.warnings.map((w) => (
              <li key={w} className="font-mono text-xs text-amber-600 dark:text-amber-400">
                {w}
              </li>
            ))}
          </ul>
        )}

        {draft && (
          <>
            {/* LLM model */}
            <div className="rounded-lg border border-border p-5 space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-base font-semibold">LLM model</h3>
                <HealthBadge health={data?.health ?? "unknown"} detail={data?.healthDetail ?? ""} />
              </div>
              <p className="text-sm text-muted-foreground">
                <code className="font-mono text-xs">LLM_NAME</code> env on the{" "}
                <code className="font-mono text-xs">vss-agent</code> Deployment. Pick from the
                live model list at <code className="font-mono text-xs">{"{LLM_BASE_URL}"}/v1/models</code>,
                or type any model id directly below.
              </p>
              <div className="space-y-2">
                <Label>Quick pick</Label>
                <Select
                  value={modelOptions.some((o) => o.id === draft.llmName) ? draft.llmName : undefined}
                  onValueChange={(v) => update("llmName", v)}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select a model..." />
                  </SelectTrigger>
                  <SelectContent>
                    {modelOptions.map((o) => (
                      <SelectItem key={o.id} value={o.id}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="llm-name">Model id (free text)</Label>
                <Input
                  id="llm-name"
                  value={draft.llmName}
                  onChange={(e) => update("llmName", e.target.value.trim())}
                  className="font-mono text-xs"
                />
              </div>
            </div>

            {/* LLM base URL */}
            <div className="rounded-lg border border-border p-5 space-y-3">
              <h3 className="text-base font-semibold">LLM base URL</h3>
              <p className="text-sm text-muted-foreground">
                <code className="font-mono text-xs">LLM_BASE_URL</code> env on the{" "}
                <code className="font-mono text-xs">vss-agent</code> Deployment. The agent
                appends <code className="font-mono text-xs">/v1</code> itself.
              </p>
              <Input
                value={draft.llmBaseUrl}
                onChange={(e) => update("llmBaseUrl", e.target.value.trim())}
                className="font-mono text-xs"
              />
              {trailingV1 && (
                <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 p-2.5 text-xs text-red-700">
                  <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                  <span>
                    Ends in <code className="font-mono">/v1</code> — the agent appends{" "}
                    <code className="font-mono">/v1</code> itself, so this doubles to{" "}
                    <code className="font-mono">/v1/v1</code> and 404s on every query
                    (&quot;age not found&quot;). Remove the trailing <code className="font-mono">/v1</code>.
                  </span>
                </div>
              )}
            </div>

            {/* Reasoning budget */}
            <div className="rounded-lg border border-border p-5 space-y-3">
              <h3 className="text-base font-semibold">Reasoning budget</h3>
              <p className="text-sm text-muted-foreground">
                <code className="font-mono text-xs">workflow.max_iterations</code> in the{" "}
                <code className="font-mono text-xs">vss-agent-config</code> ConfigMap — the
                cap on tool-call rounds per chat turn.
              </p>
              <Input
                type="number"
                min={1}
                max={100}
                value={draft.maxIterations}
                onChange={(e) =>
                  update(
                    "maxIterations",
                    Math.max(1, Math.min(100, parseInt(e.target.value, 10) || DEFAULT_MAX_ITERATIONS)),
                  )
                }
                className="w-32"
              />
            </div>

            {/* System prompt */}
            <div className="rounded-lg border border-border p-5 space-y-3">
              <h3 className="text-base font-semibold">System prompt</h3>
              <p className="text-sm text-muted-foreground">
                <code className="font-mono text-xs">workflow.prompt</code> — routing rules plus
                the injected Pyramid deployment-context block (camera→category map, incident
                types, facility-wide sweep rule).
              </p>
              <textarea
                value={draft.prompt}
                onChange={(e) => update("prompt", e.target.value)}
                rows={20}
                className="w-full rounded-md border border-input bg-background p-3 font-mono text-xs leading-relaxed ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                spellCheck={false}
              />
            </div>

            {isDirty && (
              <div className="text-xs text-amber-700 bg-amber-50 rounded px-3 py-1.5 border border-amber-200">
                Unsaved changes
              </div>
            )}
          </>
        )}

        <Dialog open={confirmOpen} onOpenChange={saving ? undefined : setConfirmOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Save + Restart vss-agent?</DialogTitle>
              <DialogDescription>
                This patches the vss-agent-config ConfigMap and/or the vss-agent Deployment
                env, then rolls out a restart.
              </DialogDescription>
            </DialogHeader>
            <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3">
              <AlertTriangle className="h-4 w-4 text-amber-700 mt-0.5 shrink-0" />
              <p className="text-sm text-amber-700">
                The chat agent will restart — expect a brief interruption to VSS Chat while
                vss-agent comes back up.
              </p>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setConfirmOpen(false)} disabled={saving}>
                Cancel
              </Button>
              <Button onClick={doSave} disabled={saving}>
                {saving ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Restarting...
                  </>
                ) : (
                  "Save + Restart"
                )}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </Shell>
  );
}

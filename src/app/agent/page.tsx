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
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/StatusBadge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import {
  Loader2,
  Save,
  AlertTriangle,
  Info,
  Cog,
  Wrench,
  Sparkles,
  Link2,
  FileText,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { AGENT_CAPABILITY_GROUPS, type ToolKind } from "@/lib/agent-capabilities";

const AgentConfigResponseSchema = z.object({
  prompt: z.string(),
  maxIterations: z.number().nullable(),
  llmBaseUrl: z.string(),
  llmName: z.string(),
  llmModelType: z.enum(["nim", "openai"]).default("nim"),
  health: z.string(),
  healthDetail: z.string(),
  models: z.array(z.string()),
  warnings: z.array(z.string()),
  agentReachable: z.boolean(),
  agentReachabilityWarnings: z.array(z.string()),
});

interface Draft {
  prompt: string;
  llmBaseUrl: string;
  llmName: string;
  llmModelType: "nim" | "openai";
}

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

/** Model presets — switch the reasoning LLM (including to Claude) without
 *  hand-typing base URLs. Picking a Claude preset sends llmModelType:
 *  "openai"; the server wires the Anthropic API key itself via a K8s
 *  secretKeyRef — the UI never asks for or sends a key. */
const MODEL_PRESETS = [
  {
    id: "nemotron-super-49b",
    label: "Nemotron Super 49B",
    provider: "NVIDIA",
    modelType: "nim",
    baseUrl: "https://integrate.api.nvidia.com",
    name: "nvidia/llama-3.3-nemotron-super-49b-v1.5",
  },
  {
    id: "claude-opus-4-8",
    label: "Claude Opus 4.8",
    provider: "Anthropic",
    modelType: "openai",
    baseUrl: "https://api.anthropic.com",
    name: "claude-opus-4-8",
  },
  {
    id: "claude-sonnet-5",
    label: "Claude Sonnet 5",
    provider: "Anthropic",
    modelType: "openai",
    baseUrl: "https://api.anthropic.com",
    name: "claude-sonnet-5",
  },
] as const;

function normalizeBaseUrl(url: string): string {
  return url.trim().toLowerCase().replace(/\/+$/, "");
}

/** Preselect the preset whose modelType+baseUrl+name match the live config
 *  (case-insensitive, trailing-slash-insensitive on baseUrl). Returns
 *  undefined when nothing matches — the caller falls back to "custom". */
function findMatchingPreset(
  modelType: string,
  baseUrl: string,
  name: string,
): (typeof MODEL_PRESETS)[number] | undefined {
  const normBase = normalizeBaseUrl(baseUrl);
  const normName = name.trim().toLowerCase();
  return MODEL_PRESETS.find(
    (p) =>
      p.modelType === modelType &&
      normalizeBaseUrl(p.baseUrl) === normBase &&
      p.name.toLowerCase() === normName,
  );
}

/** Provider label for the active model, derived from modelType (+ baseUrl
 *  host for "openai" — api.anthropic.com reads as "Anthropic", anything
 *  else as "OpenAI-compatible"). */
function providerLabel(modelType: string, baseUrl: string): string {
  if (modelType === "openai") {
    try {
      if (new URL(baseUrl).host === "api.anthropic.com") return "Anthropic";
    } catch {
      // not a parseable URL — fall through to the generic label
    }
    return "OpenAI-compatible";
  }
  return "NVIDIA";
}

const PROVIDER_STYLES: Record<string, string> = {
  NVIDIA: "bg-emerald-50 text-emerald-700 border-emerald-200",
  Anthropic: "bg-violet-50 text-violet-700 border-violet-200",
  "OpenAI-compatible": "bg-sky-50 text-sky-700 border-sky-200",
};

function ProviderBadge({ modelType, baseUrl }: { modelType: string; baseUrl: string }) {
  const label = providerLabel(modelType, baseUrl);
  const cls = PROVIDER_STYLES[label] ?? "bg-muted text-muted-foreground border-border";
  return (
    <span className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-medium ${cls}`}>
      {label}
    </span>
  );
}

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

const KIND_STYLES: Record<ToolKind, string> = {
  Data: "bg-brand-teal/10 border-brand-teal/30 text-brand-teal",
  Image: "bg-brand-magenta/10 border-brand-magenta/30 text-brand-magenta",
  Video: "bg-brand-indigo/10 border-brand-indigo/30 text-brand-indigo",
  Text: "bg-brand-slate/10 border-brand-slate/30 text-brand-slate",
  Control: "bg-brand-orange/10 border-brand-orange/30 text-brand-orange",
  Report: "bg-brand-mid-gray/10 border-brand-mid-gray/40 text-brand-slate",
};

export default function AgentConfigPage() {
  const { kiosk } = useKiosk();
  if (kiosk) redirect("/");

  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [draft, setDraft] = React.useState<Draft | null>(null);
  const [selectedPresetId, setSelectedPresetId] = React.useState<string | null>(null);
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
        llmBaseUrl: data.llmBaseUrl,
        llmName: data.llmName,
        llmModelType: data.llmModelType,
      });
      const matched = findMatchingPreset(data.llmModelType, data.llmBaseUrl, data.llmName);
       
      setSelectedPresetId(matched ? matched.id : "custom");
    }
  }, [data, draft]);

  const isDirty =
    draft !== null &&
    data !== undefined &&
    (draft.prompt !== data.prompt ||
      draft.llmBaseUrl !== data.llmBaseUrl ||
      draft.llmName !== data.llmName ||
      draft.llmModelType !== data.llmModelType);

  const trailingV1 = draft !== null && /\/v1\/?$/.test(draft.llmBaseUrl.trim());
  const isCustomPreset = selectedPresetId === "custom";

  const update = <K extends keyof Draft>(key: K, val: Draft[K]) => {
    setDraft((prev) => (prev ? { ...prev, [key]: val } : prev));
  };

  /** Selecting a preset sets the effective llmModelType/llmBaseUrl/llmName
   *  that Save+Restart will send. Selecting "custom" leaves the draft as-is
   *  and just reveals the raw editable inputs. */
  const selectPreset = (presetId: string) => {
    setSelectedPresetId(presetId);
    if (presetId === "custom") return;
    const preset = MODEL_PRESETS.find((p) => p.id === presetId);
    if (!preset) return;
    setDraft((prev) =>
      prev
        ? {
            ...prev,
            llmModelType: preset.modelType,
            llmBaseUrl: preset.baseUrl,
            llmName: preset.name,
          }
        : prev,
    );
  };

  const doSave = async () => {
    if (!draft || !data) return;
    setSaving(true);
    try {
      const body: Record<string, unknown> = {};
      if (draft.prompt !== data.prompt) body.prompt = draft.prompt;
      if (draft.llmBaseUrl !== data.llmBaseUrl) body.llmBaseUrl = draft.llmBaseUrl;
      if (draft.llmName !== data.llmName) body.llmName = draft.llmName;
      if (draft.llmModelType !== data.llmModelType) body.llmModelType = draft.llmModelType;

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

  const allWarnings = [...(data?.warnings ?? []), ...(data?.agentReachabilityWarnings ?? [])];

  return (
    <Shell>
      <div className="mx-auto max-w-5xl space-y-6">
        {/* Persistent header bar — identity, live status, and the primary action.
            Stays visible across both tabs so health/reachability and Save+Restart
            are never a scroll away. */}
        <div className="flex flex-wrap items-center gap-4 rounded-xl border border-border bg-card px-5 py-4 shadow-soft-1">
          <div className="flex items-center gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-teal-soft text-brand-teal">
              <Cog className="h-5 w-5" />
            </span>
            <div>
              <h1 className="text-lg font-semibold leading-tight">Agent</h1>
              <p className="text-xs text-muted-foreground">
                Wiring, reasoning behavior, and tool catalog for the VSS chat agent
              </p>
            </div>
          </div>

          <div className="ml-auto flex flex-wrap items-center gap-2">
            {data && (
              <>
                <span
                  title={data.llmBaseUrl}
                  className="shrink-0 rounded border border-border bg-muted/50 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
                >
                  {data.llmName}
                </span>
                <ProviderBadge modelType={data.llmModelType} baseUrl={data.llmBaseUrl} />
                <HealthBadge health={data.health} detail={data.healthDetail} />
                <StatusBadge
                  health={data.agentReachable ? "ok" : "fail"}
                  label={data.agentReachable ? "agent reachable" : "agent unreachable"}
                />
              </>
            )}
            {isDirty && (
              <span className="rounded border border-amber-200 bg-amber-50 px-2 py-1 text-[11px] font-medium text-amber-700">
                Unsaved changes
              </span>
            )}
            <Button size="sm" disabled={!isDirty || saving} onClick={() => setConfirmOpen(true)}>
              <Save className="mr-1.5 h-4 w-4" />
              Save + Restart
            </Button>
          </div>
        </div>

        {allWarnings.length > 0 && (
          <ul className="space-y-0.5">
            {allWarnings.map((w) => (
              <li key={w} className="font-mono text-xs text-amber-600 dark:text-amber-400">
                {w}
              </li>
            ))}
          </ul>
        )}

        <Tabs defaultValue="configuration">
          <TabsList>
            <TabsTrigger value="configuration" className="gap-1.5">
              <Cog className="h-3.5 w-3.5" />
              Configuration
            </TabsTrigger>
            <TabsTrigger value="tools" className="gap-1.5">
              <Wrench className="h-3.5 w-3.5" />
              Tools
            </TabsTrigger>
          </TabsList>

          {/* ── Configuration: editable LLM wiring + prompt ── */}
          <TabsContent value="configuration" className="space-y-6 mt-4">
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

            {draft && (
              <div className="grid grid-cols-1 gap-6 lg:grid-cols-[380px_1fr]">
                {/* Wiring cluster — model, base URL */}
                <div className="space-y-6">
                  <Card>
                    <CardHeader className="pb-3">
                      <CardTitle className="flex items-center gap-2 text-base">
                        <Sparkles className="h-4 w-4 text-brand-teal" />
                        LLM model
                      </CardTitle>
                      <CardDescription>
                        Pick a preset to switch the reasoning LLM — including to Claude, where
                        the server wires the Anthropic API key itself. Choose{" "}
                        <strong>Custom</strong> to point at any NIM or OpenAI-compatible
                        endpoint by hand.
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      <div className="space-y-1.5">
                        <Label>Preset</Label>
                        <Select value={selectedPresetId ?? undefined} onValueChange={selectPreset}>
                          <SelectTrigger>
                            <SelectValue placeholder="Select a preset..." />
                          </SelectTrigger>
                          <SelectContent>
                            {MODEL_PRESETS.map((p) => (
                              <SelectItem key={p.id} value={p.id}>
                                {p.label} — {p.provider}
                              </SelectItem>
                            ))}
                            <SelectItem value="custom">Custom</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>

                      {isCustomPreset ? (
                        <>
                          <div className="space-y-1.5">
                            <Label>Provider type</Label>
                            <Select
                              value={draft.llmModelType}
                              onValueChange={(v) =>
                                update("llmModelType", v as "nim" | "openai")
                              }
                            >
                              <SelectTrigger>
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="nim">nim</SelectItem>
                                <SelectItem value="openai">openai</SelectItem>
                              </SelectContent>
                            </Select>
                          </div>
                          <div className="space-y-1.5">
                            <Label>Quick pick</Label>
                            <Select
                              value={
                                modelOptions.some((o) => o.id === draft.llmName)
                                  ? draft.llmName
                                  : undefined
                              }
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
                          <div className="space-y-1.5">
                            <Label htmlFor="llm-name">Model id (free text)</Label>
                            <Input
                              id="llm-name"
                              value={draft.llmName}
                              onChange={(e) => update("llmName", e.target.value.trim())}
                              className="font-mono text-xs"
                            />
                          </div>
                        </>
                      ) : (
                        <>
                          <div className="space-y-1.5">
                            <Label>Model id</Label>
                            <div className="rounded-md border border-border bg-muted/40 px-3 py-2 font-mono text-xs">
                              {draft.llmName}
                            </div>
                          </div>
                          <div className="space-y-1.5">
                            <Label>Provider type</Label>
                            <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs">
                              {draft.llmModelType}
                            </div>
                          </div>
                        </>
                      )}
                    </CardContent>
                  </Card>

                  <Card>
                    <CardHeader className="pb-3">
                      <CardTitle className="flex items-center gap-2 text-base">
                        <Link2 className="h-4 w-4 text-brand-teal" />
                        LLM base URL
                      </CardTitle>
                      <CardDescription>
                        <code className="font-mono text-xs">LLM_BASE_URL</code> env on the{" "}
                        <code className="font-mono text-xs">vss-agent</code> Deployment. The
                        agent appends <code className="font-mono text-xs">/v1</code> itself.
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      {isCustomPreset ? (
                        <>
                          <Input
                            value={draft.llmBaseUrl}
                            onChange={(e) => update("llmBaseUrl", e.target.value.trim())}
                            className="font-mono text-xs"
                          />
                          {trailingV1 && (
                            <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 p-2.5 text-xs text-red-700">
                              <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                              <span>
                                Ends in <code className="font-mono">/v1</code> — the agent
                                appends <code className="font-mono">/v1</code> itself, so this
                                doubles to <code className="font-mono">/v1/v1</code> and 404s on
                                every query (&quot;age not found&quot;). Remove the trailing{" "}
                                <code className="font-mono">/v1</code>.
                              </span>
                            </div>
                          )}
                        </>
                      ) : (
                        <div className="rounded-md border border-border bg-muted/40 px-3 py-2 font-mono text-xs">
                          {draft.llmBaseUrl}
                        </div>
                      )}
                    </CardContent>
                  </Card>
                </div>

                {/* System prompt — the wide column */}
                <Card className="flex flex-col">
                  <CardHeader className="pb-3">
                    <CardTitle className="flex items-center gap-2 text-base">
                      <FileText className="h-4 w-4 text-brand-teal" />
                      System prompt
                    </CardTitle>
                    <CardDescription>
                      <code className="font-mono text-xs">workflow.prompt</code> — routing
                      rules plus the injected Pyramid deployment-context block (camera→category
                      map, incident types, facility-wide sweep rule).
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="flex-1">
                    <textarea
                      value={draft.prompt}
                      onChange={(e) => update("prompt", e.target.value)}
                      rows={24}
                      className="h-full min-h-[480px] w-full rounded-md border border-input bg-background p-3 font-mono text-xs leading-relaxed ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                      spellCheck={false}
                    />
                  </CardContent>
                </Card>
              </div>
            )}
          </TabsContent>

          {/* ── Tools: hand-curated catalog, always viewable regardless of the
              live-config fetch's state ── */}
          <TabsContent value="tools" className="space-y-6 mt-4">
            <p className="text-sm text-muted-foreground">
              Reference catalog of tools available to the VSS chat agent — what you can ask it
              to do, and what it returns. Hand-curated, not a live introspection of the agent.
            </p>
            {AGENT_CAPABILITY_GROUPS.map((group) => (
              <Card key={group.name}>
                <CardHeader>
                  <CardTitle className="text-base">{group.name}</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  {group.entries.map((entry, i) =>
                    entry.entryType === "note" ? (
                      <div
                        key={i}
                        className="rounded border border-dashed border-border bg-muted/40 p-3 text-xs text-muted-foreground"
                      >
                        <span className="mr-1 text-[10px] font-semibold uppercase tracking-wide">
                          Note:
                        </span>
                        {entry.text}
                      </div>
                    ) : (
                      <div
                        key={entry.name}
                        className="border-b border-border pb-4 last:border-0 last:pb-0"
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <code className="font-mono text-sm font-semibold">{entry.name}</code>
                          {entry.subagent && (
                            <Badge variant="secondary" className="text-[10px]">
                              subagent
                            </Badge>
                          )}
                          {entry.kind.map((k) => (
                            <Badge
                              key={k}
                              variant="outline"
                              className={`text-[10px] ${KIND_STYLES[k]}`}
                            >
                              {k}
                            </Badge>
                          ))}
                          {entry.mutating && (
                            <Badge variant="destructive" className="text-[10px]">
                              mutating
                            </Badge>
                          )}
                        </div>
                        <p className="mt-1 text-sm text-muted-foreground">{entry.returns}</p>
                        {entry.examples.length > 0 && (
                          <div className="mt-1.5 space-y-0.5">
                            {entry.examples.map((ex) => (
                              <p key={ex} className="text-xs italic text-muted-foreground">
                                Try asking: <span className="not-italic">&ldquo;{ex}&rdquo;</span>
                              </p>
                            ))}
                          </div>
                        )}
                      </div>
                    ),
                  )}
                </CardContent>
              </Card>
            ))}
          </TabsContent>
        </Tabs>

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

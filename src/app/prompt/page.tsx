"use client";

import { redirect } from "next/navigation";
import * as React from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { useKiosk } from "@/components/KioskProvider";
import { Shell } from "@/components/Shell";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { Loader2, Save, AlertTriangle } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { PromptEditor } from "@/components/prompt/PromptEditor";
import { PromptPreviewPane } from "@/components/prompt/PromptPreviewPane";
import { ModelCardGrid } from "@/components/prompt/ModelCardGrid";
import { CloudUpload } from "lucide-react";

const GcsFieldSchema = z.object({
  available: z.boolean(),
  lastUpdated: z.string().optional(),
  lastUpdatedBy: z.string().optional(),
  prompt: z.string().optional(),
  model: z.string().optional(),
});

const PromptResponseSchema = z.object({
  prompt: z.string(),
  model: z.string(),
  previewModel: z.string().optional(),
  runtime: z.string().optional(),
  defaultPrompt: z.string().optional(),
  gcs: GcsFieldSchema.optional(),
});

export default function PromptPage() {
  const { kiosk } = useKiosk();
  if (kiosk) redirect("/");

  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [draft, setDraft] = React.useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [gcsSyncing, setGcsSyncing] = React.useState(false);

  const { data, isLoading, isError } = useQuery({
    queryKey: ["prompt"],
    queryFn: async () => {
      const res = await fetch("/api/prompt");
      if (!res.ok) throw new Error("Failed to fetch prompt");
      const raw = await res.json();
      return PromptResponseSchema.parse(raw);
    },
    staleTime: 30_000,
  });

  // Init draft from server once data arrives
  React.useEffect(() => {
    if (data && draft === null) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setDraft(data.prompt);
    }
  }, [data, draft]);

  const isDirty =
    draft !== null && data !== undefined && draft !== data.prompt;

  // Warn on nav away with unsaved changes
  React.useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (isDirty) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [isDirty]);

  const doGcsSync = async () => {
    setGcsSyncing(true);
    try {
      const res = await fetch("/api/prompt/sync-gcs", { method: "POST" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: "Unknown error" }));
        throw new Error((body as { error?: string }).error ?? "Sync failed");
      }
      await queryClient.invalidateQueries({ queryKey: ["prompt"] });
      toast({ title: "Prompt saved to GCS" });
    } catch (err) {
      toast({
        title: "Save to GCS failed",
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setGcsSyncing(false);
    }
  };

  const doSave = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      const res = await fetch("/api/prompt", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: draft }),
      });
      if (!res.ok) throw new Error("Save failed");
      await queryClient.invalidateQueries({ queryKey: ["prompt"] });
      setConfirmOpen(false);
      toast({ title: "Prompt saved — rtvi-vlm restarting" });
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
    <Shell>
      <div className="max-w-6xl mx-auto space-y-8">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold">VLM Prompt</h2>
            <p className="text-sm text-muted-foreground">
              Edit the system prompt for the Vision Language Model. Changes
              require an rtvi-vlm restart (~30 s).
            </p>
            {data?.gcs && (
              <p className="text-xs text-muted-foreground mt-0.5">
                GCS:{" "}
                {data.gcs.available ? (
                  <span className="text-emerald-400">
                    persisted
                    {data.gcs.lastUpdatedBy ? ` · last by ${data.gcs.lastUpdatedBy}` : ""}
                    {data.gcs.lastUpdated
                      ? ` · ${new Date(data.gcs.lastUpdated).toLocaleString()}`
                      : ""}
                  </span>
                ) : (
                  <span className="text-slate-500">unavailable (no credentials)</span>
                )}
              </p>
            )}
          </div>
          <div className="flex items-center gap-2">
            {data?.gcs?.available !== false && (
              <Button
                variant="outline"
                size="sm"
                onClick={doGcsSync}
                disabled={gcsSyncing}
                title="Save current live prompt to GCS for persistence across restarts"
              >
                {gcsSyncing ? (
                  <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                ) : (
                  <CloudUpload className="h-4 w-4 mr-1" />
                )}
                Save to GCS
              </Button>
            )}
            <Button
              disabled={!isDirty || saving}
              onClick={() => setConfirmOpen(true)}
            >
              <Save className="h-4 w-4 mr-1" />
              Save + Restart
            </Button>
          </div>
        </div>

        {/* GCS persistence status banner */}
        {data?.gcs && (
          <div
            className={
              data.gcs.available
                ? "rounded-md border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-emerald-300"
                : "rounded-md border border-slate-500/30 bg-slate-500/10 p-3 text-sm text-slate-400"
            }
          >
            {data.gcs.available ? (
              <span>
                <span className="font-semibold">PERSISTED</span> — prompt is saved in GCS
                {data.gcs.lastUpdatedBy ? ` by ${data.gcs.lastUpdatedBy}` : ""}
                {data.gcs.lastUpdated
                  ? ` on ${new Date(data.gcs.lastUpdated).toLocaleString()}`
                  : ""}
                . It will be restored on the next container restart.
              </span>
            ) : (
              <span>
                <span className="font-semibold">RUNTIME-ONLY</span> — prompt is not persisted to GCS.
                Set <code>GCS_CONFIG_BUCKET</code> and <code>GOOGLE_APPLICATION_CREDENTIALS</code> to
                enable cross-restart persistence.
              </span>
            )}
          </div>
        )}

        {data?.runtime === "docker" && (
          <div className="rounded-md border border-sky-500/30 bg-sky-500/10 p-3 text-sm text-sky-300">
            Compose-mode runtime — prompt is the <code>VLM_SYSTEM_PROMPT</code> env on the
            <code> rtvi-vlm</code> container. Saving recreates the container with the new value
            (~30 s of downtime; old container is auto-restored on failure).
          </div>
        )}

        {data?.defaultPrompt && data.prompt === "" && draft !== null && draft !== data.defaultPrompt && (
          <div className="rounded-md border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-emerald-300 flex items-start gap-3">
            <div className="flex-1">
              <div className="font-medium">No prompt configured.</div>
              <div className="mt-1 text-emerald-300/80">
                Apply the bundled Pyramid retail-scenario default? Same prompt is wired into
                future deploys via <code>scripts/stacks/vss/bootstrap-compose.sh</code>.
              </div>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setDraft(data.defaultPrompt!)}
              className="shrink-0"
            >
              Load default
            </Button>
          </div>
        )}

        {isLoading && (
          <div className="flex items-center gap-2 text-muted-foreground justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin" />
            Loading prompt...
          </div>
        )}

        {isError && (
          <div className="rounded-md border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive">
            Failed to load prompt.
          </div>
        )}

        {isDirty && (
          <div className="text-xs text-yellow-400 bg-yellow-400/10 rounded px-3 py-1.5 border border-yellow-400/20">
            Unsaved changes
          </div>
        )}

        {data && draft !== null && (
          <>
            <PromptEditor
              original={data.prompt}
              value={draft}
              onChange={setDraft}
            />

            <div className="rounded-lg border border-border p-4 space-y-3">
              <h3 className="text-sm font-semibold">Preview Inference</h3>
              <PromptPreviewPane currentModel={data.model} />
            </div>

            <ModelCardGrid />
          </>
        )}

        <Dialog open={confirmOpen} onOpenChange={saving ? undefined : setConfirmOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Save + Restart rtvi-vlm?</DialogTitle>
              <DialogDescription>
                {data?.runtime === "docker" ? (
                  <>
                    The <code>rtvi-vlm</code> container will be recreated with
                    the new <code>VLM_SYSTEM_PROMPT</code>. Image, mounts, GPU
                    binding, network, and restart policy are preserved.
                  </>
                ) : (
                  <>
                    This will patch the prompt ConfigMap and restart the{" "}
                    <code>rtvi-vlm</code> deployment.
                  </>
                )}
              </DialogDescription>
            </DialogHeader>
            <div className="flex items-start gap-2 rounded-md border border-yellow-600/40 bg-yellow-600/10 p-3">
              <AlertTriangle className="h-4 w-4 text-yellow-500 mt-0.5 shrink-0" />
              <p className="text-sm text-yellow-300">
                Expect ~30 s downtime while rtvi-vlm restarts. Live inference
                will be paused during this time.
                {data?.runtime === "docker" && (
                  <> If the new container fails to start, the old one is
                  auto-restored from the backup snapshot.</>
                )}
              </p>
            </div>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setConfirmOpen(false)}
                disabled={saving}
              >
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

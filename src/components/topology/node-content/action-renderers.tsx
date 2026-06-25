"use client";

// src/components/topology/node-content/action-renderers.tsx
// Actions tab renderers for all topology nodes.
// Imported by actions.ts which assembles the NodeContentMap.

import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { RotateCw, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import type { NodeContent, TabRendererProps } from "../registry";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      resolve(result.split(",")[1] ?? result);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

const SENSOR_ID_RE = /^[a-z][a-z0-9-]{1,30}$/;

function validateSensorId(id: string): string | null {
  if (!id) return "Sensor ID is required";
  if (!SENSOR_ID_RE.test(id)) return "Must be lowercase letters/digits/hyphens, 2–31 chars";
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// camera-sim — Add Feed inline form
// ─────────────────────────────────────────────────────────────────────────────

export function CameraSimActionsRenderer({ snapshot }: TabRendererProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [sensorId, setSensorId] = React.useState("");
  const [sourceFile, setSourceFile] = React.useState("");
  const [fileBase64, setFileBase64] = React.useState("");
  const [fileName, setFileName] = React.useState("");

  // Track newly registered sensor for post-submit status line
  const [addedSensorId, setAddedSensorId] = React.useState<string | null>(null);

  const idError = sensorId ? validateSensorId(sensorId) : null;
  const sourceError = sourceFile && !/^[a-zA-Z0-9._-]+\.ts$/.test(sourceFile)
    ? "Must be a .ts filename"
    : null;

  // Watch snapshot for vstRegistered: true on the newly added sensor
  const feedKey = addedSensorId ? `feed:${addedSensorId}` : null;
  const feedState = feedKey ? snapshot?.nodes[feedKey]?.feed : null;
  const vstRegistered = feedState?.vstRegistered ?? false;

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] ?? null;
    if (!file) return;
    const b64 = await toBase64(file);
    setFileBase64(b64);
    setFileName(file.name);
    if (!sourceFile) setSourceFile(file.name);
  };

  const mutation = useMutation({
    mutationFn: async () => {
      // camera id = sensor id (1:1 mapping in the real schema)
      const body = {
        id: sensorId,
        role: "other",
        feeds: [
          {
            id: "default",
            sensorId,
            source: sourceFile,
            rtspUrl: `rtsp://camera-sim-host:8554/${sensorId}`,
            fileBase64,
          },
        ],
      };
      const res = await fetch("/api/cameras", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Unknown error" }));
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["cameras"] });
      toast({ title: "Feed submitted", description: `${sensorId} queued for VST registration.` });
      setAddedSensorId(sensorId);
      setSensorId("");
      setSourceFile("");
      setFileBase64("");
      setFileName("");
    },
    onError: (err: Error) => {
      toast({ title: "Failed to add feed", description: err.message, variant: "destructive" });
    },
  });

  const canSubmit = !idError && !sourceError && sensorId && sourceFile && fileBase64 && !mutation.isPending;

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        Register a new RTSP feed into camera-sim. Upload the .ts source file and give it a sensor ID.
      </p>

      <div className="space-y-1">
        <Label htmlFor="sensor-id" className="text-xs">Sensor ID</Label>
        <Input
          id="sensor-id"
          value={sensorId}
          onChange={(e) => setSensorId(e.target.value.toLowerCase())}
          placeholder="checkout-3"
          className="h-8 text-sm"
          disabled={mutation.isPending}
        />
        {idError && <p className="text-xs text-destructive">{idError}</p>}
        <p className="text-xs text-muted-foreground">
          Lowercase letters, digits, hyphens — e.g. checkout-3
        </p>
      </div>

      <div className="space-y-1">
        <Label htmlFor="source-file" className="text-xs">Source file (.ts)</Label>
        <Input
          id="source-file"
          value={sourceFile}
          onChange={(e) => setSourceFile(e.target.value)}
          placeholder="euroshop.ts"
          className="h-8 text-sm font-mono"
          disabled={mutation.isPending}
        />
        {sourceError && <p className="text-xs text-destructive">{sourceError}</p>}
      </div>

      <div className="space-y-1">
        <Label htmlFor="ts-upload" className="text-xs">Upload .ts file</Label>
        <div className="flex items-center gap-2">
          <input
            id="ts-upload"
            type="file"
            accept=".ts"
            className="hidden"
            onChange={handleFileChange}
            disabled={mutation.isPending}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => document.getElementById("ts-upload")?.click()}
            disabled={mutation.isPending}
          >
            {fileName ? fileName : "Choose file…"}
          </Button>
          {fileName && (
            <span className="text-xs text-muted-foreground truncate max-w-[120px]">{fileName}</span>
          )}
        </div>
        {!fileBase64 && (
          <p className="text-xs text-muted-foreground">
            File will be SCP&apos;d to <span className="font-mono">/opt/camera-sim/data/</span>
          </p>
        )}
      </div>

      <Button
        type="button"
        size="sm"
        disabled={!canSubmit}
        onClick={() => mutation.mutate()}
        className="w-full"
      >
        {mutation.isPending ? "Adding…" : "Add Feed"}
      </Button>

      {/* Post-submit registration status line */}
      {addedSensorId && !mutation.isPending && (
        <p className="text-xs text-muted-foreground">
          {vstRegistered
            ? <span className="text-emerald-700 font-medium">Registered ✓ — {addedSensorId} is live in VST.</span>
            : <>Waiting for VST to register the new feed — this usually takes 3–8 s.</>
          }
        </p>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Rollout Restart — shared across legacy and Helm topology node IDs
// ─────────────────────────────────────────────────────────────────────────────

// Map from topology node IDs to the component IDs accepted by /api/restart/[component].
// The key is the nodeId used in the pipeline snapshot; value is the restartable key
// from CLUSTER.restartable in cluster-refs.ts.
// Covers both legacy node IDs and Helm node IDs — each path only uses its own subset.
const NODE_TO_RESTART_KEY: Record<string, string> = {
  // Legacy node IDs
  "sensor-ms": "sensor-ms",
  "streamprocessing-ms": "streamprocessing-ms",
  "rtvi-vlm": "rtvi-vlm",
  "rtvi-embed": "rtvi-embed",
  "nim-cosmos-reason2": "cosmos-reason2-8b",
  "alert-worker": "alert-worker",
  agent: "nvidia-vss-agent",
  // Helm node IDs
  "vss-vios-sensor": "vss-vios-sensor",
  "vss-vios-streamprocessing": "vss-vios-streamprocessing",
  "vss-rtvi-vlm": "vss-rtvi-vlm",
  "nim-nemotron-nano": "nvidia-nemotron-nano-9b-v2",
  "vss-video-analytics-api": "vss-video-analytics-api",
  "vss-agent": "vss-agent",
  // Common
  mediamtx: "mediamtx", // no matching RESTARTABLE entry — button will be disabled
};

interface RolloutRestartRendererProps extends TabRendererProps {
  componentKey: string;
}

function RolloutRestartRenderer({ componentKey }: RolloutRestartRendererProps) {
  const { toast } = useToast();
  const [confirm, setConfirm] = React.useState(false);

  // Known restartable keys from cluster-refs.ts RESTARTABLE map (both layouts)
  const KNOWN_KEYS = new Set([
    // Legacy
    "sensor-ms", "streamprocessing-ms", "rtvi-vlm", "rtvi-embed",
    "cosmos-reason2-8b", "alert-worker", "nvidia-vss-agent",
    // Helm
    "vss-vios-sensor", "vss-vios-streamprocessing", "vss-rtvi-vlm",
    "nvidia-nemotron-nano-9b-v2", "vss-video-analytics-api", "vss-agent",
    // Common
    "demo-producer",
  ]);
  const isKnown = KNOWN_KEYS.has(componentKey);

  const mutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/restart/${encodeURIComponent(componentKey)}`, {
        method: "POST",
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Unknown error" }));
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Restart triggered", description: `${componentKey} rollout restart initiated.` });
      setConfirm(false);
    },
    onError: (err: Error) => {
      toast({ title: "Restart failed", description: err.message, variant: "destructive" });
      setConfirm(false);
    },
  });

  if (!isKnown) {
    return (
      <div className="space-y-2">
        <Button variant="outline" size="sm" disabled className="w-full">
          <RotateCw className="mr-1.5 h-3.5 w-3.5" />
          Restart
        </Button>
        <p className="text-xs text-muted-foreground">
          No restartable deployment/statefulset mapped for <span className="font-mono">{componentKey}</span>.
        </p>
      </div>
    );
  }

  if (confirm) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">
          Rollout-restart <span className="font-mono font-semibold">{componentKey}</span>?
          Running requests will be interrupted.
        </p>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={mutation.isPending}
            onClick={() => mutation.mutate()}
            className="border-amber-500 text-amber-700 hover:bg-amber-50 hover:text-amber-700"
          >
            <RotateCw className="mr-1.5 h-3.5 w-3.5" />
            {mutation.isPending ? "Restarting…" : "Confirm"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={mutation.isPending}
            onClick={() => setConfirm(false)}
          >
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <Button
        variant="outline"
        size="sm"
        onClick={() => setConfirm(true)}
        className="w-full border-amber-500 text-amber-700 hover:bg-amber-50 hover:text-amber-700"
      >
        <RotateCw className="mr-1.5 h-3.5 w-3.5" />
        Restart
      </Button>
      <p className="text-xs text-muted-foreground">
        Triggers a rolling restart of the <span className="font-mono">{componentKey}</span> deployment.
      </p>
    </div>
  );
}

// Factory: wraps RolloutRestartRenderer to bind the correct componentKey.
function makeRolloutRenderer(nodeId: string) {
  const componentKey = NODE_TO_RESTART_KEY[nodeId] ?? nodeId;
  return function RolloutRenderer(props: TabRendererProps) {
    return <RolloutRestartRenderer {...props} componentKey={componentKey} />;
  };
}

// Legacy node renderers
export const SensorMsActionsRenderer = makeRolloutRenderer("sensor-ms");
export const StreamProcessingActionsRenderer = makeRolloutRenderer("streamprocessing-ms");
export const RtviVlmActionsRenderer = makeRolloutRenderer("rtvi-vlm");
export const RtviEmbedActionsRenderer = makeRolloutRenderer("rtvi-embed");
// Internal only — callers use NimCosmosActionsFullRenderer (defined below),
// which composes this rollout renderer with the "Swap model in /prompt" link.
// Exporting the bare rollout renderer would let a future caller accidentally
// wire it into ACTIONS_CONTENT and drop the model-swap affordance.
const NimCosmosActionsRenderer = makeRolloutRenderer("nim-cosmos-reason2");
export const AlertWorkerActionsRenderer = makeRolloutRenderer("alert-worker");
export const AgentActionsRenderer = makeRolloutRenderer("agent");

// Helm node renderers
export const VssViosSensorActionsRenderer = makeRolloutRenderer("vss-vios-sensor");
export const VssViosStreamActionsRenderer = makeRolloutRenderer("vss-vios-streamprocessing");
export const VssRtviVlmActionsRenderer = makeRolloutRenderer("vss-rtvi-vlm");
export const VssVideoAnalyticsActionsRenderer = makeRolloutRenderer("vss-video-analytics-api");
export const VssAgentActionsRenderer = makeRolloutRenderer("vss-agent");
const NimNemotronActionsRenderer = makeRolloutRenderer("nim-nemotron-nano");

// Common
// mediamtx — no RESTARTABLE entry — button disabled
export const MediamtxActionsRenderer = makeRolloutRenderer("mediamtx");

// ─────────────────────────────────────────────────────────────────────────────
// demo-data-producer — On/Off toggle + Rehearsal mode
// ─────────────────────────────────────────────────────────────────────────────

export function DemoDataActionsRenderer(_props: TabRendererProps) {
  const { toast } = useToast();
  const [enabled, setEnabled] = React.useState<boolean | null>(null);
  const [rehearsalActive, setRehearsalActive] = React.useState(false);
  const [rehearsalRemaining, setRehearsalRemaining] = React.useState(0);
  const intervalRef = React.useRef<ReturnType<typeof setInterval> | null>(null);

  // Fetch current enabled state on mount
  React.useEffect(() => {
    fetch("/api/demo-data")
      .then((r) => r.json())
      .then((data: { enabled: boolean }) => setEnabled(data.enabled))
      .catch(() => toast({ title: "Could not load demo-data state", variant: "destructive" }));

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleMutation = useMutation({
    mutationFn: async (next: boolean) => {
      const res = await fetch("/api/demo-data", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: next }),
      });
      if (!res.ok) throw new Error(await res.text());
      return next;
    },
    onSuccess: (next) => {
      setEnabled(next);
      toast({ title: next ? "Demo data enabled" : "Demo data disabled" });
    },
    onError: (err: Error) => {
      toast({ title: "Toggle failed", description: err.message, variant: "destructive" });
    },
  });

  const rehearsalMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/demo-data/rehearsal", { method: "POST" });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Rehearsal started", description: "60-second high-probability burst." });
      setRehearsalActive(true);
      setRehearsalRemaining(60);
      intervalRef.current = setInterval(() => {
        setRehearsalRemaining((r) => {
          if (r <= 1) {
            clearInterval(intervalRef.current!);
            setRehearsalActive(false);
            return 0;
          }
          return r - 1;
        });
      }, 1000);
    },
    onError: (err: Error) => {
      toast({ title: "Rehearsal failed", description: err.message, variant: "destructive" });
    },
  });

  if (enabled === null) {
    return <p className="text-xs text-muted-foreground animate-pulse">Loading…</p>;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Switch
          id="demo-enabled"
          checked={enabled}
          onCheckedChange={(checked) => toggleMutation.mutate(checked)}
          disabled={toggleMutation.isPending}
        />
        <Label htmlFor="demo-enabled" className="text-sm">
          {enabled ? "Enabled" : "Disabled"}
        </Label>
      </div>
      <p className="text-xs text-muted-foreground">
        Scales the <span className="font-mono">demo-producer</span> deployment to 1 (on) or 0 (off).
      </p>

      <div className="border-t border-border pt-3 space-y-2">
        <p className="text-xs font-medium">Rehearsal mode</p>
        <p className="text-xs text-muted-foreground">
          60-second burst at high match probability — fires alerts repeatedly to verify the pipeline end-to-end.
        </p>
        <Button
          size="sm"
          className="bg-amber-500 hover:bg-amber-600 text-white font-semibold w-full"
          disabled={!enabled || rehearsalActive || rehearsalMutation.isPending}
          onClick={() => rehearsalMutation.mutate()}
        >
          {rehearsalActive
            ? `Rehearsal active — ${rehearsalRemaining}s remaining`
            : "Start Rehearsal"}
        </Button>
        {!enabled && (
          <p className="text-xs text-muted-foreground">Enable producer first.</p>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// nim-cosmos-reason2 — Swap model link
// ─────────────────────────────────────────────────────────────────────────────

export function NimCosmosSwapModelRenderer(_props: TabRendererProps) {
  const router = useRouter();
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        Model swap and prompt tuning are managed on the Prompt page.
      </p>
      <Button
        variant="outline"
        size="sm"
        onClick={() => router.push("/prompt")}
        className="w-full"
      >
        Open Prompt / Model Config
      </Button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// nim-cosmos-reason2 — combined actions (restart + swap model)
// ─────────────────────────────────────────────────────────────────────────────

export function NimCosmosActionsFullRenderer(props: TabRendererProps) {
  return (
    <div className="space-y-5">
      <div>
        <p className="text-xs font-medium mb-2">Restart</p>
        <NimCosmosActionsRenderer {...props} />
      </div>
      <div className="border-t border-border pt-3">
        <p className="text-xs font-medium mb-2">Model</p>
        <NimCosmosSwapModelRenderer {...props} />
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// nim-nemotron-nano — combined actions (restart + swap model) — Helm path
// ─────────────────────────────────────────────────────────────────────────────

export function NimNemotronActionsFullRenderer(props: TabRendererProps) {
  return (
    <div className="space-y-5">
      <div>
        <p className="text-xs font-medium mb-2">Restart</p>
        <NimNemotronActionsRenderer {...props} />
      </div>
      <div className="border-t border-border pt-3">
        <p className="text-xs font-medium mb-2">Model</p>
        <NimCosmosSwapModelRenderer {...props} />
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// feed:* — per-feed actions (Remove + Copy RTSP URL + View in sensor-ms)
// ─────────────────────────────────────────────────────────────────────────────

export function FeedActionsRenderer({ nodeId, runtimeState }: TabRendererProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [confirm, setConfirm] = React.useState(false);

  // nodeId = "feed:<sensorId>"
  const sensorId = nodeId.startsWith("feed:") ? nodeId.slice("feed:".length) : nodeId;

  // Prefer the server-resolved RTSP URL (correct camera-sim host + camera-name
  // path). The client can't read the server's CAMERA_SIM_HOST, so the
  // build-time public env is only a last-resort fallback.
  const cameraSimHost =
    process.env.NEXT_PUBLIC_CAMERA_SIM_HOST ?? "camera-sim-host";
  const rtspUrl =
    runtimeState?.feed?.rtspUrl ?? `rtsp://${cameraSimHost}:8554/${sensorId}`;

  const deleteMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/cameras/${encodeURIComponent(sensorId)}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Unknown error" }));
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["cameras"] });
      toast({ title: "Feed removed", description: `${sensorId} unregistered.` });
      setConfirm(false);
    },
    onError: (err: Error) => {
      toast({ title: "Remove failed", description: err.message, variant: "destructive" });
      setConfirm(false);
    },
  });

  const copyRtsp = () => {
    navigator.clipboard.writeText(rtspUrl).then(
      () => toast({ title: "Copied", description: rtspUrl }),
      () => toast({ title: "Copy failed", variant: "destructive" })
    );
  };

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <p className="text-xs font-medium">RTSP URL</p>
        <div className="flex items-center gap-2">
          <span className="text-xs font-mono text-muted-foreground truncate flex-1">{rtspUrl}</span>
          <Button variant="ghost" size="sm" onClick={copyRtsp}>
            <Copy className="mr-1 h-3.5 w-3.5" />
            Copy
          </Button>
        </div>
      </div>

      <div>
        {process.env.NEXT_PUBLIC_VST_INGRESS_URL ? (
          <Button
            variant="outline"
            size="sm"
            className="w-full"
            onClick={() =>
              window.open(process.env.NEXT_PUBLIC_VST_INGRESS_URL, "_blank")
            }
          >
            View VST sensor UI
          </Button>
        ) : null}
        <p className="text-xs text-muted-foreground mt-1">
          The VST sensor UI (vss-vios-ingress:30888) is reachable only from
          inside the cluster
          {process.env.NEXT_PUBLIC_VST_INGRESS_URL
            ? "."
            : " — set NEXT_PUBLIC_VST_INGRESS_URL to a reachable URL to enable a link."}
        </p>
      </div>

      <div className="border-t border-border pt-3">
        {confirm ? (
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">
              Remove feed <span className="font-mono font-semibold">{sensorId}</span>?
              This unregisters it from VST and removes the config entry.
            </p>
            <div className="flex gap-2">
              <Button
                variant="destructive"
                size="sm"
                disabled={deleteMutation.isPending}
                onClick={() => deleteMutation.mutate()}
              >
                {deleteMutation.isPending ? "Removing…" : "Remove"}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={deleteMutation.isPending}
                onClick={() => setConfirm(false)}
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <Button
            variant="destructive"
            size="sm"
            className="w-full"
            onClick={() => setConfirm(true)}
          >
            Remove Feed
          </Button>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// FEED_ACTIONS_CONTENT — singleton NodeContent for any feed:* node.
// The NodeDetailPanel should merge this with getFeedContent(nodeId) from feeds.ts:
//
//   const content =
//     NODE_CONTENT[nodeId]
//     ?? mergeContent(getFeedContent(nodeId) ?? {}, getFeedActionsContent(nodeId) ?? {});
//
// Because feed:* ids are dynamic, they cannot appear as static keys in ACTIONS_CONTENT.
// ─────────────────────────────────────────────────────────────────────────────

const feedActionsContent: NodeContent = {
  actions: FeedActionsRenderer,
};

/**
 * Returns the actions NodeContent for any "feed:*" node id.
 * Returns undefined for other node ids.
 */
export function getFeedActionsContent(nodeId: string): NodeContent | undefined {
  if (typeof nodeId === "string" && nodeId.startsWith("feed:")) {
    return feedActionsContent;
  }
  return undefined;
}

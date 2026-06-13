"use client";

import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
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
import { SliderWithLabel } from "./SliderWithLabel";

const VstResponseSchema = z.object({
  recordingMode: z.enum(["always", "event", "both"]).default("always"),
  eventRecordLengthSecs: z.number().int().min(5).max(60).default(30),
  recordBufferLengthSecs: z.number().int().min(0).max(10).default(5),
  defaultGovLength: z.number().int().positive().default(30),
  supportedVideoCodecs: z
    .array(z.enum(["h264", "h265"]))
    .min(1)
    .default(["h264", "h265"]),
  storageThresholdPercentage: z.number().int().min(50).max(99).default(85),
  storageMonitoringFrequencySecs: z.number().int().min(1).max(60).default(10),
  defaultFileExpiryMinutes: z.number().int().positive().default(1440),
  enableAgingPolicy: z.boolean().default(true),
  recorderEnableFrameDrop: z.boolean().default(true),
  observed: z
    .object({
      sensors: z
        .array(
          z.object({
            sensorId: z.string(),
            name: z.string().default(""),
            state: z.string().default(""),
            bitrateMbps: z.number().default(0),
            gop: z.number().default(0),
          })
        )
        .optional(),
    })
    .optional(),
});

type VstTuning = z.infer<typeof VstResponseSchema>;

type VstPatch = Omit<VstTuning, "observed">;

interface StepState {
  label: string;
  status: "pending" | "running" | "done" | "error";
}

const INITIAL_STEPS: StepState[] = [
  { label: "Patching config…", status: "pending" },
  { label: "Restarting VST sensor…", status: "pending" },
  { label: "Restarting VST stream processor…", status: "pending" },
  { label: "Done", status: "pending" },
];

function expiryLabel(minutes: number): string {
  if (minutes < 60) return `= ${minutes} min`;
  const hours = Math.round((minutes / 60) * 10) / 10;
  if (hours < 24) return `= ${hours} h`;
  const days = Math.round((minutes / 1440) * 10) / 10;
  return `= ${days} day${days !== 1 ? "s" : ""}`;
}

// ── Audit "last changed" endpoint contract ────────────────────────────────────
interface AuditLastEntry {
  action: string;
  target: string;
  ts: string;
  operator: string;
  agoSecs: number;
  detailsJson: string;
}

function formatAgoSecs(secs: number): string {
  if (secs < 60) return `${Math.floor(secs)}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  if (secs < 86400) {
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    return `${h}h ${m}m`;
  }
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  return `${d}d ${h}h`;
}

// ── Field diff helpers ────────────────────────────────────────────────────────
type DiffRow = {
  field: string;
  oldVal: string;
  newVal: string;
};

function formatFieldValue(field: string, val: unknown): string {
  if (Array.isArray(val)) return `[${val.join(", ")}]`;
  if (typeof val === "boolean") return val ? "on" : "off";
  if (field === "storageThresholdPercentage") return `${val}%`;
  return String(val);
}

function computeDiff(local: VstPatch, data: VstTuning): DiffRow[] {
  const { observed: _observed, ...dataRest } = data;
  void _observed;
  const rows: DiffRow[] = [];

  for (const key of Object.keys(local) as Array<keyof VstPatch>) {
    const localVal = local[key];
    const dataVal = (dataRest as VstPatch)[key];
    // Deep-compare by JSON serialisation for arrays
    if (JSON.stringify(localVal) !== JSON.stringify(dataVal)) {
      rows.push({
        field: key,
        oldVal: formatFieldValue(key, dataVal),
        newVal: formatFieldValue(key, localVal),
      });
    }
  }

  rows.sort((a, b) => a.field.localeCompare(b.field));
  return rows;
}

// ── Component ─────────────────────────────────────────────────────────────────
export function VstRecordingForm() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [steps, setSteps] = React.useState<StepState[]>(INITIAL_STEPS);
  const [saving, setSaving] = React.useState(false);

  const { data, isLoading, isError } = useQuery({
    queryKey: ["tuning", "vst"],
    queryFn: async () => {
      const res = await fetch("/api/tuning/vst");
      if (!res.ok) throw new Error("Failed to fetch VST tuning");
      const raw = await res.json();
      return VstResponseSchema.parse(raw);
    },
    staleTime: 30_000,
  });

  // Audit — last changed strip
  const { data: auditEntry } = useQuery<AuditLastEntry | null>({
    queryKey: ["audit", "last", "tuning-vst"],
    queryFn: async () => {
      try {
        const res = await fetch("/api/audit/last?action=tuning-vst");
        if (!res.ok) return null;
        const json = await res.json() as unknown;
        if (!json) return null;
        return json as AuditLastEntry;
      } catch {
        return null;
      }
    },
    staleTime: 60_000,
  });

  const [local, setLocal] = React.useState<VstPatch | null>(null);

  React.useEffect(() => {
    if (data && local === null) {
      const { observed: _observed, ...rest } = data;
      void _observed;
      // eslint-disable-next-line react-hooks/set-state-in-effect -- initializing local edit copy from server data
      setLocal(rest);
    }
  }, [data, local]);

  const isDirty = React.useMemo(() => {
    if (!local || !data) return false;
    const { observed: _observed, ...dataRest } = data;
    void _observed;
    return JSON.stringify(local) !== JSON.stringify(dataRest);
  }, [local, data]);

  const diffRows = React.useMemo<DiffRow[]>(() => {
    if (!local || !data) return [];
    return computeDiff(local, data);
  }, [local, data]);

  const setStep = (idx: number, status: StepState["status"]) => {
    setSteps((prev) =>
      prev.map((s, i) => (i === idx ? { ...s, status } : s))
    );
  };

  const doSave = async () => {
    if (!local) return;

    // Client-side validation: at least one codec must be selected
    if (local.supportedVideoCodecs.length === 0) {
      toast({
        title: "Validation error",
        description: "At least one video codec must be selected.",
        variant: "destructive",
      });
      return;
    }

    setSaving(true);
    setSteps(INITIAL_STEPS.map((s) => ({ ...s, status: "pending" })));
    try {
      setStep(0, "running");
      const res = await fetch("/api/tuning/vst", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(local),
      });
      if (!res.ok) throw new Error("Patch failed");
      setStep(0, "done");

      setStep(1, "running");
      await new Promise((r) => setTimeout(r, 1500));
      setStep(1, "done");

      setStep(2, "running");
      await new Promise((r) => setTimeout(r, 1500));
      setStep(2, "done");
      setStep(3, "done");

      await queryClient.invalidateQueries({ queryKey: ["tuning", "vst"] });
      await queryClient.invalidateQueries({ queryKey: ["audit", "last", "tuning-vst"] });
      toast({ title: "VST recording tuning saved — restarting" });
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

  const update = <K extends keyof VstPatch>(key: K, val: VstPatch[K]) => {
    setLocal((prev) => (prev ? { ...prev, [key]: val } : null));
  };

  const toggleCodec = (codec: "h264" | "h265", checked: boolean) => {
    setLocal((prev) => {
      if (!prev) return null;
      const codecs = checked
        ? ([...new Set([...prev.supportedVideoCodecs, codec])] as Array<"h264" | "h265">)
        : (prev.supportedVideoCodecs.filter((c) => c !== codec) as Array<"h264" | "h265">);
      return { ...prev, supportedVideoCodecs: codecs };
    });
  };

  const observedSensors = data?.observed?.sensors ?? [];

  return (
    <div className="space-y-4">
      {/* Header row */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-base font-semibold">VST Recording Tuning</h3>
          <p className="text-sm text-muted-foreground">
            Recording mode, codec, and storage parameters. Changes restart
            the VST sensor and stream processor (~10 s gap).
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

      {/* Last changed strip */}
      {auditEntry !== undefined && (
        <p className="text-xs text-muted-foreground">
          {auditEntry === null
            ? "No prior changes via console."
            : `Last changed ${formatAgoSecs(auditEntry.agoSecs)} ago by ${auditEntry.operator}`}
        </p>
      )}

      {/* Loading / error states */}
      {isLoading && (
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading…
        </div>
      )}

      {isError && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
          Failed to load VST tuning values.
        </div>
      )}

      {/* Registered-sensor box. VST's /sensor/list is a device registry: it
          reports name + state, but NOT live bitrate/GOP — those only show if a
          source populates them. Live codec/bitrate lives on the Cameras page. */}
      {observedSensors.length > 0 && (
        <div className="bg-muted/20 rounded p-3 text-xs font-mono">
          <p className="text-muted-foreground mb-1">
            Registered sensors (from VST) — {observedSensors.length}:
          </p>
          {observedSensors.map((s) => (
            <p key={s.sensorId}>
              <span className="text-foreground">{s.name || s.sensorId}</span>
              {s.state && (
                <span
                  className={
                    s.state.toLowerCase() === "online"
                      ? "text-green-500"
                      : "text-yellow-500"
                  }
                >
                  {" "}
                  · {s.state}
                </span>
              )}
              {s.bitrateMbps > 0 && (
                <span className="text-muted-foreground"> · {s.bitrateMbps} Mbps</span>
              )}
              {s.gop > 0 && (
                <span className="text-muted-foreground"> · GOP {s.gop}</span>
              )}
            </p>
          ))}
          <p className="text-muted-foreground mt-2 not-italic">
            VST reports device state only — live bitrate/codec is on the Cameras page (enriched from mediamtx).
          </p>
        </div>
      )}

      {local && (
        <div className="space-y-7">
          {/* ── Recording Mode ── */}
          <div className="space-y-3">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Recording Mode
            </h4>

            <RadioGroup
              value={local.recordingMode}
              onValueChange={(v) =>
                update("recordingMode", v as "always" | "event" | "both")
              }
            >
              {(["always", "event", "both"] as const).map((mode) => (
                <label
                  key={mode}
                  htmlFor={`recording-mode-${mode}`}
                  className="flex items-center gap-2 cursor-pointer"
                >
                  <RadioGroupItem
                    value={mode}
                    id={`recording-mode-${mode}`}
                  />
                  <span className="text-sm capitalize">{mode}</span>
                  {mode === "always" && (
                    <span className="text-xs text-muted-foreground">
                      — continuous recording regardless of events
                    </span>
                  )}
                  {mode === "event" && (
                    <span className="text-xs text-muted-foreground">
                      — record only when an event is detected
                    </span>
                  )}
                  {mode === "both" && (
                    <span className="text-xs text-muted-foreground">
                      — always record; longer clips on events
                    </span>
                  )}
                </label>
              ))}
            </RadioGroup>

            <div className="pl-1 space-y-4">
              <SliderWithLabel
                label="event_record_length_secs"
                value={local.eventRecordLengthSecs}
                min={5}
                max={60}
                step={1}
                disabled={local.recordingMode === "always"}
                onChange={(v) => update("eventRecordLengthSecs", Math.round(v))}
                formatValue={(v) => `${v} s`}
                description="Clip length captured around a detected event (5–60 s). Disabled when mode is 'always'."
              />

              <SliderWithLabel
                label="record_buffer_length_secs"
                value={local.recordBufferLengthSecs}
                min={0}
                max={10}
                step={1}
                disabled={local.recordingMode === "always"}
                onChange={(v) => update("recordBufferLengthSecs", Math.round(v))}
                formatValue={(v) => `${v} s`}
                description="Pre-event ring buffer kept in memory (0–10 s). Disabled when mode is 'always'."
              />
            </div>
          </div>

          {/* ── Codec & Keyframe ── */}
          <div className="space-y-3">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Codec &amp; Keyframe
            </h4>

            <div className="space-y-1">
              <Label>supported_video_codecs</Label>
              <div className="flex gap-4">
                {(["h264", "h265"] as const).map((codec) => (
                  <label
                    key={codec}
                    className="flex items-center gap-2 cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      className="accent-primary h-4 w-4"
                      checked={local.supportedVideoCodecs.includes(codec)}
                      onChange={(e) => toggleCodec(codec, e.target.checked)}
                    />
                    <span className="text-sm">{codec.toUpperCase()}</span>
                  </label>
                ))}
              </div>
              {local.supportedVideoCodecs.length === 0 && (
                <p className="text-xs text-destructive">
                  At least one codec must be selected.
                </p>
              )}
            </div>

            <div className="space-y-1">
              <Label>default_gov_length</Label>
              <Input
                type="number"
                min={1}
                max={300}
                value={local.defaultGovLength}
                onChange={(e) =>
                  update(
                    "defaultGovLength",
                    Math.max(1, parseInt(e.target.value) || 1)
                  )
                }
                className="w-32"
              />
              {local.defaultGovLength <= 0 ? (
                <p className="text-xs text-destructive">
                  Invalid GOP — must be ≥ 1
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Keyframe every {local.defaultGovLength} frames ≈{" "}
                  {(local.defaultGovLength / 30).toFixed(2)}s at 30 fps. VST
                  segments split on keyframe boundaries — a smaller GoP allows
                  finer segment durations (and more S3 PUTs); a larger one means
                  coarser segments and fewer PUTs.
                </p>
              )}
            </div>
          </div>

          {/* ── Storage ── */}
          <div className="space-y-3">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Storage
            </h4>

            <SliderWithLabel
              label="storage_threshold_percentage"
              value={local.storageThresholdPercentage}
              min={50}
              max={99}
              step={1}
              onChange={(v) =>
                update("storageThresholdPercentage", Math.round(v))
              }
              formatValue={(v) => `${v}%`}
              description="S3 bucket fill level at which aging policy triggers (50–99%)."
            />

            <div className="space-y-1">
              <Label>storage_monitoring_frequency_secs</Label>
              <Input
                type="number"
                min={1}
                max={60}
                value={local.storageMonitoringFrequencySecs}
                onChange={(e) =>
                  update(
                    "storageMonitoringFrequencySecs",
                    Math.max(1, Math.min(60, parseInt(e.target.value) || 10))
                  )
                }
                className="w-32"
              />
              <p className="text-xs text-muted-foreground">
                How often the VST sensor polls S3 fill level (1–60 s).
              </p>
            </div>

            <div className="space-y-1">
              <Label>default_file_expiry_minutes</Label>
              <Input
                type="number"
                min={1}
                value={local.defaultFileExpiryMinutes}
                onChange={(e) =>
                  update(
                    "defaultFileExpiryMinutes",
                    Math.max(1, parseInt(e.target.value) || 1440)
                  )
                }
                className="w-32"
              />
              <p className="text-xs text-muted-foreground">
                {expiryLabel(local.defaultFileExpiryMinutes)} — object lifetime
                before aging policy may remove the file.
              </p>
            </div>
          </div>

          {/* ── Advanced ── */}
          <div className="space-y-3">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Advanced
            </h4>

            <div className="flex items-center justify-between">
              <div>
                <Label htmlFor="enable-aging-policy">enable_aging_policy</Label>
                <p className="text-xs text-muted-foreground">
                  Allow the VST sensor to delete expired files when the storage
                  threshold is exceeded.
                </p>
              </div>
              <Switch
                id="enable-aging-policy"
                checked={local.enableAgingPolicy}
                onCheckedChange={(v) => update("enableAgingPolicy", v)}
              />
            </div>

            <div className="flex items-start justify-between gap-4">
              <div className="flex-1">
                <Label htmlFor="recorder-frame-drop">
                  recorder_enable_frame_drop
                </Label>
                <p className="text-xs text-muted-foreground">
                  Allow the recorder to drop frames when it cannot keep up with
                  the ingest rate.
                </p>
                {!local.recorderEnableFrameDrop && (
                  <div className="mt-2 flex items-start gap-2 rounded-md border border-yellow-600/40 bg-yellow-600/10 p-2">
                    <AlertTriangle className="h-3.5 w-3.5 text-yellow-500 mt-0.5 shrink-0" />
                    <p className="text-xs text-yellow-300">
                      Disabling frame drop may cause the recorder to stall under
                      load; frames back up in memory instead of being dropped.
                    </p>
                  </div>
                )}
              </div>
              <Switch
                id="recorder-frame-drop"
                checked={local.recorderEnableFrameDrop}
                onCheckedChange={(v) => update("recorderEnableFrameDrop", v)}
              />
            </div>
          </div>

          {isDirty && (
            <div className="text-xs text-yellow-400 bg-yellow-400/10 rounded px-3 py-1.5 border border-yellow-400/20">
              Unsaved changes
            </div>
          )}
        </div>
      )}

      {/* Confirm dialog */}
      <Dialog
        open={confirmOpen}
        onOpenChange={saving ? undefined : setConfirmOpen}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Save VST Recording Tuning?</DialogTitle>
            <DialogDescription>
              This will patch the VST config and restart the VST sensor +
              stream processor. RTSP streams reconnect automatically but
              there will be a 5–10 s recording gap.
            </DialogDescription>
          </DialogHeader>

          {saving ? (
            <ul className="space-y-2 py-2">
              {steps.map((step, i) => (
                <li key={i} className="flex items-center gap-2 text-sm">
                  {step.status === "running" && (
                    <Loader2 className="h-4 w-4 animate-spin text-primary" />
                  )}
                  {step.status === "done" && (
                    <span className="text-green-500">✓</span>
                  )}
                  {step.status === "pending" && (
                    <span className="text-muted-foreground">○</span>
                  )}
                  {step.status === "error" && (
                    <span className="text-destructive">✗</span>
                  )}
                  <span
                    className={
                      step.status === "done"
                        ? "line-through text-muted-foreground"
                        : ""
                    }
                  >
                    {step.label}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <div className="space-y-3">
              {/* Field-level diff */}
              {diffRows.length === 0 ? (
                <p className="text-xs text-muted-foreground">No changes to apply.</p>
              ) : (
                <div className="rounded-md border border-border bg-muted/10 p-3 space-y-1">
                  {diffRows.map((row) => (
                    <div
                      key={row.field}
                      className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-baseline gap-x-2 font-mono text-xs"
                    >
                      <span className="text-muted-foreground truncate">
                        {row.field}
                      </span>
                      <span className="text-muted-foreground whitespace-nowrap">
                        {row.oldVal}
                      </span>
                      <span className="text-foreground font-semibold whitespace-nowrap before:content-['→'] before:mx-1 before:text-muted-foreground">
                        {row.newVal}
                      </span>
                    </div>
                  ))}
                </div>
              )}

              {/* Warning banner */}
              <div className="flex items-start gap-2 rounded-md border border-yellow-600/40 bg-yellow-600/10 p-3">
                <AlertTriangle className="h-4 w-4 text-yellow-500 mt-0.5 shrink-0" />
                <p className="text-sm text-yellow-300">
                  VST sensor and stream processor will restart — expect a 5–10 s
                  recording gap while RTSP streams reconnect.
                </p>
              </div>
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
              {saving ? "Saving…" : "Confirm"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

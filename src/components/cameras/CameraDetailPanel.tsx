"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Camera, Scenario, RecordingPolicy } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { Loader2, Save, RotateCcw } from "lucide-react";
import { z } from "zod";
import { ScenarioSchema } from "@/lib/schemas";

// ─── Types ────────────────────────────────────────────────────────────────────

interface PanelProps {
  camera: Camera & { gcsPersisted?: boolean };
}

interface RecordingState {
  enabled: boolean;
  policy: RecordingPolicy;
  retentionDays: number;
}

const DEFAULT_RECORDING: RecordingState = {
  enabled: true,
  policy: "always",
  retentionDays: 7,
};

// ─── Scenarios fetch ──────────────────────────────────────────────────────────

const ScenarioListSchema = z.object({
  scenarios: z.array(ScenarioSchema),
});

function useScenariosQuery() {
  return useQuery({
    queryKey: ["scenarios"],
    queryFn: async () => {
      const res = await fetch("/api/scenarios");
      if (!res.ok) throw new Error("Failed to fetch scenarios");
      const raw = await res.json();
      return ScenarioListSchema.parse(raw).scenarios;
    },
    staleTime: 60_000,
  });
}

// ─── Scenario multi-select ────────────────────────────────────────────────────

interface ScenarioMultiSelectProps {
  allScenarios: Scenario[];
  selectedIds: string[];
  onChange: (ids: string[]) => void;
}

function ScenarioMultiSelect({
  allScenarios,
  selectedIds,
  onChange,
}: ScenarioMultiSelectProps) {
  const toggle = (id: string) => {
    if (selectedIds.includes(id)) {
      onChange(selectedIds.filter((s) => s !== id));
    } else {
      onChange([...selectedIds, id]);
    }
  };

  if (allScenarios.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        No scenarios defined — add scenarios first.
      </p>
    );
  }

  return (
    <div className="flex flex-wrap gap-2">
      {allScenarios.map((sc) => {
        const selected = selectedIds.includes(sc.id);
        return (
          <button
            key={sc.id}
            type="button"
            onClick={() => toggle(sc.id)}
            className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs transition-colors ${
              selected
                ? "border-primary bg-primary/20 text-primary"
                : "border-border bg-muted/20 text-muted-foreground hover:border-muted-foreground"
            }`}
            title={sc.description ?? sc.name}
          >
            {sc.name}
            {!sc.enabled && (
              <span className="text-[10px] opacity-60">(disabled)</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

// ─── Main panel ───────────────────────────────────────────────────────────────

export function CameraDetailPanel({ camera }: PanelProps) {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: allScenarios, isLoading: scenariosLoading } = useScenariosQuery();

  // ─── Local state initialised from camera prop ──────────────────────────────

  /** true = the operator has explicitly enabled the scenario override toggle. */
  const [overrideEnabled, setOverrideEnabled] = React.useState<boolean>(
    camera.scenarioIds !== undefined,
  );

  const [selectedScenarioIds, setSelectedScenarioIds] = React.useState<string[]>(
    camera.scenarioIds ?? [],
  );

  const [recordingOverride, setRecordingOverride] = React.useState<boolean>(
    camera.recording !== undefined,
  );

  const [recording, setRecording] = React.useState<RecordingState>(
    camera.recording ?? DEFAULT_RECORDING,
  );

  // Track whether anything has changed from the prop values.
  const isDirty = React.useMemo(() => {
    const propScenarioIds = camera.scenarioIds;
    const stateScenarioIds = overrideEnabled ? selectedScenarioIds : undefined;
    const scenarioDirty =
      JSON.stringify(propScenarioIds) !== JSON.stringify(stateScenarioIds);

    const propRecording = camera.recording;
    const stateRecording = recordingOverride ? recording : undefined;
    const recordingDirty =
      JSON.stringify(propRecording) !== JSON.stringify(stateRecording);

    return scenarioDirty || recordingDirty;
  }, [
    camera.scenarioIds,
    camera.recording,
    overrideEnabled,
    selectedScenarioIds,
    recordingOverride,
    recording,
  ]);

  const resetToServer = () => {
    setOverrideEnabled(camera.scenarioIds !== undefined);
    setSelectedScenarioIds(camera.scenarioIds ?? []);
    setRecordingOverride(camera.recording !== undefined);
    setRecording(camera.recording ?? DEFAULT_RECORDING);
  };

  // ─── Save mutation ─────────────────────────────────────────────────────────

  const saveMutation = useMutation({
    mutationFn: async () => {
      const body: {
        scenarioIds?: string[] | null;
        recording?: {
          enabled: boolean;
          policy: RecordingPolicy;
          retentionDays: number;
        } | null;
      } = {};

      if (overrideEnabled) {
        body.scenarioIds = selectedScenarioIds;
      } else {
        // Explicitly null = clear the override.
        body.scenarioIds = null;
      }

      if (recordingOverride) {
        body.recording = recording;
      } else {
        body.recording = null;
      }

      const res = await fetch(`/api/cameras/${camera.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Unknown error" }));
        throw new Error((err as { error?: string }).error ?? "Save failed");
      }

      return res.json() as Promise<{ ok: boolean; gcsWarning?: string }>;
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["cameras"] });
      toast({
        title: "Camera overrides saved",
        description: result.gcsWarning
          ? `Note: ${result.gcsWarning}`
          : undefined,
      });
    },
    onError: (err: Error) => {
      toast({
        title: "Save failed",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  // ─── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="pl-4 space-y-5 py-3">
      {/* Camera identity (read-only) */}
      <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
        <span className="text-muted-foreground font-medium">ID</span>
        <span className="font-mono">{camera.id}</span>
        <span className="text-muted-foreground font-medium">RTSP</span>
        <span className="font-mono truncate text-muted-foreground">
          {camera.feeds[0]?.rtspUrl ?? "—"}
        </span>
      </div>

      {/* Scenario bindings */}
      <div className="space-y-2">
        <div className="flex items-center gap-3">
          <Switch
            id={`scenario-override-${camera.id}`}
            checked={overrideEnabled}
            onCheckedChange={(v) => {
              setOverrideEnabled(v);
              if (!v) setSelectedScenarioIds([]);
            }}
          />
          <Label
            htmlFor={`scenario-override-${camera.id}`}
            className="text-sm font-medium cursor-pointer"
          >
            Override scenario bindings
          </Label>
          {!overrideEnabled && (
            <Badge
              variant="outline"
              className="text-[10px] px-1.5 py-0 border-slate-600 text-slate-400"
            >
              sensor_filter glob
            </Badge>
          )}
        </div>

        {overrideEnabled && (
          <div className="pl-8 space-y-1.5">
            <p className="text-xs text-muted-foreground">
              Select scenarios that fire for this camera. An empty selection
              explicitly suppresses all scenarios (no alerts).
            </p>
            {scenariosLoading ? (
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            ) : (
              <ScenarioMultiSelect
                allScenarios={allScenarios ?? []}
                selectedIds={selectedScenarioIds}
                onChange={setSelectedScenarioIds}
              />
            )}
            {overrideEnabled && selectedScenarioIds.length === 0 && (
              <p className="text-xs text-amber-400">
                No scenarios selected — all alerts suppressed for this camera.
              </p>
            )}
          </div>
        )}
      </div>

      {/* Recording policy */}
      <div className="space-y-2">
        <div className="flex items-center gap-3">
          <Switch
            id={`recording-override-${camera.id}`}
            checked={recordingOverride}
            onCheckedChange={(v) => {
              setRecordingOverride(v);
              if (!v) setRecording(DEFAULT_RECORDING);
            }}
          />
          <Label
            htmlFor={`recording-override-${camera.id}`}
            className="text-sm font-medium cursor-pointer"
          >
            Override recording policy
          </Label>
          {!recordingOverride && (
            <Badge
              variant="outline"
              className="text-[10px] px-1.5 py-0 border-slate-600 text-slate-400"
            >
              stack default
            </Badge>
          )}
        </div>

        {recordingOverride && (
          <div className="pl-8 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 items-center">
            <Label className="text-xs text-muted-foreground">Enabled</Label>
            <Switch
              checked={recording.enabled}
              onCheckedChange={(v) =>
                setRecording((r) => ({ ...r, enabled: v }))
              }
            />
            <Label className="text-xs text-muted-foreground">Policy</Label>
            <Select
              value={recording.policy}
              onValueChange={(v) =>
                setRecording((r) => ({
                  ...r,
                  policy: v as RecordingPolicy,
                }))
              }
            >
              <SelectTrigger className="h-8 w-36 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="always">Always</SelectItem>
                <SelectItem value="event-only">Event-only</SelectItem>
                <SelectItem value="off">Off</SelectItem>
              </SelectContent>
            </Select>
            <Label className="text-xs text-muted-foreground">
              Retention (days)
            </Label>
            <Input
              type="number"
              min={1}
              max={365}
              className="h-8 w-24 text-xs"
              value={recording.retentionDays}
              onChange={(e) =>
                setRecording((r) => ({
                  ...r,
                  retentionDays: Math.max(1, parseInt(e.target.value, 10) || 1),
                }))
              }
            />
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2 pt-1">
        <Button
          size="sm"
          onClick={() => saveMutation.mutate()}
          disabled={saveMutation.isPending || !isDirty}
          className="h-8"
        >
          {saveMutation.isPending ? (
            <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
          ) : (
            <Save className="h-3.5 w-3.5 mr-1.5" />
          )}
          Save changes
        </Button>
        {isDirty && (
          <Button
            variant="ghost"
            size="sm"
            onClick={resetToServer}
            disabled={saveMutation.isPending}
            className="h-8 text-muted-foreground"
          >
            <RotateCcw className="h-3.5 w-3.5 mr-1.5" />
            Reset
          </Button>
        )}
        {!isDirty && (
          <span className="text-xs text-muted-foreground">No pending changes</span>
        )}
      </div>
    </div>
  );
}

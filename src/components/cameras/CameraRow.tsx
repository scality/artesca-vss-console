"use client";

import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Camera } from "@/lib/types";
import { TableCell, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import { ChevronDown, ChevronRight, Trash2, RefreshCw, Video, VideoOff } from "lucide-react";
import { FeedList } from "./FeedList";
import { CameraDetailPanel } from "./CameraDetailPanel";
import type { PromptSet } from "@/components/prompt/PromptSetManager";

interface CameraRowProps {
  camera: Camera & { gcsPersisted?: boolean };
  eip: string;
  promptSets: PromptSet[];
}

/** Badge showing whether VST is actually recording this camera (timeline
 *  present), vs registered/live but not recording, vs unknown. Distinct from
 *  the recording-enabled *toggle* (operator intent) — this is observed state. */
function RecordingBadge({
  vstRecording,
  vstRegistered,
}: {
  vstRecording: boolean | undefined;
  vstRegistered: boolean;
}) {
  if (!vstRegistered) return null; // not in VST → recording status N/A
  if (vstRecording === undefined) {
    return (
      <Badge
        variant="outline"
        className="text-[10px] px-1.5 py-0 border-brand-light-gray text-muted-foreground"
        title="Recording status unknown — VST didn't report a timeline state"
      >
        REC ?
      </Badge>
    );
  }
  if (vstRecording) {
    return (
      <Badge
        variant="outline"
        className="text-[10px] px-1.5 py-0 bg-emerald-50 border-emerald-200 text-emerald-700"
        title="VST is actively recording this camera to the objectstore"
      >
        ● REC
      </Badge>
    );
  }
  return (
    <Badge
      variant="outline"
      className="text-[10px] px-1.5 py-0 bg-red-50 border-red-200 text-red-700"
      title="Camera is live in VST but NOT recording — no timeline. Re-spin recording (toggle off/on) or check objectstore credentials."
    >
      NOT RECORDING
    </Badge>
  );
}

/** Badge indicating where the camera definition lives. */
function GcsBadge({
  gcsPersisted,
  vstRegistered,
}: {
  gcsPersisted: boolean | undefined;
  vstRegistered: boolean;
}) {
  if (gcsPersisted === undefined) return null;

  if (gcsPersisted && vstRegistered) {
    return (
      <Badge
        variant="outline"
        className="text-[10px] px-1.5 py-0 bg-emerald-50 border-emerald-200 text-emerald-700"
        title="Camera is persisted in GCS and registered in VST"
      >
        PERSISTED
      </Badge>
    );
  }

  if (!gcsPersisted && vstRegistered) {
    return (
      <Badge
        variant="outline"
        className="text-[10px] px-1.5 py-0 bg-amber-50 border-amber-200 text-amber-700"
        title="Camera is running in VST but not saved to GCS — use Save all to GCS to persist"
      >
        RUNTIME-ONLY
      </Badge>
    );
  }

  // gcsPersisted && !vstRegistered — in GCS but startup bootstrap has not yet
  // registered it (or VST is unreachable).
  return (
    <Badge
      variant="outline"
      className="text-[10px] px-1.5 py-0 border-brand-light-gray text-muted-foreground"
      title="Camera is saved in GCS but not yet registered in VST (will restore on next console restart)"
    >
      PENDING-RESTORE
    </Badge>
  );
}

const roleBadgeClass: Record<Camera["role"], string> = {
  checkout: "border-brand-indigo/40 text-brand-indigo",
  aisle: "border-brand-magenta/40 text-brand-magenta",
  dock: "border-brand-orange/40 text-brand-orange",
  backroom: "border-brand-light-gray text-muted-foreground",
  other: "border-muted-foreground text-muted-foreground",
};

export function CameraRow({ camera, eip, promptSets }: CameraRowProps) {
  const [expanded, setExpanded] = React.useState(false);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const bindPromptMutation = useMutation({
    mutationFn: async (promptId: string | null) => {
      const res = await fetch(`/api/cameras/${camera.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ promptId }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: "Unknown error" }));
        throw new Error((body as { error?: string }).error ?? "Save failed");
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["cameras"] });
      toast({ title: "Detection prompt updated" });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to update detection prompt", description: err.message, variant: "destructive" });
    },
  });

  const removeCamera = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/cameras/${camera.id}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error("Delete failed");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["cameras"] });
      toast({ title: `Camera ${camera.id} removed` });
    },
    onError: () => {
      toast({ title: "Failed to remove camera", variant: "destructive" });
    },
  });

  // Current recording state — default ON when the camera carries no explicit
  // recording override (matches the stack default).
  const recordingEnabled = camera.recording?.enabled ?? true;
  const recordingPolicy = camera.recording?.policy ?? "always";
  const recordingRetentionDays = camera.recording?.retentionDays ?? 7;

  const toggleRecording = useMutation({
    mutationFn: async () => {
      const next = !recordingEnabled;
      const res = await fetch(`/api/cameras/${camera.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recording: {
            enabled: next,
            policy: recordingPolicy,
            retentionDays: recordingRetentionDays,
          },
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: "Unknown error" }));
        throw new Error((body as { error?: string }).error ?? "Save failed");
      }
      return res.json() as Promise<{ ok: boolean; warnings?: string[] }>;
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["cameras"] });
      const turnedOn = !recordingEnabled;
      const warning = result.warnings?.[0];
      toast({
        title: turnedOn
          ? `Recording enabled for ${camera.id}`
          : `Recording disabled for ${camera.id}`,
        description: warning ? `Note: ${warning}` : undefined,
        ...(warning ? { variant: "destructive" as const } : {}),
      });
    },
    onError: (err: Error) => {
      toast({
        title: "Failed to change recording",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  const restartReplay = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/cameras/${camera.id}/restart`, {
        method: "POST",
      });
      if (!res.ok) throw new Error("Restart failed");
    },
    onSuccess: () => {
      toast({ title: `Replay restarted for ${camera.id}` });
    },
    onError: () => {
      toast({ title: "Restart failed", variant: "destructive" });
    },
  });

  return (
    <>
      <TableRow className="cursor-pointer hover:bg-muted/40">
        <TableCell className="w-8 px-2">
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? (
              <ChevronDown className="h-4 w-4" />
            ) : (
              <ChevronRight className="h-4 w-4" />
            )}
          </Button>
        </TableCell>
        <TableCell className="font-mono text-sm font-medium">
          <div className="flex items-center gap-2">
            {camera.id}
            <GcsBadge
              gcsPersisted={(camera as Camera & { gcsPersisted?: boolean }).gcsPersisted}
              vstRegistered={camera.feeds[0]?.vstRegistered ?? false}
            />
            <RecordingBadge
              vstRecording={camera.feeds[0]?.vstRecording}
              vstRegistered={camera.feeds[0]?.vstRegistered ?? false}
            />
          </div>
        </TableCell>
        <TableCell>
          <Badge
            variant="outline"
            className={`text-xs ${roleBadgeClass[camera.role]}`}
          >
            {camera.role}
          </Badge>
        </TableCell>
        <TableCell className="text-sm text-muted-foreground">
          {camera.description ?? "—"}
        </TableCell>
        <TableCell className="text-sm text-muted-foreground">
          {camera.feeds.length} feed{camera.feeds.length !== 1 ? "s" : ""}
        </TableCell>
        <TableCell>
          <select
            className="h-7 rounded-md border border-input bg-background px-2 py-0 text-xs ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
            value={camera.promptId ?? ""}
            disabled={bindPromptMutation.isPending}
            onChange={(e) => {
              const value = e.target.value;
              bindPromptMutation.mutate(value || null);
            }}
          >
            <option value="">— none —</option>
            {promptSets.map((ps) => (
              <option key={ps.id} value={ps.id}>
                {ps.name}
              </option>
            ))}
          </select>
        </TableCell>
        <TableCell className="text-right">
          <div className="flex justify-end gap-1">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => restartReplay.mutate()}
              disabled={restartReplay.isPending}
              title="Restart replay"
            >
              <RefreshCw className="h-3 w-3 mr-1" />
              Restart
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => toggleRecording.mutate()}
              disabled={toggleRecording.isPending}
              title={
                recordingEnabled
                  ? "Stop recording this camera on the VST (keeps it registered + live)"
                  : "Start recording this camera on the VST"
              }
            >
              {recordingEnabled ? (
                <VideoOff className="h-3 w-3 mr-1" />
              ) : (
                <Video className="h-3 w-3 mr-1" />
              )}
              {recordingEnabled ? "Disable recording" : "Enable recording"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs text-destructive hover:text-destructive"
              onClick={() => {
                if (confirm(`Remove camera ${camera.id}?`)) {
                  removeCamera.mutate();
                }
              }}
              disabled={removeCamera.isPending}
              title="Remove camera"
            >
              <Trash2 className="h-3 w-3 mr-1" />
              Remove
            </Button>
          </div>
        </TableCell>
      </TableRow>
      {expanded && (
        <TableRow>
          <TableCell colSpan={7} className="py-2 bg-muted/10">
            <Tabs defaultValue="feeds" className="w-full">
              <TabsList className="h-7 mb-2 bg-muted/40">
                <TabsTrigger value="feeds" className="h-6 text-xs px-3">
                  Feeds
                </TabsTrigger>
                <TabsTrigger value="bindings" className="h-6 text-xs px-3">
                  Scenario bindings &amp; recording
                </TabsTrigger>
              </TabsList>
              <TabsContent value="feeds">
                <FeedList cameraId={camera.id} feeds={camera.feeds} eip={eip} />
              </TabsContent>
              <TabsContent value="bindings">
                <CameraDetailPanel camera={camera} />
              </TabsContent>
            </Tabs>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

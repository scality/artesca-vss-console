"use client";

import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Camera } from "@/lib/types";
import { TableCell, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import { ChevronDown, ChevronRight, Trash2, RefreshCw } from "lucide-react";
import { FeedList } from "./FeedList";
import { CameraDetailPanel } from "./CameraDetailPanel";

interface CameraRowProps {
  camera: Camera & { gcsPersisted?: boolean };
  eip: string;
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
        className="text-[10px] px-1.5 py-0 border-emerald-600 text-emerald-400"
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
        className="text-[10px] px-1.5 py-0 border-amber-500 text-amber-400"
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
      className="text-[10px] px-1.5 py-0 border-slate-500 text-slate-400"
      title="Camera is saved in GCS but not yet registered in VST (will restore on next console restart)"
    >
      PENDING-RESTORE
    </Badge>
  );
}

const roleBadgeClass: Record<Camera["role"], string> = {
  checkout: "border-blue-600 text-blue-400",
  aisle: "border-purple-600 text-purple-400",
  dock: "border-orange-600 text-orange-400",
  backroom: "border-gray-600 text-gray-400",
  other: "border-muted-foreground text-muted-foreground",
};

export function CameraRow({ camera, eip }: CameraRowProps) {
  const [expanded, setExpanded] = React.useState(false);
  const queryClient = useQueryClient();
  const { toast } = useToast();

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
          <TableCell colSpan={6} className="py-2 bg-muted/10">
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

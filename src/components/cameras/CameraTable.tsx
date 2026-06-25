"use client";

import * as React from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { Camera } from "@/lib/types";
import { CameraSchema } from "@/lib/schemas";
import { z } from "zod";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { Loader2, PlusCircle, CloudUpload } from "lucide-react";
import { classifyListState } from "@/lib/diagnostics/list-state";
import { CameraRow } from "./CameraRow";
import { AddCameraDialog } from "./AddCameraDialog";
import type { PromptSet } from "@/components/prompt/PromptSetManager";

const GcsStatusSchema = z.object({
  available: z.boolean(),
  lastUpdated: z.string().optional(),
  lastUpdatedBy: z.string().optional(),
  totalCameras: z.number().optional(),
});

const PromptSetsResponseSchema = z.object({
  sets: z.array(z.object({ id: z.string(), name: z.string(), text: z.string(), model: z.string().optional(), alertType: z.string().optional() })),
});

const CameraWithGcsSchema = CameraSchema.extend({
  gcsPersisted: z.boolean().optional(),
});

const CamerasResponseSchema = z.object({
  cameras: z.array(CameraWithGcsSchema),
  eip: z.string(),
  gcs: GcsStatusSchema.optional(),
  warnings: z.array(z.string()).optional(),
});

export function CameraTable() {
  const [addOpen, setAddOpen] = React.useState(false);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: promptData } = useQuery({
    queryKey: ["prompt"],
    queryFn: async () => {
      const res = await fetch("/api/prompt");
      if (!res.ok) throw new Error("Failed to fetch prompt sets");
      const raw = await res.json();
      return PromptSetsResponseSchema.parse(raw);
    },
    staleTime: 60_000,
  });

  const promptSets: PromptSet[] = promptData?.sets ?? [];

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["cameras"],
    queryFn: async () => {
      const res = await fetch("/api/cameras");
      if (!res.ok) throw new Error("Failed to fetch cameras");
      const raw = await res.json();
      return CamerasResponseSchema.parse(raw);
    },
    staleTime: 30_000,
    refetchInterval: 60_000,
  });

  const syncToGcs = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/cameras/sync-gcs", { method: "POST" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: "Unknown error" }));
        throw new Error(body.error ?? "Sync failed");
      }
      return res.json();
    },
    onSuccess: (result: { synced?: number; warnings?: string[] }) => {
      queryClient.invalidateQueries({ queryKey: ["cameras"] });
      toast({
        title: `Saved ${result.synced ?? 0} cameras to GCS`,
        description: result.warnings?.length
          ? result.warnings.join("; ")
          : undefined,
      });
    },
    onError: (err: Error) => {
      toast({
        title: "Save to GCS failed",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Cameras</h2>
          <p className="text-sm text-muted-foreground">
            Manage camera feeds and sensor registration.
          </p>
          {data?.gcs?.available === true && (
            <p className="text-xs text-muted-foreground mt-0.5">
              GCS:{" "}
              <span className="text-emerald-700">
                {data.gcs.totalCameras ?? 0} cameras persisted
                {data.gcs.lastUpdatedBy ? ` · last by ${data.gcs.lastUpdatedBy}` : ""}
              </span>
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          {data?.gcs?.available === true && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => syncToGcs.mutate()}
              disabled={syncToGcs.isPending}
              title="Save current VST camera list to GCS for persistence across restarts"
            >
              {syncToGcs.isPending ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <CloudUpload className="h-4 w-4 mr-2" />
              )}
              Save all to GCS
            </Button>
          )}
          <Button onClick={() => setAddOpen(true)}>
            <PlusCircle className="h-4 w-4 mr-2" />
            Add Camera
          </Button>
        </div>
      </div>

      {isLoading && (
        <div className="flex items-center gap-2 text-muted-foreground py-8 justify-center">
          <Loader2 className="h-5 w-5 animate-spin" />
          <span>Loading cameras...</span>
        </div>
      )}

      {isError && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive">
          Failed to load cameras:{" "}
          {error instanceof Error ? error.message : "Unknown error"}
        </div>
      )}

      {data && (
        <>
          <div className="rounded-md border border-border overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8" />
                  <TableHead>Camera ID</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead>Feeds</TableHead>
                  <TableHead>Detection prompt</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(() => {
                  const listState = classifyListState(data.warnings, data.cameras.length);
                  if (listState === "error") {
                    const msg =
                      (data.warnings ?? []).find((w) => /config store unavailable/i.test(w)) ??
                      "config store unavailable";
                    return (
                      <TableRow>
                        <TableCell colSpan={7} className="py-6">
                          <div className="rounded border border-brand-red/40 bg-red-50 px-3 py-2 text-sm text-brand-red">
                            <strong>Persistence unavailable</strong> — cameras could not be loaded (this is not an empty list).
                            <div className="mt-1 font-mono text-xs opacity-80">{msg}</div>
                            <div className="mt-1 text-xs">See Diagnostics → Config store (Firestore).</div>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  }
                  if (listState === "empty") {
                    return (
                      <TableRow>
                        <TableCell
                          colSpan={7}
                          className="text-center text-muted-foreground py-8"
                        >
                          No cameras registered. Add one to get started.
                        </TableCell>
                      </TableRow>
                    );
                  }
                  return data.cameras.map((camera) => (
                    <CameraRow key={camera.id} camera={camera} eip={data.eip} promptSets={promptSets} />
                  ));
                })()}
              </TableBody>
            </Table>
          </div>

          <AddCameraDialog
            open={addOpen}
            onOpenChange={setAddOpen}
            eip={data.eip}
          />
        </>
      )}

      {!data && !isLoading && (
        <AddCameraDialog
          open={addOpen}
          onOpenChange={setAddOpen}
          eip=""
        />
      )}
    </div>
  );
}

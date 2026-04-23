"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
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
import { Loader2, PlusCircle } from "lucide-react";
import { CameraRow } from "./CameraRow";
import { AddCameraDialog } from "./AddCameraDialog";

const CamerasResponseSchema = z.object({
  cameras: z.array(CameraSchema),
  eip: z.string(),
  warnings: z.array(z.string()).optional(),
});

export function CameraTable() {
  const [addOpen, setAddOpen] = React.useState(false);

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

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Cameras</h2>
          <p className="text-sm text-muted-foreground">
            Manage camera feeds and sensor registration.
          </p>
        </div>
        <Button onClick={() => setAddOpen(true)}>
          <PlusCircle className="h-4 w-4 mr-2" />
          Add Camera
        </Button>
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
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.cameras.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={6}
                      className="text-center text-muted-foreground py-8"
                    >
                      No cameras registered. Add one to get started.
                    </TableCell>
                  </TableRow>
                ) : (
                  data.cameras.map((camera) => (
                    <CameraRow key={camera.id} camera={camera} />
                  ))
                )}
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

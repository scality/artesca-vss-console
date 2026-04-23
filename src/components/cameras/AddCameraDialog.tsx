"use client";

import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
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
import { FeedUploader, type FeedDraft } from "./FeedUploader";
import {
  RegisterProgress,
  type ProgressStep,
  DEFAULT_STEPS,
} from "./RegisterProgress";

interface AddCameraDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  eip: string;
}

const CAMERA_ID_PATTERN = /^[a-z]+-\d+$/;
const ROLES = ["checkout", "aisle", "dock", "backroom", "other"] as const;

function validateCameraId(id: string): string | null {
  if (!id) return "Camera ID is required";
  if (!CAMERA_ID_PATTERN.test(id))
    return "Must match <role>-<n> pattern, e.g. checkout-1";
  return null;
}

export function AddCameraDialog({
  open,
  onOpenChange,
  eip,
}: AddCameraDialogProps) {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [cameraId, setCameraId] = React.useState("");
  const [role, setRole] = React.useState<string>("checkout");
  const [description, setDescription] = React.useState("");
  const [feeds, setFeeds] = React.useState<FeedDraft[]>([]);
  const [steps, setSteps] = React.useState<ProgressStep[]>(DEFAULT_STEPS);
  const [submitting, setSubmitting] = React.useState(false);

  const idError = cameraId ? validateCameraId(cameraId) : null;

  const reset = () => {
    setCameraId("");
    setRole("checkout");
    setDescription("");
    setFeeds([]);
    setSteps(DEFAULT_STEPS.map((s) => ({ ...s, status: "pending" })));
    setSubmitting(false);
  };

  const handleClose = (open: boolean) => {
    if (!submitting) {
      reset();
      onOpenChange(open);
    }
  };

  const setStep = (idx: number, status: ProgressStep["status"], detail?: string) => {
    setSteps((prev) =>
      prev.map((s, i) => (i === idx ? { ...s, status, detail } : s))
    );
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (idError || feeds.length === 0) return;

    setSubmitting(true);
    setSteps(DEFAULT_STEPS.map((s) => ({ ...s, status: "pending" })));

    // POST /api/cameras is now synchronous: the console route SCPs the .ts
    // file, calls the camera-sim control-plane (which rewrites YAML +
    // restarts the stack), and returns. No more k8s Job + SSE — the whole
    // request takes ~10s. We still show the progress steps so the operator
    // sees the phases, but flip them in sequence during a single await.
    try {
      setStep(0, "running");
      const body = {
        cameraId,
        role,
        description,
        feeds: feeds.map((f) => ({
          feedId: f.feedId,
          fileName: f.fileName,
          fileBase64: f.fileBase64,
        })),
      };

      const res = await fetch("/api/cameras", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      setStep(0, "done");
      setStep(1, "done");

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Unknown error" }));
        throw new Error(err.error ?? "Request failed");
      }

      setStep(2, "done");
      setStep(3, "done");
      queryClient.invalidateQueries({ queryKey: ["cameras"] });
      toast({
        title: "Camera added",
        description: `${cameraId} registered successfully.`,
      });
      setTimeout(() => {
        reset();
        onOpenChange(false);
      }, 800);
    } catch (err: unknown) {
      setStep(0, "error", err instanceof Error ? err.message : "Unknown error");
      setSubmitting(false);
      toast({
        title: "Failed to add camera",
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add Camera</DialogTitle>
          <DialogDescription>
            Register a new camera with its feed files. Feeds will be uploaded
            and the sensor will be registered with VST.
          </DialogDescription>
        </DialogHeader>

        {submitting ? (
          <div className="py-4">
            <RegisterProgress steps={steps} />
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-1">
              <Label htmlFor="camera-id">Camera ID</Label>
              <Input
                id="camera-id"
                value={cameraId}
                onChange={(e) => setCameraId(e.target.value.toLowerCase())}
                placeholder="checkout-1"
                disabled={submitting}
              />
              {idError && (
                <p className="text-xs text-destructive">{idError}</p>
              )}
              <p className="text-xs text-muted-foreground">
                Format: &lt;role&gt;-&lt;n&gt;, e.g. aisle-3
              </p>
            </div>

            <div className="space-y-1">
              <Label>Role</Label>
              <Select value={role} onValueChange={setRole}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ROLES.map((r) => (
                    <SelectItem key={r} value={r}>
                      {r}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1">
              <Label htmlFor="description">Description (optional)</Label>
              <Input
                id="description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Main entrance checkout lane"
                disabled={submitting}
              />
            </div>

            <FeedUploader
              cameraId={cameraId}
              eip={eip}
              feeds={feeds}
              onChange={setFeeds}
            />

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => handleClose(false)}
                disabled={submitting}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={
                  submitting || !!idError || !cameraId || feeds.length === 0
                }
              >
                Add Camera
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

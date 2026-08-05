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

// Must match the server contract (AddCameraSchema). The old <role>-<n> form
// rejected the showroom's own camera names (e.g. pyramid-16-cam0).
const CAMERA_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const ROLES = ["checkout", "aisle", "dock", "backroom", "other"] as const;

function validateCameraId(id: string): string | null {
  if (!id) return "Camera ID is required";
  if (!CAMERA_ID_PATTERN.test(id))
    return "Lower-case letters, digits, - and _ only (max 32), e.g. checkout-1 or pyramid-16-cam0";
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
  // A camera that already speaks RTSP (IP camera on the store LAN) needs no
  // uploaded footage and no camera-sim — the common case on a real deployment.
  const [rtspUrl, setRtspUrl] = React.useState("");
  const [steps, setSteps] = React.useState<ProgressStep[]>(DEFAULT_STEPS);
  // Direct-RTSP registers with VST straight away; the camera-sim upload /
  // ConfigMap / restart steps do not run, so don't display them as done.
  const RTSP_STEPS: ProgressStep[] = [
    { label: "Saving camera definition...", status: "pending" },
    { label: "Registering sensor with VST...", status: "pending" },
    { label: "Arming the recording stream...", status: "pending" },
  ];
  const [submitting, setSubmitting] = React.useState(false);

  const idError = cameraId ? validateCameraId(cameraId) : null;

  const reset = () => {
    setCameraId("");
    setRole("checkout");
    setDescription("");
    setFeeds([]);
    setRtspUrl("");
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
      const directRtsp = rtspUrl.trim().length > 0;
      if (directRtsp) setSteps(RTSP_STEPS.map((s) => ({ ...s })));
      setStep(0, "running");
      const body = {
        cameraId,
        role,
        description,
        ...(directRtsp
          ? { rtspUrl: rtspUrl.trim() }
          : {
              feeds: feeds.map((f) => ({
                feedId: f.feedId,
                fileName: f.fileName,
                fileBase64: f.fileBase64,
              })),
            }),
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

            <div className="space-y-1">
              <Label htmlFor="rtspUrl">RTSP URL</Label>
              <Input
                id="rtspUrl"
                value={rtspUrl}
                onChange={(e) => setRtspUrl(e.target.value)}
                placeholder="rtsp://10.172.0.16:8556/video0"
                disabled={submitting || feeds.length > 0}
              />
              <p className="text-xs text-muted-foreground">
                For a camera that already speaks RTSP (an IP camera on the store
                network). Registers it directly — no footage upload and no
                camera-sim needed. Leave empty to upload footage instead.
              </p>
            </div>

            {rtspUrl.trim().length === 0 && (
              <FeedUploader
                cameraId={cameraId}
                eip={eip}
                feeds={feeds}
                onChange={setFeeds}
              />
            )}

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
                  submitting ||
                  !!idError ||
                  !cameraId ||
                  (feeds.length === 0 && rtspUrl.trim().length === 0)
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

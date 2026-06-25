"use client";

import * as React from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { AlertTriangle, Loader2 } from "lucide-react";

export type SwapTarget = "primary" | "preview";

interface ModelSwapDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  modelName: string;
  target: SwapTarget;
  onConfirm: () => Promise<void>;
}

export function ModelSwapDialog({
  open,
  onOpenChange,
  modelName,
  target,
  onConfirm,
}: ModelSwapDialogProps) {
  const [loading, setLoading] = React.useState(false);

  const handleConfirm = async () => {
    setLoading(true);
    try {
      await onConfirm();
      onOpenChange(false);
    } finally {
      setLoading(false);
    }
  };

  const isPrimary = target === "primary";

  return (
    <Dialog open={open} onOpenChange={loading ? undefined : onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {isPrimary ? "Make Primary NIM" : "Make Preview NIM"}
          </DialogTitle>
          <DialogDescription>
            Set <strong>{modelName}</strong> as the{" "}
            {isPrimary ? "primary live inference" : "preview"} model.
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3">
          <AlertTriangle className="h-4 w-4 text-amber-700 mt-0.5 shrink-0" />
          <div className="text-sm text-amber-700">
            {isPrimary ? (
              <>
                This will restart <strong>vss-rtvi-vlm</strong> — expect ~30 s
                downtime. On first cold start, warmup may take{" "}
                <strong>~28 min</strong>; subsequent restarts with cached weights
                take ~3 min.
              </>
            ) : (
              <>
                This will restart the preview NIM container — expect a brief
                (~60 s) interruption to the preview service.
              </>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={loading}
          >
            Cancel
          </Button>
          <Button onClick={handleConfirm} disabled={loading} variant={isPrimary ? "default" : "secondary"}>
            {loading ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Swapping...
              </>
            ) : (
              `Confirm — Make ${isPrimary ? "Primary" : "Preview"}`
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

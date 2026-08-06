"use client";

import * as React from "react";
import dynamic from "next/dynamic";
import type { Scenario } from "@/lib/types";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";

const DiffEditor = dynamic(
  () => import("@/components/monaco").then((m) => m.DiffEditor),
  { ssr: false, loading: () => <div className="h-80 flex items-center justify-center text-muted-foreground text-sm">Loading editor...</div> }
);

interface ScenarioDiffDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  original: Scenario[];
  modified: Scenario[];
  onConfirm: () => void;
  saving: boolean;
}

export function ScenarioDiffDialog({
  open,
  onOpenChange,
  original,
  modified,
  onConfirm,
  saving,
}: ScenarioDiffDialogProps) {
  const originalStr = JSON.stringify(original, null, 2);
  const modifiedStr = JSON.stringify(modified, null, 2);

  return (
    <Dialog open={open} onOpenChange={saving ? undefined : onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle>Review Changes</DialogTitle>
          <DialogDescription>
            Left: current server state. Right: your proposed changes. Review
            before saving.
          </DialogDescription>
        </DialogHeader>

        {/* A definite height, and not a flex-grown one. `flex-1` sets
            flex-basis: 0%, which takes precedence over `height` for a flex
            item's main size, and DialogContent is a content-sized column
            (max-h only, no definite height) so there is no free space to grow
            into — the editor resolved to 844x0 and the dialog showed an empty
            box. Same shape as PromptEditor's container, which works. */}
        <div className="h-96 rounded border border-border overflow-hidden">
          <DiffEditor
            original={originalStr}
            modified={modifiedStr}
            language="json"
            theme="vs-dark"
            options={{
              readOnly: true,
              minimap: { enabled: false },
              fontSize: 12,
              scrollBeyondLastLine: false,
              renderSideBySide: true,
            }}
          />
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button onClick={onConfirm} disabled={saving}>
            {saving ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Saving...
              </>
            ) : (
              "Save Changes"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

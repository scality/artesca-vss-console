"use client";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";

interface DiagnosticOutputDrawerProps {
  open: boolean;
  label: string;
  result: "pass" | "fail" | null;
  output: string;
  onOpenChange: (open: boolean) => void;
}

export function DiagnosticOutputDrawer({
  open,
  label,
  result,
  output,
  onOpenChange,
}: DiagnosticOutputDrawerProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[80vh] flex flex-col">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <DialogTitle>{label}</DialogTitle>
            {result && (
              <Badge
                variant={result === "pass" ? "default" : "destructive"}
                className={result === "pass" ? "bg-green-600" : ""}
              >
                {result}
              </Badge>
            )}
          </div>
        </DialogHeader>
        <div className="flex-1 overflow-auto rounded-md border border-border bg-black/90 p-4">
          <pre className="text-xs font-mono text-green-400 whitespace-pre-wrap break-all">
            {output || "(no output)"}
          </pre>
        </div>
      </DialogContent>
    </Dialog>
  );
}

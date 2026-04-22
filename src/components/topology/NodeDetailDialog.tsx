"use client";

import { useEffect, useRef, useState } from "react";
import { useKiosk } from "@/components/KioskProvider";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/StatusBadge";
import type { ServiceNodeData } from "./ServiceNode";

interface NodeDetail {
  componentId: string;
  namespace: string;
  phase: string;
  restarts: number;
  age: string;
  logs: string[];
}

interface NodeDetailDialogProps {
  open: boolean;
  onClose: () => void;
  nodeData: ServiceNodeData | null;
  componentId: string;
}

export function NodeDetailDialog({
  open,
  onClose,
  nodeData,
  componentId,
}: NodeDetailDialogProps) {
  const { kiosk } = useKiosk();
  const [detail, setDetail] = useState<NodeDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!open || !componentId) return;

    // eslint-disable-next-line react-hooks/set-state-in-effect -- resetting loading/detail state when dialog opens for new component
    setLoading(true);
    setDetail(null);

    // Fetch pod detail
    fetch(`/api/status/pods`)
      .then((r) => r.ok ? r.json() : [])
      .then((pods: Array<{ name: string; namespace: string; phase: string; restarts: number; age: string }>) => {
        const match = pods.find(
          (p: { name: string }) =>
            p.name.includes(componentId) || componentId.includes(p.name)
        );
        if (match) {
          setDetail({
            componentId,
            namespace: match.namespace,
            phase: match.phase,
            restarts: match.restarts,
            age: match.age,
            logs: [],
          });
        } else {
          setDetail({
            componentId,
            namespace: nodeData?.namespace ?? "unknown",
            phase: "Unknown",
            restarts: 0,
            age: "?",
            logs: [],
          });
        }
      })
      .catch(() => {
        setDetail({
          componentId,
          namespace: nodeData?.namespace ?? "unknown",
          phase: "Unknown",
          restarts: 0,
          age: "?",
          logs: [],
        });
      })
      .finally(() => setLoading(false));

    // Fetch last 20 log lines via SSE, close after 3 s
    const ns = nodeData?.namespace ?? "vss";
    const abort = new AbortController();
    abortRef.current = abort;
    const timeout = setTimeout(() => abort.abort(), 3000);

    fetch(`/api/logs/${encodeURIComponent(ns)}/${encodeURIComponent(componentId)}/main`, {
      signal: abort.signal,
    })
      .then((r) => r.ok ? r.text() : "")
      .then((text) => {
        if (!text) return;
        const lines = text.split("\n").filter(Boolean).slice(-20);
        setDetail((prev) =>
          prev ? { ...prev, logs: lines } : prev
        );
      })
      .catch(() => { /* SSE abort is normal */ })
      .finally(() => clearTimeout(timeout));

    return () => {
      abort.abort();
      clearTimeout(timeout);
    };
  }, [open, componentId, nodeData?.namespace]);

  async function handleRolloutRestart() {
    if (kiosk || !componentId) return;
    setRestarting(true);
    try {
      await fetch(`/api/restart/${encodeURIComponent(componentId)}`, {
        method: "POST",
      });
    } finally {
      setRestarting(false);
    }
  }

  const health = nodeData?.health ?? "unknown";

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <StatusBadge health={health} />
            <span className="font-mono">{componentId}</span>
          </DialogTitle>
          <DialogDescription>
            {nodeData?.namespace && (
              <span className="font-mono text-xs">ns: {nodeData.namespace}</span>
            )}
          </DialogDescription>
        </DialogHeader>

        {loading && (
          <p className="text-sm text-muted-foreground animate-pulse">
            Loading...
          </p>
        )}

        {detail && (
          <div className="space-y-4">
            {/* Pod metadata */}
            <div className="grid grid-cols-3 gap-3 text-sm">
              <div>
                <p className="text-xs text-muted-foreground">Phase</p>
                <p className="font-medium">{detail.phase}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Restarts</p>
                <p className={`font-medium ${detail.restarts > 5 ? "text-yellow-400" : ""}`}>
                  {detail.restarts}
                </p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Age</p>
                <p className="font-medium">{detail.age}</p>
              </div>
            </div>

            {/* Log lines */}
            {detail.logs.length > 0 && (
              <div>
                <p className="text-xs text-muted-foreground mb-1.5">
                  Last {detail.logs.length} log lines
                </p>
                <pre className="rounded bg-muted p-3 text-xs font-mono overflow-x-auto max-h-48 overflow-y-auto leading-relaxed">
                  {detail.logs.join("\n")}
                </pre>
              </div>
            )}

            {detail.logs.length === 0 && !loading && (
              <p className="text-xs text-muted-foreground">
                No recent logs available.
              </p>
            )}

            {/* Actions */}
            <div className="flex gap-2 pt-2">
              <Button
                variant="outline"
                size="sm"
                asChild
              >
                <a
                  href={`/logs?ns=${encodeURIComponent(detail.namespace)}&pod=${encodeURIComponent(componentId)}`}
                >
                  View Full Logs
                </a>
              </Button>

              {!kiosk && (
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={restarting}
                  onClick={handleRolloutRestart}
                >
                  {restarting ? "Restarting…" : "Rollout Restart"}
                </Button>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

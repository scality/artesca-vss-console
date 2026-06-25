"use client";

import { memo } from "react";
import { Handle, Position } from "@xyflow/react";
import type { NodeProps } from "@xyflow/react";
import type { Health } from "@/lib/types";

export interface ServiceNodeData {
  label: string;
  health: Health;
  namespace?: string;
  podCount?: number;
  restarts?: number;
  [key: string]: unknown;
}

// Health ring colour only — ring WIDTH is applied conditionally below so that
// the selection ring (ring-2) deterministically wins over the health ring (ring-1).
// Stacking both widths on the same element leaves the winner to stylesheet ordering,
// which is non-deterministic and was swallowing the selection indicator.
const HEALTH_RING: Record<Health, string> = {
  ok: "ring-emerald-500 bg-emerald-50",
  warn: "ring-amber-500 bg-amber-50",
  fail: "ring-red-500 bg-red-50",
  unknown: "ring-border bg-muted/30",
};

const HEALTH_DOT: Record<Health, string> = {
  ok: "bg-emerald-600",
  warn: "bg-amber-500",
  fail: "bg-red-600",
  unknown: "bg-muted-foreground",
};

export const ServiceNode = memo(function ServiceNode({
  data,
  selected,
}: NodeProps) {
  const nodeData = data as ServiceNodeData;
  const { label, health, namespace, podCount, restarts } = nodeData;

  return (
    <div
      className={[
        "rounded-lg border px-3 py-2 min-w-[120px] cursor-pointer",
        "bg-card border-border text-foreground shadow-md transition-all",
        HEALTH_RING[health],
        selected
          ? "ring-2 ring-primary ring-offset-2 ring-offset-background"
          : "ring-1",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <Handle type="target" position={Position.Left} className="!bg-border" />

      <div className="flex items-center gap-2">
        <span
          className={`h-2 w-2 rounded-full shrink-0 ${HEALTH_DOT[health]}`}
        />
        <span className="text-xs font-semibold truncate max-w-[120px]">
          {label}
        </span>
      </div>

      {namespace && (
        <p className="mt-0.5 text-[10px] text-muted-foreground font-mono truncate">
          {namespace}
        </p>
      )}

      {(podCount !== undefined || restarts !== undefined) && (
        <div className="mt-1 flex gap-2 text-[10px] text-muted-foreground">
          {podCount !== undefined && <span>{podCount} pod{podCount !== 1 ? "s" : ""}</span>}
          {restarts !== undefined && restarts > 0 && (
            <span className="text-amber-700">r:{restarts}</span>
          )}
        </div>
      )}

      <Handle type="source" position={Position.Right} className="!bg-border" />
    </div>
  );
});

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

const HEALTH_RING: Record<Health, string> = {
  ok: "ring-green-500 bg-green-500/10",
  warn: "ring-yellow-500 bg-yellow-500/10",
  fail: "ring-red-500 bg-red-500/10",
  unknown: "ring-border bg-muted/30",
};

const HEALTH_DOT: Record<Health, string> = {
  ok: "bg-green-500",
  warn: "bg-yellow-500",
  fail: "bg-red-500",
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
      className={`
        rounded-lg border ring-1 px-3 py-2 min-w-[120px] cursor-pointer
        bg-card border-border text-foreground shadow-md
        ${HEALTH_RING[health]}
        ${selected ? "ring-2 ring-primary" : ""}
        transition-all
      `}
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
            <span className="text-yellow-400">r:{restarts}</span>
          )}
        </div>
      )}

      <Handle type="source" position={Position.Right} className="!bg-border" />
    </div>
  );
});

"use client";

import { memo } from "react";
import { BaseEdge, getStraightPath, EdgeLabelRenderer } from "@xyflow/react";
import type { EdgeProps } from "@xyflow/react";

export type EdgeProtocol = "RTSP" | "gRPC" | "Kafka" | "HTTP" | string;

export interface ConnectionEdgeData {
  protocol: EdgeProtocol;
  label?: string;
  [key: string]: unknown;
}

const PROTOCOL_COLOR: Record<string, string> = {
  RTSP: "#22c55e",    // green
  gRPC: "#a78bfa",   // violet
  Kafka: "#f59e0b",  // amber
  HTTP: "#60a5fa",   // blue
};

function protocolColor(protocol: string): string {
  return PROTOCOL_COLOR[protocol] ?? "#6b7280";
}

export const ConnectionEdge = memo(function ConnectionEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  data,
}: EdgeProps) {
  const edgeData = data as ConnectionEdgeData | undefined;
  const protocol = edgeData?.protocol ?? "HTTP";
  const label = edgeData?.label ?? protocol;
  const color = protocolColor(protocol);

  const [edgePath, labelX, labelY] = getStraightPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
  });

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        style={{ stroke: color, strokeWidth: 1.5, opacity: 0.8 }}
        markerEnd={`url(#arrow-${protocol})`}
      />
      <EdgeLabelRenderer>
        <div
          style={{
            position: "absolute",
            transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
            pointerEvents: "all",
          }}
          className="nodrag nopan"
        >
          <span
            className="rounded px-1 py-0.5 text-[10px] font-medium"
            style={{
              backgroundColor: `${color}22`,
              color,
              border: `1px solid ${color}44`,
            }}
          >
            {label}
          </span>
        </div>
      </EdgeLabelRenderer>
    </>
  );
});

"use client";

import { memo } from "react";
import { BaseEdge, getStraightPath, EdgeLabelRenderer } from "@xyflow/react";
import type { EdgeProps } from "@xyflow/react";
import type { EdgeRuntimeState } from "@/lib/types/pipeline";

export type EdgeProtocol = "RTSP" | "gRPC" | "Kafka" | "HTTP" | string;

export interface ConnectionEdgeData {
  protocol: EdgeProtocol;
  label?: string;
  runtime?: EdgeRuntimeState;
  [key: string]: unknown;
}

// ─── Static protocol palette (fallback when no runtime state) ────────────────

const PROTOCOL_COLOR: Record<string, string> = {
  RTSP: "#22c55e",   // green
  gRPC: "#a78bfa",  // violet
  Kafka: "#f59e0b", // amber
  HTTP: "#60a5fa",  // blue
};

function protocolColor(protocol: string): string {
  return PROTOCOL_COLOR[protocol] ?? "#6b7280";
}

// ─── Runtime health → visual properties ──────────────────────────────────────

type EdgeHealth = EdgeRuntimeState["health"];

const HEALTH_STROKE: Record<EdgeHealth, string> = {
  flowing: "hsl(217 91% 60%)",                        // --primary
  idle:    "hsl(215 20% 65% / 0.4)",                  // --muted-foreground at 40%
  error:   "hsl(0 63% 31%)",                          // --destructive
  unknown: "hsl(215 20% 65% / 0.15)",
};

const HEALTH_DASH: Record<EdgeHealth, string | undefined> = {
  flowing: "6 4",
  idle:    undefined,
  error:   undefined,
  unknown: undefined,
};

// CSS keyframes for the flowing animation — injected once via a <style> tag.
// No CSS module support needed; this matches globals.css convention (plain CSS).
const EDGE_FLOW_STYLE = `
@keyframes edge-flow {
  to { stroke-dashoffset: -20; }
}
.edge-flowing {
  animation: edge-flow 0.8s linear infinite;
}
`;

// ─── Component ────────────────────────────────────────────────────────────────

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
  const staticLabel = edgeData?.label ?? protocol;
  const runtime: EdgeRuntimeState | undefined = edgeData?.runtime;

  const health: EdgeHealth = runtime?.health ?? "unknown";
  const strokeColor = runtime ? HEALTH_STROKE[health] : protocolColor(protocol);
  const dashArray = HEALTH_DASH[health];
  const isFlowing = health === "flowing";

  // Label: prefer runtime pre-formatted label, then static edge label.
  const displayLabel = (runtime?.label && runtime.label.length > 0)
    ? runtime.label
    : staticLabel;

  const [edgePath, labelX, labelY] = getStraightPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
  });

  return (
    <>
      {/* Inject keyframes once — React deduplicates identical <style> nodes */}
      <style>{EDGE_FLOW_STYLE}</style>

      <BaseEdge
        id={id}
        path={edgePath}
        style={{
          stroke: strokeColor,
          strokeWidth: isFlowing ? 2 : 1.5,
          opacity: health === "unknown" ? 0.4 : 0.9,
          strokeDasharray: dashArray,
        }}
        className={isFlowing ? "edge-flowing" : undefined}
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
            title={runtime?.errorHint}
            className="rounded px-1.5 py-0.5 text-[9px] font-medium leading-tight"
            style={{
              backgroundColor: `${strokeColor}22`,
              color: health === "error"
                ? "hsl(0 84% 70%)"
                : health === "flowing"
                  ? "hsl(217 91% 75%)"
                  : "hsl(215 20% 65%)",
              border: `1px solid ${strokeColor}55`,
              cursor: runtime?.errorHint ? "help" : "default",
              display: "inline-flex",
              alignItems: "center",
              gap: "3px",
            }}
          >
            {health === "error" && (
              <span style={{ color: "hsl(0 84% 70%)", fontSize: "9px" }}>⚠</span>
            )}
            {displayLabel}
          </span>
        </div>
      </EdgeLabelRenderer>
    </>
  );
});

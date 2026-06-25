"use client";

import { memo } from "react";
import { BaseEdge, getSmoothStepPath, EdgeLabelRenderer } from "@xyflow/react";
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

// Tuned for the light canvas: solid mid-tones stay visible on #f7f8fa.
// The old light-on-dark strokes — especially the near-transparent `unknown` —
// vanished on white, which is the common state when the cluster is degraded.
const HEALTH_STROKE: Record<EdgeHealth, string> = {
  flowing: "hsl(var(--primary))",   // brand teal — strong on white
  idle:    "hsl(215 16% 58%)",      // solid slate
  error:   "hsl(0 72% 45%)",        // red — clearly visible on white
  unknown: "hsl(214 16% 74%)",      // light slate — subtle but present
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
  const isFlowing = health === "flowing";

  // A feedback edge flows right-to-left in the pipeline (source node sits to the
  // right of the target). Apply a dashed stroke + reduced opacity to read as a
  // control/return path rather than a mis-wired forward input.
  // The 8 px threshold avoids false-positives on roughly co-located nodes.
  const isFeedback = sourceX > targetX + 8;
  const dashArray = isFeedback && !isFlowing ? "5 4" : HEALTH_DASH[health];
  const edgeOpacity = isFeedback && !isFlowing
    ? 0.55
    : health === "unknown" ? 0.75 : 0.9;

  // Label: prefer runtime pre-formatted label, then static edge label.
  const displayLabel = (runtime?.label && runtime.label.length > 0)
    ? runtime.label
    : staticLabel;

  const [edgePath, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    borderRadius: 8,
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
          opacity: edgeOpacity,
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
            className="rounded border border-border bg-background px-1.5 py-0.5 text-xs font-medium leading-tight"
            style={{
              color: health === "error"
                ? "hsl(var(--destructive))"
                : health === "flowing"
                  ? "hsl(var(--primary))"
                  : "hsl(var(--foreground))",
              cursor: runtime?.errorHint ? "help" : "default",
              display: "inline-flex",
              alignItems: "center",
              gap: "3px",
            }}
          >
            {health === "error" && (
              <span style={{ color: "hsl(var(--destructive))", fontSize: "9px" }}>⚠</span>
            )}
            {displayLabel}
          </span>
        </div>
      </EdgeLabelRenderer>
    </>
  );
});

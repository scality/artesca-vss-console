"use client";

import { memo } from "react";
import { Handle, Position } from "@xyflow/react";
import type { NodeProps } from "@xyflow/react";
import { Video } from "lucide-react";
import type { NodeRuntimeState } from "@/lib/types/pipeline";

export interface FeedNodeData {
  label: string;
  sensorId?: string;  // optional so Agent 2's mergeTopologyData doesn't need to populate it
  runtime?: NodeRuntimeState;
  [key: string]: unknown;
}

// ─── Health dot ───────────────────────────────────────────────────────────────

type DotVariant = "green" | "yellow" | "red" | "grey";

/** Derive dot colour from NodeRuntimeState for a feed node.
 *
 * Rules:
 *   green  — flowing: feed registered in VST, frame arrived < 5 s ago
 *   yellow — registered but no frames yet, or last frame 5–30 s ago (stale)
 *   red    — registration failure (vstRegistered === false) or health=fail
 *   grey   — no runtime data or health=unknown
 */
function feedDotVariant(runtime: NodeRuntimeState | undefined): DotVariant {
  if (!runtime) return "grey";
  const { health, feed } = runtime;
  if (health === "fail") return "red";
  if (health === "unknown") return "grey";

  if (!feed) return health === "ok" ? "green" : "yellow";

  if (!feed.vstRegistered) return "red";

  if (feed.lastFrameAgoMs != null) {
    if (feed.lastFrameAgoMs < 5_000) return "green";   // fresh
    if (feed.lastFrameAgoMs < 30_000) return "yellow"; // stale (5–30 s)
    return "red";                                       // very stale (> 30 s)
  }

  // Registered but no frame timestamp yet
  return "yellow";
}

const DOT_CLASS: Record<DotVariant, string> = {
  green:  "bg-green-400",
  yellow: "bg-yellow-400",
  red:    "bg-red-400",
  grey:   "bg-muted-foreground",
};

// ─── Component ────────────────────────────────────────────────────────────────

export const FeedNode = memo(function FeedNode({ data, selected }: NodeProps) {
  const nodeData = data as FeedNodeData;
  const { label, sensorId, runtime } = nodeData;

  const feed = runtime?.feed;
  const dotVariant = feedDotVariant(runtime);

  // Sub-label: bitrate + codec, e.g. "4.2 Mbps · H265"
  let subLabel: string | null = null;
  if (feed) {
    const parts: string[] = [];
    if (feed.bitrateMbps != null) parts.push(`${feed.bitrateMbps.toFixed(2)} Mbps`);
    if (feed.codec && feed.codec !== "unknown") parts.push(feed.codec.toUpperCase());
    if (parts.length > 0) subLabel = parts.join(" · ");
  }

  // Full sensor ID as tooltip — CSS handles overflow truncation.
  const titleHint = sensorId ?? label;

  return (
    <div
      title={titleHint}
      className={[
        "flex flex-col justify-center rounded border px-2 py-1 cursor-pointer",
        "bg-card border-border shadow-sm transition-all",
        selected ? "ring-1 ring-primary" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      style={{ width: "160px", height: "40px" }}
    >
      <Handle type="target" position={Position.Left} className="!bg-border" />

      {/* Main row: icon + dot + label */}
      <div className="flex items-center gap-1.5">
        <Video className="h-3 w-3 shrink-0 text-muted-foreground" />
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${DOT_CLASS[dotVariant]}`} />
        <span className="text-[10px] font-semibold font-mono leading-tight truncate">
          {label}
        </span>
      </div>

      {/* Sub-label: bitrate · codec */}
      {subLabel && (
        <p className="mt-0.5 text-[9px] text-muted-foreground font-mono leading-tight truncate pl-[18px]">
          {subLabel}
        </p>
      )}

      <Handle type="source" position={Position.Right} className="!bg-border" />
    </div>
  );
});

// src/components/topology/node-content/feeds.ts
// Feed node detail-panel content (status tab renderer).
//
// ── Dynamic feed ID problem ────────────────────────────────────────────────────
// Feed node IDs take the form "feed:<sensor_id>" where sensor_id is only known
// at runtime.  mergeContent() iterates Object.entries(), so a Proxy with an
// empty ownKeys() handler silently produces no entries.
//
// Solution: export a named getFeedContent(nodeId) helper.  The NodeDetailPanel
// (Agent 2) should call:
//
//   const content = NODE_CONTENT[nodeId] ?? getFeedContent(nodeId);
//
// FEED_CONTENT remains an empty map for mergeContent compat; the Proxy fallback
// is only used when the merged map has no entry for a "feed:*" node.
// ─────────────────────────────────────────────────────────────────────────────

import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import type { NodeContent, NodeContentMap } from "../registry";
import type { TabRendererProps } from "../registry";

function FeedStatusRenderer({ runtimeState }: TabRendererProps) {
  const feed = runtimeState?.feed;

  if (!feed) {
    return _jsx("p", {
      className: "text-sm text-muted-foreground",
      children: "No live data yet.",
    });
  }

  const gopStr =
    feed.gop != null && feed.fps != null
      ? `${feed.gop} (${(feed.gop / feed.fps).toFixed(1)} s keyframe)`
      : feed.gop != null
        ? String(feed.gop)
        : "—";

  const rows: Array<[string, string]> = [
    ["Name", feed.name ?? "—"],
    ["Sensor ID", feed.sensorId],
    ["State", feed.state ?? "—"],
    ["Registered in VST", feed.vstRegistered ? "Yes" : "No"],
    [
      "Bitrate",
      feed.bitrateMbps != null ? `${feed.bitrateMbps.toFixed(2)} Mbps` : "—",
    ],
    ["Codec", feed.codec.toUpperCase()],
    [
      "Resolution",
      feed.resolution
        ? `${feed.resolution.width}×${feed.resolution.height}`
        : "—",
    ],
    ["FPS", feed.fps != null ? String(feed.fps) : "—"],
    ["GOP", gopStr],
    [
      "Last frame",
      feed.lastFrameAgoMs != null
        ? `${(feed.lastFrameAgoMs / 1000).toFixed(1)} s ago`
        : "—",
    ],
  ];

  return _jsx("dl", {
    className: "grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm",
    children: rows.flatMap(([dt, dd]) => [
      _jsx("dt", { className: "text-muted-foreground", children: dt }, `dt-${dt}`),
      _jsx("dd", { className: "font-mono", children: dd }, `dd-${dt}`),
    ]),
  });
}

const feedContent: NodeContent = {
  status: FeedStatusRenderer,
};

/**
 * Look up NodeContent for a feed node by id.
 * Returns the shared feedContent object for any id starting with "feed:".
 * Returns undefined for other ids.
 */
export function getFeedContent(nodeId: string): NodeContent | undefined {
  if (typeof nodeId === "string" && nodeId.startsWith("feed:")) return feedContent;
  return undefined;
}

/**
 * FEED_CONTENT is intentionally empty so mergeContent() does not choke.
 * The NodeDetailPanel must call getFeedContent(nodeId) as a fallback:
 *
 *   const content = NODE_CONTENT[nodeId] ?? getFeedContent(nodeId);
 */
export const FEED_CONTENT: NodeContentMap = {};

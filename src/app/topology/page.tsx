"use client";

import { useCallback, useEffect, useRef, useState, type ComponentType } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
  type NodeTypes,
  type EdgeTypes,
  type NodeMouseHandler,
  type NodeChange,
  type NodeProps,
  type ReactFlowInstance,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import { Shell } from "@/components/Shell";
import { ServiceNode, type ServiceNodeData } from "@/components/topology/ServiceNode";
import { StorageNode } from "@/components/topology/nodes/StorageNode";
import { FeedNode } from "@/components/topology/nodes/FeedNode";
import { ConnectionEdge } from "@/components/topology/ConnectionEdge";
import { NodeDetailPanel } from "@/components/topology/NodeDetailPanel";
import { NODE_CONTENT } from "@/components/topology/node-content";
import { getFeedContent } from "@/components/topology/node-content/feeds";
import { getFeedActionsContent } from "@/components/topology/node-content/actions";
import { clearNodeSparklines } from "@/components/topology/node-content/compute";
import type { NodeType, PipelineHealth, PipelineSnapshot, NodeRuntimeState } from "@/lib/types/pipeline";

// ─────────────────────────────────────────────────────────────────────────────
// Topology node data — superset of all node-type-specific shapes
// ─────────────────────────────────────────────────────────────────────────────

interface TopologyNodeData {
  label: string;
  health: PipelineHealth;
  namespace?: string;
  nodeType?: NodeType;
  // ServiceNode fields
  podCount?: number;
  restarts?: number;
  // StorageNode fields (Agent 4 shape)
  subtype?: "s3" | "cache" | "postgres" | "redis";
  runtime?: NodeRuntimeState;
  // FeedNode fields (Agent 3 shape)
  sensorId?: string;
  // Handle visibility: true = show, false = hide. undefined = show (safe default).
  hasIncoming?: boolean;
  hasOutgoing?: boolean;
  /** Flow direction for this node's pipeline row: "lr" = left-to-right (even rows),
   *  "rl" = right-to-left (odd rows in the serpentine layout). Controls handle sides. */
  flowDir?: "lr" | "rl";
  // Index signature required by React Flow NodeData constraint
  [key: string]: unknown;
}

// ─────────────────────────────────────────────────────────────────────────────
// Graph is built entirely from the /api/topology response — no static layout.
// Initial state is empty until the first payload lands (~300 ms typical).
// ─────────────────────────────────────────────────────────────────────────────

const BASE_NODES: Node<TopologyNodeData>[] = [];
const BASE_EDGES: Edge[] = [];

function deriveSubtype(nodeType: NodeType | undefined, nodeId: string): TopologyNodeData["subtype"] {
  if (nodeType === "storage") return nodeId.includes("cache") ? "cache" : "s3";
  if (nodeType === "database") return "postgres";
  if (nodeType === "redis") return "redis";
  return undefined;
}

function reactFlowTypeFor(nodeType: NodeType | undefined): "service" | "storage" | "feed" {
  if (nodeType === "feed") return "feed";
  if (nodeType === "storage" || nodeType === "database" || nodeType === "redis") return "storage";
  return "service";
}

const NODE_TYPES: Record<string, ComponentType<NodeProps>> = {
  service: ServiceNode as ComponentType<NodeProps>,
  storage: StorageNode as ComponentType<NodeProps>,
  feed: FeedNode as ComponentType<NodeProps>,
};

const EDGE_TYPES: EdgeTypes = { connection: ConnectionEdge };

// ─────────────────────────────────────────────────────────────────────────────
// Topology API shape
// ─────────────────────────────────────────────────────────────────────────────

interface TopologyApiNode {
  id: string;
  label?: string;
  health?: PipelineHealth;
  namespace?: string;
  podCount?: number;
  restarts?: number;
  type?: NodeType;
  // Feed-specific fields emitted by Agent 1
  sensorId?: string;
  position?: { x: number; y: number };
}

interface TopologyApiEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
  protocol?: string;
  dormant?: boolean;
}

interface TopologyPayload {
  nodes?: TopologyApiNode[];
  edges?: TopologyApiEdge[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Stage-index map — stable, authored-position-based
// ─────────────────────────────────────────────────────────────────────────────
//
// stageIndexById maps each node id to a dense 0-based flow-order stage index
// derived from the API payload's authored x positions (NOT the possibly
// user-dragged current position). This is computed once from the payload so
// the serpentine layout and feedback-edge detection are both drag-proof.

const STAGE_W = 200; // authored-x span that collapses into one pipeline stage

function buildStageIndexById(payload: TopologyPayload | null): Record<string, number> {
  const apiNodes = payload?.nodes ?? [];
  if (apiNodes.length === 0) return {};

  // Use authored position.x from the API payload (fallback idx*180 for missing pos).
  const minX = Math.min(...apiNodes.map((n, idx) => n.position?.x ?? idx * 180));
  const stageOf = (n: TopologyApiNode, idx: number) =>
    Math.round(((n.position?.x ?? idx * 180) - minX) / STAGE_W);

  // Collect distinct stage buckets, sort ascending (= flow order), assign dense index.
  const buckets = [...new Set(apiNodes.map((n, idx) => stageOf(n, idx)))].sort((a, b) => a - b);
  const bucketToIndex = new Map(buckets.map((b, i) => [b, i]));

  const result: Record<string, number> = {};
  apiNodes.forEach((n, idx) => {
    result[n.id] = bucketToIndex.get(stageOf(n, idx)) ?? 0;
  });
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Merge helpers
// ─────────────────────────────────────────────────────────────────────────────

function mergeTopologyData(
  payload: TopologyPayload | null,
  snapshot: PipelineSnapshot | null,
  savedPositions: Record<string, { x: number; y: number }>,
  edges: TopologyApiEdge[],
  stageIndexById: Record<string, number>,
  stagesPerRow: number,
): Node<TopologyNodeData>[] {
  const apiNodes = payload?.nodes ?? [];

  // Compute handle visibility from the edge list.
  const hasIncomingSet = new Set(edges.map((e) => e.target));
  const hasOutgoingSet = new Set(edges.map((e) => e.source));

  return apiNodes.map((n, idx) => {
    const runtimeState = snapshot?.nodes[n.id];
    const health: PipelineHealth = runtimeState?.health ?? n.health ?? "unknown";
    const rfType = reactFlowTypeFor(n.type);
    const apiPos = n.position ?? { x: idx * 180, y: 200 };

    // flowDir: even rows flow left-to-right, odd rows flow right-to-left (serpentine).
    const stageIdx = stageIndexById[n.id] ?? 0;
    const rowNum = Math.floor(stageIdx / stagesPerRow);
    const flowDir: "lr" | "rl" = rowNum % 2 === 0 ? "lr" : "rl";

    return {
      id: n.id,
      position: savedPositions[n.id] ?? apiPos,
      type: rfType,
      data: {
        label: n.label ?? n.sensorId ?? n.id,
        health,
        namespace: n.namespace,
        nodeType: n.type,
        subtype: deriveSubtype(n.type, n.id),
        podCount: n.podCount,
        restarts: n.restarts,
        sensorId: n.sensorId,
        runtime: runtimeState,
        hasIncoming: hasIncomingSet.has(n.id),
        hasOutgoing: hasOutgoingSet.has(n.id),
        flowDir,
      },
    };
  });
}

function mergeTopologyEdges(
  payload: TopologyPayload | null,
  snapshot: PipelineSnapshot | null,
  stageIndexById: Record<string, number>,
): Edge[] {
  const apiEdges = payload?.edges ?? [];
  return apiEdges.map((e) => {
    // An edge is feedback iff its target is at a strictly earlier pipeline stage
    // than its source. Same-stage edges (e.g. sensor→streamprocessing) are NOT
    // feedback — they are co-located services on the same column.
    const srcStage = stageIndexById[e.source] ?? 0;
    const tgtStage = stageIndexById[e.target] ?? 0;
    const feedback = tgtStage < srcStage;
    return {
      id: e.id,
      source: e.source,
      target: e.target,
      type: "connection",
      data: {
        protocol: e.protocol,
        staticLabel: e.label,
        dormant: e.dormant,
        runtime: snapshot?.edges[e.id],
        feedback,
      },
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Adaptive serpentine layout
// ─────────────────────────────────────────────────────────────────────────────
//
// The pipeline stages are arranged in a multi-row "snake" pattern so that the
// bounding box is close to 4:3. For a 7-stage pipeline this picks 2 rows
// (4 stages top-left→right, 3 stages bottom-right→left). For longer pipelines
// the formula auto-promotes to 3 rows.
//
// Row direction (flowDir):
//   even rows (0, 2, …) — left to right  ("lr")
//   odd rows  (1, 3, …) — right to left  ("rl", reversed position within row)
//
// The serpentine connects rows: the last stage of row N is adjacent (vertically)
// to the first stage of row N+1, so edges naturally wrap around the corner.
//
// A user's manual drag (savedPositions) always wins; "Reset layout" clears
// those and the graph snaps back to this computed layout.

const COL_GAP  = 260; // horizontal spacing between pipeline stages
const ROW_GAP  = 168; // vertical spacing within a stage (node cards run ~90px tall)
const BAND_GAP = 430; // vertical spacing between serpentine rows
const ORIGIN_X = 40;
const ORIGIN_Y = 120;

/** Choose the number of rows that minimises |width/height − 4/3|. */
function chooseSerpentineRows(numStages: number): number {
  if (numStages <= 1) return 1;
  let bestRows = 1;
  let bestDiff = Infinity;
  for (const rows of [1, 2, 3]) {
    const spr = Math.ceil(numStages / rows); // stages per row
    const width = (spr - 1) * COL_GAP;
    const height = (rows - 1) * BAND_GAP;   // rough (ignores node stack height)
    if (height === 0 && rows === 1) {
      // Single row: width/height → ∞; only pick if no better option exists.
      const diff = Math.abs(width / 200 - 4 / 3); // 200 px reference height
      if (diff < bestDiff) { bestDiff = diff; bestRows = rows; }
    } else if (height > 0) {
      const diff = Math.abs(width / height - 4 / 3);
      if (diff < bestDiff) { bestDiff = diff; bestRows = rows; }
    }
  }
  return bestRows;
}

function applyFlowLayout(
  nodes: Node<TopologyNodeData>[],
  savedPositions: Record<string, { x: number; y: number }>,
  stageIndexById: Record<string, number>,
): { nodes: Node<TopologyNodeData>[]; stagesPerRow: number } {
  if (nodes.length === 0) return { nodes, stagesPerRow: 1 };

  // Determine the total number of distinct flow stages.
  const allStageIndices = nodes.map((n) => stageIndexById[n.id] ?? 0);
  const numStages = Math.max(...allStageIndices) + 1;

  const ROWS = chooseSerpentineRows(numStages);
  const stagesPerRow = Math.ceil(numStages / ROWS);

  // Lay out only the nodes the user hasn't manually placed.
  const auto = nodes.filter((n) => !savedPositions[n.id]);
  if (auto.length === 0) return { nodes, stagesPerRow };

  // Bucket nodes by their flow-order stage index.
  const byStage = new Map<number, Node<TopologyNodeData>[]>();
  for (const n of auto) {
    const si = stageIndexById[n.id] ?? 0;
    const list = byStage.get(si) ?? [];
    list.push(n);
    byStage.set(si, list);
  }

  const placed: Record<string, { x: number; y: number }> = {};
  for (const [stageIdx, list] of byStage) {
    const row = Math.floor(stageIdx / stagesPerRow);
    let pos = stageIdx % stagesPerRow;

    // Serpentine: odd rows run right → left (reverse position within the row).
    if (row % 2 !== 0) pos = stagesPerRow - 1 - pos;

    const colX = ORIGIN_X + pos * COL_GAP;
    const bandCenterY = ORIGIN_Y + row * BAND_GAP;

    // Stack nodes in this stage vertically around the band centre, ordered by
    // authored y (preserves relative vertical positioning from the API payload).
    list.sort((a, b) => (a.position.y ?? 0) - (b.position.y ?? 0));
    list.forEach((node, i) => {
      placed[node.id] = {
        x: colX,
        y: bandCenterY + (i - (list.length - 1) / 2) * ROW_GAP,
      };
    });
  }

  return {
    nodes: nodes.map((n) =>
      savedPositions[n.id] ? n : { ...n, position: placed[n.id] ?? n.position },
    ),
    stagesPerRow,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// React import (needed for NODE_TYPES cast)
// ─────────────────────────────────────────────────────────────────────────────

import React from "react";
import Link from "next/link";
import { Loader2, AlertTriangle, LayoutGrid } from "lucide-react";

const POSITIONS_LS_KEY = "topology:node-positions:v1";

function readSavedPositions(): Record<string, { x: number; y: number }> {
  if (typeof window === "undefined") return {};
  try {
    return JSON.parse(localStorage.getItem(POSITIONS_LS_KEY) ?? "{}");
  } catch {
    return {};
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Page
// ─────────────────────────────────────────────────────────────────────────────

export default function TopologyPage() {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<TopologyNodeData>>(BASE_NODES);
  const [edges, setEdges, onEdgesChange] = useEdgesState(BASE_EDGES);

  // Persist user-dragged positions in localStorage so they survive polls + reloads.
  // Initialized synchronously at mount so the ref is populated before any poll fires.
  const savedPositionsRef = useRef<Record<string, { x: number; y: number }>>(readSavedPositions());

  // React Flow instance — captured on init so we can re-frame the graph when the
  // node set changes (keeps the whole pipeline in view, no horizontal panning).
  const rfRef = useRef<ReactFlowInstance<Node<TopologyNodeData>, Edge> | null>(null);

  const handleNodesChange = useCallback((changes: NodeChange<Node<TopologyNodeData>>[]) => {
    onNodesChange(changes);
    for (const c of changes) {
      if (c.type === "position" && c.dragging === false && c.position) {
        savedPositionsRef.current = { ...savedPositionsRef.current, [c.id]: c.position };
        try { localStorage.setItem(POSITIONS_LS_KEY, JSON.stringify(savedPositionsRef.current)); } catch {}
      }
    }
  }, [onNodesChange]);

  const resetLayout = useCallback(() => {
    savedPositionsRef.current = {};
    try { localStorage.removeItem(POSITIONS_LS_KEY); } catch {}
  }, []);

  // Selected node for the detail panel
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  // Live pipeline snapshot — populated via SSE; falls back to polling.
  const [snapshot, setSnapshot] = useState<PipelineSnapshot | null>(null);
  const [sseFailed, setSseFailed] = useState(false);

  // ── SSE subscription with exponential back-off reconnect ─────────────────
  useEffect(() => {
    let es: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    let disposed = false;
    const MAX_ATTEMPTS = 5;
    const MAX_BACKOFF_MS = 30_000;

    function scheduleReconnect() {
      if (disposed) return;
      if (attempt >= MAX_ATTEMPTS) {
        setSseFailed(true);
        return;
      }
      const backoff = Math.min(1_000 * 2 ** attempt, MAX_BACKOFF_MS);
      attempt += 1;
      reconnectTimer = setTimeout(connect, backoff);
    }

    function connect() {
      if (disposed) return;
      es = new EventSource("/api/pipeline/live");

      es.addEventListener("snapshot", (evt: MessageEvent<string>) => {
        try {
          const parsed: PipelineSnapshot = JSON.parse(evt.data);
          setSnapshot(parsed);
          setSseFailed(false);
          attempt = 0; // healthy tick → reset back-off
        } catch {
          // malformed event — ignore
        }
      });

      es.onerror = () => {
        es?.close();
        es = null;
        scheduleReconnect();
      };
    }

    connect();
    return () => {
      disposed = true;
      if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
      es?.close();
    };
  }, []);

  // ── Polling fallback (/api/pipeline/snapshot every 5 s when SSE dead) ─────
  useQuery<PipelineSnapshot>({
    queryKey: ["pipeline-snapshot"],
    queryFn: async () => {
      const res = await fetch("/api/pipeline/snapshot");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: PipelineSnapshot = await res.json();
      setSnapshot(data);
      return data;
    },
    refetchInterval: 5_000,
    staleTime: 0,
    enabled: sseFailed,
  });

  // ── Topology structure (nodes + edges) — poll every 3 s ──────────────────
  const { data: topologyPayload, isError: topologyError, isFetching: topologyFetching } = useQuery<TopologyPayload>({
    queryKey: ["topology"],
    queryFn: async () => {
      const res = await fetch("/api/topology");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json() as Promise<TopologyPayload>;
    },
    refetchInterval: 3_000,
    staleTime: 0,
  });

  // Track whether we've ever received a non-empty topology response.
  // Used to distinguish "first load in progress" from "confirmed failure".
  const [everReceivedNodes, setEverReceivedNodes] = useState(false);

  // After SPINNER_TIMEOUT_MS with no nodes, replace the spinner with a calm
  // fallback message. The latch is gated on !everReceivedNodes at the render
  // site so kiosk mode auto-recovers when nodes arrive without needing a
  // synchronous setState reset in the effect body.
  const SPINNER_TIMEOUT_MS = 15_000;
  const [spinnerTimedOut, setSpinnerTimedOut] = useState(false);
  useEffect(() => {
    if (everReceivedNodes) return;
    const timer = setTimeout(() => setSpinnerTimedOut(true), SPINNER_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [everReceivedNodes]);

  // Merge structure + live runtime into React Flow nodes + edges.
  // Track the previous node-id set so we can release sparkline buffers for
  // nodes that have disappeared (e.g. a camera feed was removed).
  const prevNodeIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const apiEdges = topologyPayload?.edges ?? [];

    // Compute the stable stage index from the API payload's authored positions.
    // This is drag-proof: we always read from the payload, not from current node
    // positions (which may have been moved by the user).
    const stageIndexById = buildStageIndexById(topologyPayload ?? null);

    // Determine stagesPerRow first so flowDir can be stamped on every node.
    const allStageIndices = Object.values(stageIndexById);
    const numStages = allStageIndices.length > 0 ? Math.max(...allStageIndices) + 1 : 1;
    const stagesPerRow = Math.ceil(numStages / chooseSerpentineRows(numStages));

    const merged = mergeTopologyData(
      topologyPayload ?? null,
      snapshot,
      savedPositionsRef.current,
      apiEdges,
      stageIndexById,
      stagesPerRow,
    );
    const mergedEdges = mergeTopologyEdges(topologyPayload ?? null, snapshot, stageIndexById);
    const { nodes: laidOut } = applyFlowLayout(merged, savedPositionsRef.current, stageIndexById);
    const mergedIds = new Set(laidOut.map((n) => n.id));
    const prevIds = prevNodeIdsRef.current;
    const nodeSetChanged =
      mergedIds.size !== prevIds.size || [...mergedIds].some((id) => !prevIds.has(id));
    for (const prevId of prevIds) {
      if (!mergedIds.has(prevId)) clearNodeSparklines(prevId);
    }
    prevNodeIdsRef.current = mergedIds;
    setNodes(laidOut);
    setEdges(mergedEdges);
    // Re-frame the whole graph only when the node set changes (first load /
    // structural change) — not on every 5 s health tick, so a user's manual
    // pan/zoom is preserved. Keeps the full pipeline in view without panning.
    if (nodeSetChanged && mergedIds.size > 0) {
      requestAnimationFrame(() => rfRef.current?.fitView({ padding: 0.12, duration: 300 }));
    }
    if ((topologyPayload?.nodes?.length ?? 0) > 0) {
      // reason: monotonic boolean latch (false→true only); depends on async
      // query data so lazy initializer is not an option. No cascading risk
      // because setEverReceivedNodes(true) is guarded and called at most once.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setEverReceivedNodes(true);
    }
  }, [topologyPayload, snapshot, setNodes, setEdges]);

  const onNodeClick: NodeMouseHandler<Node<TopologyNodeData>> = useCallback((_evt, node) => {
    setSelectedNodeId(node.id);
  }, []);

  // Resolve the selected node's data for the panel.
  const selectedNode = selectedNodeId
    ? nodes.find((n) => n.id === selectedNodeId)
    : null;

  const panelLabel = selectedNode?.data.label ?? selectedNodeId ?? "";
  const panelNamespace = selectedNode?.data.namespace;
  const panelNodeType: NodeType = selectedNode?.data.nodeType ?? "service";
  // StorageNode + FeedNode store live state under `.runtime`; ServiceNode stores it directly.
  const panelRuntimeState: NodeRuntimeState | undefined =
    selectedNode?.data.runtime ??
    (selectedNode?.data.health
      ? { health: selectedNode.data.health as PipelineHealth }
      : undefined);

  // Resolve content: static registry first, then dynamic feed Status + Actions for "feed:*" nodes.
  const panelContent = selectedNodeId
    ? (NODE_CONTENT[selectedNodeId] ?? {
        ...(getFeedContent(selectedNodeId) ?? {}),
        ...(getFeedActionsContent(selectedNodeId) ?? {}),
      })
    : undefined;

  return (
    <Shell className="p-0">
      <div className="flex h-full flex-col">
        <div className="flex items-center justify-between border-b border-border px-6 py-3">
          <div>
            <h1 className="text-xl font-bold">Topology</h1>
            <p className="text-xs text-muted-foreground">
              Live service dependency graph — refreshes every 3 s
            </p>
          </div>
          <button
            type="button"
            onClick={resetLayout}
            title="Reset all node positions to defaults"
            className="flex items-center gap-1.5 rounded border border-border bg-card px-2.5 py-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <LayoutGrid className="h-3.5 w-3.5" />
            Reset layout
          </button>
        </div>

        <div className="flex-1 relative" style={{ minHeight: "calc(100vh - 8rem)" }}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onInit={(inst) => { rfRef.current = inst; }}
            onNodesChange={handleNodesChange}
            onEdgesChange={onEdgesChange}
            onNodeClick={onNodeClick}
            nodeTypes={NODE_TYPES}
            edgeTypes={EDGE_TYPES}
            fitView
            fitViewOptions={{ padding: 0.15 }}
            attributionPosition="bottom-right"
            colorMode="light"
          >
            <Background bgColor="#f7f8fa" color="#cbd5e1" gap={24} />
            <Controls />
            <MiniMap
              nodeColor={(node) => {
                const d = node.data as TopologyNodeData;
                const h = d?.health ?? "unknown";
                if (h === "ok") return "#059669";
                if (h === "warn") return "#f59e0b";
                if (h === "fail") return "#dc2626";
                return "#94a3b8";
              }}
              className="!bg-card !border-border"
            />
          </ReactFlow>

          {/* Empty / loading state — shown only while the canvas has no nodes */}
          {nodes.length === 0 && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              {/* Three states in priority order:
                  1. API hard-error before any nodes ever arrived → error badge.
                  2. Spinner timed out (15 s) without nodes → calm fallback with
                     link to Overview. Retries continue in the background so the
                     diagram auto-recovers when the cluster comes back (kiosk-safe:
                     no modal, no click required).
                  3. Default → spinner while the first response is in-flight. */}
              {topologyError && !everReceivedNodes ? (
                <div className="flex flex-col items-center gap-2 text-muted-foreground">
                  <AlertTriangle className="h-5 w-5 text-amber-600" />
                  <span className="text-sm">Topology unavailable — retrying</span>
                </div>
              ) : spinnerTimedOut && !everReceivedNodes ? (
                <div className="pointer-events-auto flex flex-col items-center gap-3 text-center text-muted-foreground">
                  <AlertTriangle className="h-6 w-6 text-amber-600" />
                  <span className="text-sm">Topology unavailable — check cluster health on the</span>
                  <Link
                    href="/"
                    className="text-sm text-primary underline-offset-4 hover:underline"
                  >
                    Overview page
                  </Link>
                  <span className="text-xs opacity-50">Reconnecting in the background…</span>
                </div>
              ) : (
                <div className="flex flex-col items-center gap-2 text-muted-foreground">
                  <Loader2 className="h-5 w-5 animate-spin opacity-50" />
                  <span className="text-sm">Connecting to pipeline…</span>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <NodeDetailPanel
        open={!!selectedNodeId}
        nodeId={selectedNodeId}
        nodeLabel={panelLabel}
        nodeType={panelNodeType}
        namespace={panelNamespace}
        content={panelContent}
        runtimeState={panelRuntimeState}
        snapshot={snapshot ?? undefined}
        onClose={() => setSelectedNodeId(null)}
      />
    </Shell>
  );
}

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
// Merge helper
// ─────────────────────────────────────────────────────────────────────────────

function mergeTopologyData(
  payload: TopologyPayload | null,
  snapshot: PipelineSnapshot | null,
  savedPositions: Record<string, { x: number; y: number }>,
): Node<TopologyNodeData>[] {
  const apiNodes = payload?.nodes ?? [];
  return apiNodes.map((n, idx) => {
    const runtimeState = snapshot?.nodes[n.id];
    const health: PipelineHealth = runtimeState?.health ?? n.health ?? "unknown";
    const rfType = reactFlowTypeFor(n.type);
    const apiPos = n.position ?? { x: idx * 180, y: 200 };
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
      },
    };
  });
}

function mergeTopologyEdges(
  payload: TopologyPayload | null,
  snapshot: PipelineSnapshot | null,
): Edge[] {
  const apiEdges = payload?.edges ?? [];
  return apiEdges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    type: "connection",
    data: {
      protocol: e.protocol,
      staticLabel: e.label,
      dormant: e.dormant,
      runtime: snapshot?.edges[e.id],
    },
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// React import (needed for NODE_TYPES cast)
// ─────────────────────────────────────────────────────────────────────────────

import React from "react";
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
  const everReceivedNodes = useRef(false);
  if ((topologyPayload?.nodes?.length ?? 0) > 0) {
    everReceivedNodes.current = true;
  }

  // Merge structure + live runtime into React Flow nodes + edges.
  // Track the previous node-id set so we can release sparkline buffers for
  // nodes that have disappeared (e.g. a camera feed was removed).
  const prevNodeIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const merged = mergeTopologyData(topologyPayload ?? null, snapshot, savedPositionsRef.current);
    const mergedIds = new Set(merged.map((n) => n.id));
    for (const prevId of prevNodeIdsRef.current) {
      if (!mergedIds.has(prevId)) clearNodeSparklines(prevId);
    }
    prevNodeIdsRef.current = mergedIds;
    setNodes(merged);
    setEdges(mergeTopologyEdges(topologyPayload ?? null, snapshot));
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
            onNodesChange={handleNodesChange}
            onEdgesChange={onEdgesChange}
            onNodeClick={onNodeClick}
            nodeTypes={NODE_TYPES}
            edgeTypes={EDGE_TYPES}
            fitView
            fitViewOptions={{ padding: 0.3 }}
            attributionPosition="bottom-right"
            colorMode="dark"
          >
            <Background color="#334155" gap={24} />
            <Controls />
            <MiniMap
              nodeColor={(node) => {
                const d = node.data as TopologyNodeData;
                const h = d?.health ?? "unknown";
                if (h === "ok") return "#22c55e";
                if (h === "warn") return "#eab308";
                if (h === "fail") return "#ef4444";
                return "#6b7280";
              }}
              className="!bg-card !border-border"
            />
          </ReactFlow>

          {/* Empty / loading state — shown only while the canvas has no nodes */}
          {nodes.length === 0 && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              {/* Don't gate on !topologyFetching — React Query retries flip
                  isFetching back to true during each retry attempt, which
                  would otherwise mask the error state behind a spinner for
                  the full retry window (~30 s). Showing the error as soon
                  as one attempt has failed + no prior data is the honest
                  signal. */}
              {topologyError && !everReceivedNodes.current ? (
                <div className="flex flex-col items-center gap-2 text-muted-foreground">
                  <AlertTriangle className="h-5 w-5 text-amber-500/70" />
                  <span className="text-sm">Topology unavailable — retrying</span>
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

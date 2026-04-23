"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const NODE_TYPES: NodeTypes = {
  service: ServiceNode as any,
  storage: StorageNode as any,
  feed: FeedNode as any,
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
): Node<TopologyNodeData>[] {
  const apiNodes = payload?.nodes ?? [];
  return apiNodes.map((n, idx) => {
    const runtimeState = snapshot?.nodes[n.id];
    const health: PipelineHealth = runtimeState?.health ?? n.health ?? "unknown";
    const rfType = reactFlowTypeFor(n.type);
    return {
      id: n.id,
      position: n.position ?? { x: idx * 180, y: 200 },
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

// ─────────────────────────────────────────────────────────────────────────────
// Page
// ─────────────────────────────────────────────────────────────────────────────

export default function TopologyPage() {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<TopologyNodeData>>(BASE_NODES);
  const [edges, setEdges, onEdgesChange] = useEdgesState(BASE_EDGES);

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
  const { data: topologyPayload } = useQuery<TopologyPayload>({
    queryKey: ["topology"],
    queryFn: async () => {
      const res = await fetch("/api/topology");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json() as Promise<TopologyPayload>;
    },
    refetchInterval: 3_000,
    staleTime: 0,
  });

  // Merge structure + live runtime into React Flow nodes + edges.
  // Track the previous node-id set so we can release sparkline buffers for
  // nodes that have disappeared (e.g. a camera feed was removed).
  const prevNodeIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const merged = mergeTopologyData(topologyPayload ?? null, snapshot);
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
        </div>

        <div className="flex-1" style={{ minHeight: "calc(100vh - 8rem)" }}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
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

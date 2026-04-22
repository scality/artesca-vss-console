"use client";

import { useCallback, useState } from "react";
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
import { ConnectionEdge } from "@/components/topology/ConnectionEdge";
import { NodeDetailDialog } from "@/components/topology/NodeDetailDialog";
import type { Health } from "@/lib/types";

/** Hand-placed positions for the VSS pipeline:
 *  camera-sim → mediamtx → VST → rtvi-vlm → Kafka → alert-worker → agent-ui
 *  NIM on the side; S3 bottom.
 */
const BASE_NODES: Array<Omit<Node<ServiceNodeData>, "data"> & { data: ServiceNodeData }> = [
  {
    id: "camera-sim",
    position: { x: 0, y: 200 },
    data: { label: "camera-sim", health: "unknown", namespace: "camera-sim" },
    type: "service",
  },
  {
    id: "mediamtx",
    position: { x: 220, y: 200 },
    data: { label: "mediamtx", health: "unknown", namespace: "vss" },
    type: "service",
  },
  {
    id: "vst",
    position: { x: 440, y: 200 },
    data: { label: "VST", health: "unknown", namespace: "vss" },
    type: "service",
  },
  {
    id: "rtvi-vlm",
    position: { x: 660, y: 200 },
    data: { label: "rtvi-vlm", health: "unknown", namespace: "vss" },
    type: "service",
  },
  {
    id: "kafka",
    position: { x: 880, y: 200 },
    data: { label: "Kafka", health: "unknown", namespace: "kafka" },
    type: "service",
  },
  {
    id: "alert-worker",
    position: { x: 1100, y: 200 },
    data: { label: "alert-worker", health: "unknown", namespace: "vss" },
    type: "service",
  },
  {
    id: "agent-ui",
    position: { x: 1320, y: 200 },
    data: { label: "agent-ui", health: "unknown", namespace: "vss" },
    type: "service",
  },
  // NIM on the side
  {
    id: "nim",
    position: { x: 660, y: 0 },
    data: { label: "NIM", health: "unknown", namespace: "nim" },
    type: "service",
  },
  // S3 bottom
  {
    id: "s3",
    position: { x: 880, y: 400 },
    data: { label: "S3 / ARTESCA", health: "unknown", namespace: "artesca" },
    type: "service",
  },
];

const BASE_EDGES: Edge[] = [
  { id: "e-cam-mtx", source: "camera-sim", target: "mediamtx", type: "connection", data: { protocol: "RTSP" } },
  { id: "e-mtx-vst", source: "mediamtx", target: "vst", type: "connection", data: { protocol: "RTSP" } },
  { id: "e-vst-vlm", source: "vst", target: "rtvi-vlm", type: "connection", data: { protocol: "gRPC" } },
  { id: "e-vlm-nim", source: "rtvi-vlm", target: "nim", type: "connection", data: { protocol: "HTTP" } },
  { id: "e-vlm-kafka", source: "rtvi-vlm", target: "kafka", type: "connection", data: { protocol: "Kafka" } },
  { id: "e-kafka-alert", source: "kafka", target: "alert-worker", type: "connection", data: { protocol: "Kafka" } },
  { id: "e-alert-ui", source: "alert-worker", target: "agent-ui", type: "connection", data: { protocol: "HTTP" } },
  { id: "e-alert-s3", source: "alert-worker", target: "s3", type: "connection", data: { protocol: "HTTP" } },
];

const NODE_TYPES: NodeTypes = { service: ServiceNode };
const EDGE_TYPES: EdgeTypes = { connection: ConnectionEdge };

interface TopologyPayload {
  nodes?: Array<{ id: string; health?: Health; namespace?: string; podCount?: number; restarts?: number }>;
}

function mergeTopologyData(
  baseNodes: typeof BASE_NODES,
  payload: TopologyPayload | null
): typeof BASE_NODES {
  if (!payload?.nodes) return baseNodes;
  return baseNodes.map((node) => {
    const live = payload.nodes!.find((n) => n.id === node.id);
    if (!live) return node;
    return {
      ...node,
      data: {
        ...node.data,
        health: live.health ?? node.data.health,
        namespace: live.namespace ?? node.data.namespace,
        podCount: live.podCount,
        restarts: live.restarts,
      },
    };
  });
}

export default function TopologyPage() {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<ServiceNodeData>>(BASE_NODES as Node<ServiceNodeData>[]);
  const [edges, , onEdgesChange] = useEdgesState(BASE_EDGES);
  const [selectedNode, setSelectedNode] = useState<{
    id: string;
    data: ServiceNodeData;
  } | null>(null);

  // Poll topology API every 3 s and merge live health data into React Flow nodes
  useQuery<TopologyPayload>({
    queryKey: ["topology"],
    queryFn: async () => {
      const res = await fetch("/api/topology");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: TopologyPayload = await res.json();
      const merged = mergeTopologyData(BASE_NODES as typeof BASE_NODES, data);
      setNodes(merged as Node<ServiceNodeData>[]);
      return data;
    },
    refetchInterval: 3_000,
    staleTime: 0,
  });

  const onNodeClick: NodeMouseHandler<Node<ServiceNodeData>> = useCallback((_evt, node) => {
    setSelectedNode({ id: node.id, data: node.data });
  }, []);

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
                const data = node.data as ServiceNodeData;
                const h = data?.health ?? "unknown";
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

      {selectedNode && (
        <NodeDetailDialog
          open={!!selectedNode}
          onClose={() => setSelectedNode(null)}
          nodeData={selectedNode.data}
          componentId={selectedNode.id}
        />
      )}
    </Shell>
  );
}

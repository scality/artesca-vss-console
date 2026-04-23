// src/components/topology/registry.ts
// Registry types for the topology node detail panel.
// Frontend agents fill slices of NodeContentMap keyed by node id.

import type { ReactNode } from "react";
import type { NodeRuntimeState, PipelineSnapshot } from "@/lib/types/pipeline";

export type NodeType =
  | "service"
  | "storage"
  | "feed"
  | "database"
  | "redis"
  | "external";

export interface TabRendererProps {
  nodeId: string;
  runtimeState: NodeRuntimeState | undefined;
  snapshot: PipelineSnapshot | undefined;
}

export type TabRenderer = (props: TabRendererProps) => ReactNode;

export interface NodeContent {
  status?: TabRenderer;
  config?: TabRenderer;
  metrics?: TabRenderer;
  actions?: TabRenderer;
}

/** Frontend agents fill slices of this map keyed by node id. */
export type NodeContentMap = Record<string, NodeContent>;

/**
 * Merge multiple NodeContentMap slices into one.
 * Later maps win per tab key when the same node id is present in multiple maps.
 */
export function mergeContent(...maps: NodeContentMap[]): NodeContentMap {
  const result: NodeContentMap = {};
  for (const map of maps) {
    for (const [nodeId, content] of Object.entries(map)) {
      result[nodeId] = { ...result[nodeId], ...content };
    }
  }
  return result;
}

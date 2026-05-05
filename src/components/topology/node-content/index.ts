// src/components/topology/node-content/index.ts
// Aggregates all per-domain content maps into a single NODE_CONTENT map.
// Individual agents own each named export; this file only merges them.

import { mergeContent, type NodeContentMap } from "../registry";
import { STORAGE_CONTENT } from "./storage";   // Agent 4
import { COMPUTE_CONTENT } from "./compute";   // Agent 5
import { FEED_CONTENT } from "./feeds";        // Agent 3 / Agent 6
import { ACTIONS_CONTENT } from "./actions";   // Agent 6

const _base = mergeContent(
  STORAGE_CONTENT,
  COMPUTE_CONTENT,
  FEED_CONTENT,
  ACTIONS_CONTENT,
);

// Docker-mode compose container names differ from the k8s logical node IDs
// that content maps are keyed on. Alias them so the same panel renders in
// both runtimes.
const DOCKER_ALIASES: Record<string, string> = {
  "sensor-ms-dev":                "sensor-ms",
  "streamprocessing-ms-dev":      "streamprocessing-ms",
  "vss-video-analytics-api-alerts": "alert-worker",
  "cosmos-reason2-8b":            "nim-cosmos-reason2",
};

export const NODE_CONTENT: NodeContentMap = {
  ..._base,
  ...Object.fromEntries(
    Object.entries(DOCKER_ALIASES)
      .filter(([, logical]) => !!_base[logical])
      .map(([docker, logical]) => [docker, _base[logical]]),
  ),
};

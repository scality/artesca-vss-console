// src/components/topology/node-content/index.ts
// Aggregates all per-domain content maps into a single NODE_CONTENT map.
// Individual agents own each named export; this file only merges them.

import { mergeContent, type NodeContentMap } from "../registry";
import { STORAGE_CONTENT } from "./storage";   // Agent 4
import { COMPUTE_CONTENT } from "./compute";   // Agent 5
import { FEED_CONTENT } from "./feeds";        // Agent 3 / Agent 6
import { ACTIONS_CONTENT } from "./actions";   // Agent 6

export const NODE_CONTENT: NodeContentMap = mergeContent(
  STORAGE_CONTENT,
  COMPUTE_CONTENT,
  FEED_CONTENT,
  ACTIONS_CONTENT,
);

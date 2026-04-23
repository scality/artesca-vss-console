// src/components/topology/node-content/actions.ts
// Agent 6 — Actions tab content for all topology nodes.
// Each entry contributes only the `actions` tab.
// Other tabs (status, config, metrics) are owned by Agents 3-5.

import type { NodeContentMap } from "../registry";
import {
  CameraSimActionsRenderer,
  SensorMsActionsRenderer,
  StreamProcessingActionsRenderer,
  RtviVlmActionsRenderer,
  RtviEmbedActionsRenderer,
  NimCosmosActionsFullRenderer,
  AlertWorkerActionsRenderer,
  AgentActionsRenderer,
  MediamtxActionsRenderer,
  DemoDataActionsRenderer,
  getFeedActionsContent,
} from "./action-renderers";

// Re-export for NodeDetailPanel feed:* fallback merging.
// The panel should call:
//   const content = NODE_CONTENT[nodeId] ?? mergeContent(
//     getFeedContent(nodeId) ?? {},
//     getFeedActionsContent(nodeId) ?? {}
//   );
export { getFeedActionsContent };

// artesca-s3 is intentionally omitted — Agent 4 (storage.ts) owns its actions.
// feed:* nodes are handled via getFeedActionsContent() in action-renderers.tsx
// and must be merged by the NodeDetailPanel with getFeedContent() (Agent 3).

export const ACTIONS_CONTENT: NodeContentMap = {
  "camera-sim": {
    actions: CameraSimActionsRenderer,
  },
  "sensor-ms": {
    actions: SensorMsActionsRenderer,
  },
  "streamprocessing-ms": {
    actions: StreamProcessingActionsRenderer,
  },
  "rtvi-vlm": {
    actions: RtviVlmActionsRenderer,
  },
  "rtvi-embed": {
    actions: RtviEmbedActionsRenderer,
  },
  "nim-cosmos-reason2": {
    actions: NimCosmosActionsFullRenderer,
  },
  "alert-worker": {
    actions: AlertWorkerActionsRenderer,
  },
  agent: {
    actions: AgentActionsRenderer,
  },
  mediamtx: {
    actions: MediamtxActionsRenderer,
  },
  "demo-data-producer": {
    actions: DemoDataActionsRenderer,
  },
};

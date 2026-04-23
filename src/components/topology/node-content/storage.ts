// src/components/topology/node-content/storage.ts
// Agent 4 owns this file: storage nodes (artesca-s3, vst-local-cache, vst-postgres, vst-redis, alerts-redis)
import type { NodeContentMap } from "../registry";
import { STORAGE_RENDERERS } from "./storage-renderers";

export const STORAGE_CONTENT: NodeContentMap = STORAGE_RENDERERS;

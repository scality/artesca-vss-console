// src/components/topology/node-content/storage.ts
// Storage-category topology nodes: artesca-s3, vst-local-cache, vst-postgres, vst-redis.
// vst-redis also covers alert-worker cooldown keys (alerts reuses VST Redis).
import type { NodeContentMap } from "../registry";
import { STORAGE_RENDERERS } from "./storage-renderers";

export const STORAGE_CONTENT: NodeContentMap = STORAGE_RENDERERS;

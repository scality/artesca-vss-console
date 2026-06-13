// src/lib/types/pipeline.ts
// Single source of truth for all pipeline-level types.
// Frontend agents import from "@/lib/types/pipeline".

export type PipelineHealth = "ok" | "warn" | "fail" | "unknown";

// NodeType drives visual rendering on the topology canvas.
export type NodeType =
  | "service"    // generic K8s Deployment / pod
  | "storage"    // object-storage bucket (ARTESCA S3)
  | "feed"       // per-sensor RTSP feed sub-node (parent: camera-sim)
  | "database"   // relational DB (VST Postgres)
  | "redis"      // Redis instance
  | "external";  // outside the K8s cluster (camera-sim EC2, mediamtx)

export interface EdgeRuntimeState {
  throughput: { value: number; unit: string } | null; // e.g. { value: 4.2, unit: "Mbps" } — null when unknown
  health: "flowing" | "idle" | "error" | "unknown";
  label: string;       // pre-formatted, e.g. "RTSP 4.2 Mbps"
  errorHint?: string;
}

export interface PodState {
  namespace: string;
  phase: "Pending" | "Running" | "Succeeded" | "Failed" | "Unknown";
  ready: boolean;
  restarts: number;
  ageSecs: number;
}

export interface GpuStateShort {
  index: number;
  utilPct: number;
  memUsedGiB: number;
  memTotalGiB: number;
}

export interface S3State {
  bucket: string;
  /** Configured S3 endpoint (ARTESCA vhost FQDN, or null when the SDK
   *  computes an AWS-native one). Shown in the Config tab. */
  endpoint?: string | null;
  objectCount: number;
  bytesTotal: number;
  putRateMBps: number;
  putRateObjPerMin: number;
  ceilingGiB: number;          // hard ceiling (100 for demo profile)
  ceilingPct: number;          // (bytesTotal / ceilingGiB-in-bytes) * 100
  bucketScanTruncated: boolean;
  bucketScanStaleSecs: number;
}

export interface CacheState {
  fillPct: number | null;
  thresholdPct: number;
  sizeGiB: number;             // 500 for emptyDir
  frameDropCount: number | null;
  frameDropRatePerMin: number | null;
}

export interface DbState {
  up: boolean;
  connections: number | null;
  sizeMiB: number | null;
}

export interface RedisState {
  up: boolean;
  connectedClients: number | null;
  memUsedMiB: number | null;
}

export interface FeedState {
  sensorId: string;
  bitrateMbps: number | null;
  codec: "h264" | "h265" | "unknown";
  resolution: { width: number; height: number } | null;
  fps: number | null;
  gop: number | null;
  vstRegistered: boolean;
  lastFrameAgoMs: number | null;
}

export interface NimState {
  model: string;
  warmupPct: number;
  tokensPerSec: number | null;
  inferenceLatencyP50Ms: number | null;
  inferenceLatencyP95Ms: number | null;
  queueDepth: number | null;
}

export interface KafkaTopicState {
  name: string;
  msgRatePerSec: number | null;
  lagMsgs: number | null;
}

export interface MediamtxState {
  reachable: boolean;
  pathsReady: number;
  pathsTotal: number;
}

export interface NodeRuntimeState {
  health: PipelineHealth;
  pod?: PodState;
  gpu?: GpuStateShort;
  s3?: S3State;
  cache?: CacheState;
  db?: DbState;
  redis?: RedisState;
  feed?: FeedState;
  nim?: NimState;
  kafka?: { topics: KafkaTopicState[] };
  mediamtx?: MediamtxState;
}

export interface PipelineSnapshot {
  takenAt: string;                      // ISO 8601
  nodes: Record<string, NodeRuntimeState>;
  edges: Record<string, EdgeRuntimeState>;
  warnings: string[];                   // data-source failures, e.g. "Prometheus unreachable"
}

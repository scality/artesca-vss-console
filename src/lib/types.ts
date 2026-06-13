// src/lib/types.ts
// Data model as defined in docs/console-design.md — verbatim interface definitions.

export type Health = "ok" | "warn" | "fail" | "unknown";

export interface PodSummary {
  namespace: string;
  name: string;
  phase: "Pending" | "Running" | "Succeeded" | "Failed" | "Unknown";
  ready: boolean;
  restarts: number;
  age: string; // "4h23m"
  node?: string;
  gpus?: number;
  containers?: string[]; // container names (for the logs picker)
}

export type RecordingPolicy = "always" | "event-only" | "off";

export interface CameraRecording {
  enabled: boolean;
  policy: RecordingPolicy;
  retentionDays: number;
}

export interface Camera {
  id: string; // "checkout-1"
  role: "checkout" | "aisle" | "dock" | "backroom" | "other";
  description?: string;
  feeds: Feed[]; // default 2 per Pyramid 2-lens rail; 1..N allowed
  /** Per-camera scenario overrides.  undefined = use sensor_filter glob (no override).
   *  Empty array = explicit suppression (no scenarios fire for this camera). */
  scenarioIds?: string[];
  recording?: CameraRecording;
}

export interface Feed {
  id: string; // "a" | "b" | "lens1" | "lens2" | ...
  sensorId: string; // VST sensor_id, `${camera.id}-${feed.id}` by convention
  source: string; // filename in /opt/camera-sim/data/
  rtspUrl: string; // rtsp://<EIP>:8554/<sensorId>
  vstRegistered: boolean;
  replayReady: boolean; // mediamtx reports path ready
  bitrateMbps?: number;
  fps?: number;
  codec?: "hevc" | "h264";
}

export interface DemoProfile {
  name: string; // "pyramid-jun-8" | "aarco-rehearsal" | ...
  savedAt: string; // ISO 8601
  savedBy: string; // operator login (for shared-password mode: "console-operator")
  scenarios: Scenario[];
  vlmPrompt: string;
  cameras: Camera[];
  rtviTuning: Partial<{
    maxNumSeqs: number;
    kvCachePct: number;
    maxModelLen: number;
  }>;
  alertTuning: Partial<{
    cooldownSeconds: number;
    slackWebhookConfigured: boolean;
  }>;
  nimModel: "cosmos-reason2-8b" | "cosmos-reason1-7b" | string;
}

export interface Scenario {
  id: string;
  name: string;
  description?: string;
  severity: "low" | "medium" | "high";
  channels: Array<"ui" | "slack">;
  sensorFilter: string; // glob or comma-separated
  keywords: string[];
  enabled: boolean;
}

export interface Incident {
  ts: string; // ISO 8601
  scenarioId: string;
  scenarioName: string;
  severity: Scenario["severity"];
  sensorId: string;
  topic: string;
  summary: string;
  raw: unknown;
  clipKey?: string;
  clipBucket?: string;
  clipStatus?: "pending" | "ready" | "failed";
}

export interface GpuState {
  index: number;
  name: string; // "NVIDIA L4" | "NVIDIA L40S"
  memoryUsedMiB: number;
  memoryTotalMiB: number;
  utilGpu: number; // 0-100
  utilMem: number;
  tempC: number;
  powerW: number;
  processes: Array<{ pid: number; name: string; memMiB: number }>;
}

export interface OverviewSnapshot {
  takenAt: string;
  namespaces: Record<string, { total: number; ready: number; failed: number }>;
  nim: { ready: boolean; warmupPct: number; queueDepth: number };
  gpus: GpuState[];
  // retainedMsgs is topic depth (high − low watermark = messages retained in
  // the topic), NOT consumer-group lag. null when unmeasurable (broker
  // unreachable / not configured) — distinct from a real 0. Informational.
  kafka: Record<string, { topic: string; retainedMsgs: number | null }>;
  s3: {
    bucket: string;
    objectCount: number;
    bytesTotal: number;
    growth24h: number;
  };
  cameraSim: {
    instanceState: "running" | "stopped" | "unreachable";
    pathsReady: number;
    pathsTotal: number;
  };
}

export interface SgWhitelistEntry {
  id: string; // stable uuid for the row
  cidr: string; // "84.14.13.200/29"
  label: string; // "Scality Paris office"
  addedBy: string; // operator login
  addedAt: string; // ISO 8601
  port: 8800; // future-proofing; today always 8800
}

export interface ModelCard {
  image: string; // nvcr.io/nim/... or nvcr.io/nvidia/vllm:... for vLLM-based NIMs
  displayName: string;
  parameterCount: string; // "8.0 B"
  precision: string; // "BF16" | "FP8" | "FP16"
  minGpuMemoryGiB: number;
  warmupSeconds: number;
  l4Validated: boolean;
  l40sValidated: boolean;
  strengths: string[];
  limitations: string[];
  scalityUseCase: string;
  tags?: string[]; // e.g. ["blueprint-pinned", "vllm", "preview"]
  ngcCatalogUrl?: string; // canonical NGC catalog page
  unverified?: boolean; // true when image/specs could not be confirmed against public NVIDIA docs
}

export interface AuditLogEntry {
  id: string;
  ts: string;
  operator: string;
  action: string;
  target: string;
  detailsJson: string;
}

/**
 * Shape of the JSON manifest written to the alert-clips bucket by the
 * clip materializer.  The manifest records the VST clip URL so the replay
 * route can fetch video bytes on demand without byte-duplicating them into S3.
 *
 * Produced by: k8s/nvidia-vss/alerts/15-configmap-materializer-code.yaml
 * Consumed by: console /api/clips/[sensor]/[ts]/route.ts
 */
export interface AlertClipManifest {
  version: 1;
  sensor_id: string;
  ts: string; // ISO 8601 — alert timestamp
  window_seconds: number;
  start_ts: string; // ISO 8601 — clip window start
  end_ts: string; // ISO 8601 — clip window end
  vst_clip_url: string; // VST /api/v1/live/sensor/<id>/clip?start=…&end=…
  materialized_at: string; // ISO 8601 — when the materializer wrote this manifest
}

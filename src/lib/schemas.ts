// src/lib/schemas.ts
// Zod schemas mirroring every type in types.ts.
// API routes validate inbound and outbound payloads against these.

import { z } from "zod";

export const HealthSchema = z.enum(["ok", "warn", "fail", "unknown"]);

export const PodSummarySchema = z.object({
  namespace: z.string(),
  name: z.string(),
  phase: z.enum(["Pending", "Running", "Succeeded", "Failed", "Unknown"]),
  ready: z.boolean(),
  restarts: z.number().int().nonnegative(),
  age: z.string(),
  node: z.string().optional(),
  gpus: z.number().int().nonnegative().optional(),
});

export const FeedSchema = z.object({
  id: z.string(),
  sensorId: z.string(),
  source: z.string(),
  rtspUrl: z.string(),
  vstRegistered: z.boolean(),
  replayReady: z.boolean(),
  vstRecording: z.boolean().optional(),
  vstIngesting: z.boolean().optional(),
  vstRecoveryState: z.enum(["recovering", "degraded"]).optional(),
  bitrateMbps: z.number().positive().optional(),
  fps: z.number().positive().optional(),
  codec: z.enum(["hevc", "h264"]).optional(),
});

export const RecordingPolicySchema = z.enum(["always", "event-only", "off"]);

export const CameraRecordingSchema = z.object({
  enabled: z.boolean(),
  policy: RecordingPolicySchema,
  retentionDays: z.number().int().positive(),
});

export const CameraSchema = z.object({
  id: z.string().min(1),
  role: z.enum(["checkout", "aisle", "dock", "backroom", "other"]),
  description: z.string().optional(),
  feeds: z.array(FeedSchema).min(1),
  scenarioIds: z.array(z.string()).optional(),
  promptId: z.string().optional(),
  recording: CameraRecordingSchema.optional(),
});

export const ScenarioSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  severity: z.enum(["low", "medium", "high"]),
  channels: z.array(z.enum(["ui", "slack"])),
  sensorFilter: z.string(),
  keywords: z.array(z.string()),
  enabled: z.boolean(),
});

export const DemoProfileSchema = z.object({
  name: z.string().min(1),
  savedAt: z.string().datetime(),
  savedBy: z.string(),
  scenarios: z.array(ScenarioSchema),
  vlmPrompt: z.string(),
  cameras: z.array(CameraSchema),
  rtviTuning: z
    .object({
      maxNumSeqs: z.number().int().positive().optional(),
      kvCachePct: z.number().min(0).max(1).optional(),
      maxModelLen: z.number().int().positive().optional(),
    })
    .partial(),
  alertTuning: z
    .object({
      cooldownSeconds: z.number().int().nonnegative().optional(),
      slackWebhookConfigured: z.boolean().optional(),
    })
    .partial(),
  nimModel: z.string().min(1),
});

export const IncidentSchema = z.object({
  ts: z.string().datetime(),
  scenarioId: z.string(),
  scenarioName: z.string(),
  severity: z.enum(["low", "medium", "high"]),
  sensorId: z.string(),
  topic: z.string(),
  summary: z.string(),
  raw: z.unknown(),
  clipKey: z.string().optional().default(""),
  clipBucket: z.string().optional().default(""),
  clipStatus: z.enum(["pending", "ready", "failed"]).optional().default("pending"),
});

export const GpuProcessSchema = z.object({
  pid: z.number().int().nonnegative(),
  name: z.string(),
  memMiB: z.number().nonnegative(),
});

export const GpuStateSchema = z.object({
  index: z.number().int().nonnegative(),
  name: z.string(),
  memoryUsedMiB: z.number().nonnegative(),
  memoryTotalMiB: z.number().positive(),
  utilGpu: z.number().min(0).max(100),
  utilMem: z.number().min(0).max(100),
  tempC: z.number(),
  powerW: z.number().nonnegative(),
  processes: z.array(GpuProcessSchema),
});

export const OverviewSnapshotSchema = z.object({
  takenAt: z.string().datetime(),
  namespaces: z.record(
    z.object({
      total: z.number().int().nonnegative(),
      ready: z.number().int().nonnegative(),
      failed: z.number().int().nonnegative(),
    })
  ),
  nim: z.object({
    ready: z.boolean(),
    warmupPct: z.number().min(0).max(100),
    queueDepth: z.number().int().nonnegative(),
  }),
  gpus: z.array(GpuStateSchema),
  kafka: z.record(
    z.object({
      topic: z.string(),
      // topic depth (messages retained); null = unmeasurable.
      retainedMsgs: z.number().int().nonnegative().nullable(),
    })
  ),
  s3: z.object({
    bucket: z.string(),
    objectCount: z.number().int().nonnegative(),
    bytesTotal: z.number().nonnegative(),
    growth24h: z.number(),
    bytesCapacity: z.number().nonnegative(),
  }),
  cameraSim: z.object({
    instanceState: z.enum(["running", "stopped", "unreachable"]),
    pathsReady: z.number().int().nonnegative(),
    pathsTotal: z.number().int().nonnegative(),
    cameras: z
      .array(z.object({ name: z.string(), live: z.boolean() }))
      .optional(),
  }),
  recording: z
    .object({
      recovering: z.number().int().nonnegative(),
      degraded: z.number().int().nonnegative(),
    })
    .optional(),
});

export const SgWhitelistEntrySchema = z.object({
  id: z.string().uuid(),
  cidr: z.string().regex(/^[\d.:/]+$/),
  label: z.string().min(1),
  addedBy: z.string(),
  addedAt: z.string().datetime(),
  port: z.literal(8800),
});

export const ModelCardSchema = z.object({
  image: z.string().min(1),
  displayName: z.string().min(1),
  parameterCount: z.string(),
  precision: z.string(),
  minGpuMemoryGiB: z.number().positive(),
  warmupSeconds: z.number().positive(),
  l4Validated: z.boolean(),
  l40sValidated: z.boolean(),
  strengths: z.array(z.string()),
  limitations: z.array(z.string()),
  scalityUseCase: z.string(),
  tags: z.array(z.string()).optional(),
  ngcCatalogUrl: z.string().url().optional(),
  unverified: z.boolean().optional(),
});

export const AuditLogEntrySchema = z.object({
  id: z.string().uuid(),
  ts: z.string().datetime(),
  operator: z.string(),
  action: z.string(),
  target: z.string(),
  detailsJson: z.string(),
});

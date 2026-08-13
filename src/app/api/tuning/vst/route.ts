import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { createLogger } from "@/lib/logger";
import { withRequestContext } from "@/lib/with-request-context";

const log = createLogger("api/tuning/vst");
import { z } from "zod";
import { rolloutRestart } from "@/lib/k8s";
import { readConfigMapKey, patchConfigMapRawKey } from "@/lib/helpers/configmaps";
import { auditLog } from "@/lib/helpers/audit";
import { CLUSTER } from "@/lib/cluster-refs";
import { extractK8sError } from "@/lib/errors";
import { rejectIfKiosk } from "@/lib/kiosk-server";
import fs from "fs/promises";
import path from "node:path";

export const dynamic = "force-dynamic";

const VST_STREAM_CONTAINER = "streamprocessing-ms-dev";
// Config file path inside sensor-ms-dev (bind-mounted from host via VST_CONFIG_PATH).
// Verified against refs/video-search-and-summarization/deployments/vst/developer/vst/docker-compose.yaml volumes:.
// ─── Internal shape of vst_config.json ───────────────────────────────────────

interface VstConfigJson {
  onvif?: {
    default_gov_length?: number;
    [key: string]: unknown;
  };
  data?: {
    always_recording?: boolean;
    event_recording?: boolean;
    event_record_length_secs?: number;
    record_buffer_length_secs?: number;
    supported_video_codecs?: string[];
    storage_threshold_percentage?: number;
    storage_monitoring_frequency_secs?: number;
    default_file_expiry_minutes?: number;
    enable_aging_policy?: boolean;
    recorder_enable_frame_drop?: boolean;
    // Cloud storage fields — guarded, not writable through this route.
    cloud_storage_type?: string;
    cloud_storage_endpoint?: string;
    cloud_storage_access_key?: string;
    cloud_storage_secret_key?: string;
    cloud_storage_bucket?: string;
    cloud_storage_region?: string;
    cloud_storage_use_ssl?: boolean;
    enable_cloud_storage?: boolean;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

// ─── Zod schema for VstConfigJson — used to validate JSON.parse results ───────

const VstConfigJsonSchema = z.object({
  onvif: z.object({
    default_gov_length: z.number().optional(),
  }).passthrough().optional(),
  data: z.object({
    always_recording: z.boolean().optional(),
    event_recording: z.boolean().optional(),
    event_record_length_secs: z.number().optional(),
    record_buffer_length_secs: z.number().optional(),
    supported_video_codecs: z.array(z.string()).optional(),
    storage_threshold_percentage: z.number().optional(),
    storage_monitoring_frequency_secs: z.number().optional(),
    default_file_expiry_minutes: z.number().optional(),
    enable_aging_policy: z.boolean().optional(),
    recorder_enable_frame_drop: z.boolean().optional(),
    cloud_storage_type: z.string().optional(),
    cloud_storage_endpoint: z.string().optional(),
    cloud_storage_access_key: z.string().optional(),
    cloud_storage_secret_key: z.string().optional(),
    cloud_storage_bucket: z.string().optional(),
    cloud_storage_region: z.string().optional(),
    cloud_storage_use_ssl: z.boolean().optional(),
    enable_cloud_storage: z.boolean().optional(),
  }).passthrough().optional(),
}).passthrough();

// ─── Sensor list response shape (best-effort) ─────────────────────────────────

interface SensorEntry {
  sensor_id?: string;
  sensorId?: string;
  id?: string;
  name?: string;
  state?: string;
  sensorIp?: string;
  bitrate_kbps?: number;
  bitrate_mbps?: number;
  gov_length?: number;
  gop?: number;
  [key: string]: unknown;
}

// ─── GET response type (contract) ────────────────────────────────────────────

interface VstTuningResponse {
  recordingMode: "always" | "event" | "both";
  eventRecordLengthSecs: number;
  recordBufferLengthSecs: number;
  defaultGovLength: number;
  supportedVideoCodecs: ("h264" | "h265")[];
  storageThresholdPercentage: number;
  storageMonitoringFrequencySecs: number;
  defaultFileExpiryMinutes: number;
  enableAgingPolicy: boolean;
  recorderEnableFrameDrop: boolean;
  observed?: {
    sensors: Array<{
      sensorId: string;
      name: string;
      state: string;
      bitrateMbps: number;
      gop: number;
    }>;
  };
}

// ─── PATCH validation schema ──────────────────────────────────────────────────

const CLOUD_STORAGE_FIELDS = [
  "cloud_storage_type",
  "cloud_storage_endpoint",
  "cloud_storage_access_key",
  "cloud_storage_secret_key",
  "cloud_storage_bucket",
  "cloud_storage_region",
  "cloud_storage_use_ssl",
  "enable_cloud_storage",
];

const VstTuningPatchSchema = z
  .object({
    recordingMode: z.enum(["always", "event", "both"]).optional(),
    eventRecordLengthSecs: z.number().int().positive().optional(),
    recordBufferLengthSecs: z.number().int().nonnegative().optional(),
    defaultGovLength: z.number().int().positive().optional(),
    supportedVideoCodecs: z.array(z.enum(["h264", "h265"])).min(1).optional(),
    storageThresholdPercentage: z.number().min(0).max(100).optional(),
    storageMonitoringFrequencySecs: z.number().int().positive().optional(),
    defaultFileExpiryMinutes: z.number().int().positive().optional(),
    enableAgingPolicy: z.boolean().optional(),
    recorderEnableFrameDrop: z.boolean().optional(),
  })
  .refine((d) => Object.values(d).some((v) => v !== undefined), {
    message: "At least one tuning field is required",
  });

type VstTuningPatch = z.infer<typeof VstTuningPatchSchema>;

/**
 * Mutates `cfg` in place with the given field-level patches. Shared by the
 * docker path and every ConfigMap target on the k8s path (sensor +
 * streamprocessing each hold their own copy of this schema — see the VST
 * comment in cluster-refs.ts).
 */
function applyVstPatches(cfg: VstConfigJson, patches: VstTuningPatch): void {
  cfg.data = cfg.data ?? {};
  cfg.onvif = cfg.onvif ?? {};

  if (patches.recordingMode !== undefined) {
    cfg.data.always_recording =
      patches.recordingMode === "always" || patches.recordingMode === "both";
    cfg.data.event_recording =
      patches.recordingMode === "event" || patches.recordingMode === "both";
  }
  if (patches.eventRecordLengthSecs !== undefined) {
    cfg.data.event_record_length_secs = patches.eventRecordLengthSecs;
  }
  if (patches.recordBufferLengthSecs !== undefined) {
    cfg.data.record_buffer_length_secs = patches.recordBufferLengthSecs;
  }
  if (patches.defaultGovLength !== undefined) {
    cfg.onvif.default_gov_length = patches.defaultGovLength;
  }
  if (patches.supportedVideoCodecs !== undefined) {
    cfg.data.supported_video_codecs = patches.supportedVideoCodecs;
  }
  if (patches.storageThresholdPercentage !== undefined) {
    cfg.data.storage_threshold_percentage = patches.storageThresholdPercentage;
  }
  if (patches.storageMonitoringFrequencySecs !== undefined) {
    cfg.data.storage_monitoring_frequency_secs =
      patches.storageMonitoringFrequencySecs;
  }
  if (patches.defaultFileExpiryMinutes !== undefined) {
    cfg.data.default_file_expiry_minutes = patches.defaultFileExpiryMinutes;
  }
  if (patches.enableAgingPolicy !== undefined) {
    cfg.data.enable_aging_policy = patches.enableAgingPolicy;
  }
  if (patches.recorderEnableFrameDrop !== undefined) {
    cfg.data.recorder_enable_frame_drop = patches.recorderEnableFrameDrop;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function deriveRecordingMode(cfg: VstConfigJson): "always" | "event" | "both" {
  const always = cfg.data?.always_recording ?? true;
  const event = cfg.data?.event_recording ?? false;
  if (always && event) return "both";
  if (event) return "event";
  return "always";
}

function filterCodecs(raw: string[] | undefined): ("h264" | "h265")[] {
  const allowed = new Set<string>(["h264", "h265"]);
  return (raw ?? ["h264", "h265"]).filter((c): c is "h264" | "h265" =>
    allowed.has(c.toLowerCase())
  );
}

/**
 * Sensor and streamprocessing each hold their own copy of vst_config.json on
 * the Helm path (see cluster-refs.ts). They're expected to stay identical for
 * the recorder-related fields this route writes — best-effort check so a
 * repeat of the 2026-07-01 drift (one ConfigMap patched, the other left
 * stale) surfaces in the UI instead of silently no-op'ing.
 */
async function checkRecorderDrift(sensorCfg: VstConfigJson): Promise<string[]> {
  if (CLUSTER.vst.streamProcessingConfigMap === CLUSTER.vst.sensorConfigMap) {
    return [];
  }
  try {
    const { value: spCfg } = await readConfigMapKey<VstConfigJson>(
      CLUSTER.vst.namespace,
      CLUSTER.vst.streamProcessingConfigMap,
      CLUSTER.vst.configKey
    );
    const sensorDrop = sensorCfg.data?.recorder_enable_frame_drop ?? false;
    const spDrop = spCfg.data?.recorder_enable_frame_drop ?? false;
    if (sensorDrop !== spDrop) {
      const msg = `Config drift: recorderEnableFrameDrop is ${sensorDrop} in ${CLUSTER.vst.sensorConfigMap} but ${spDrop} in ${CLUSTER.vst.streamProcessingConfigMap} — streamprocessing reads its own copy. Save this form again to resync both.`;
      log.warn(msg);
      return [msg];
    }
    return [];
  } catch {
    return [];
  }
}

/** Fetch the VST sensor list with a 2 s timeout. Returns null on any failure. */
async function fetchSensorList(): Promise<SensorEntry[] | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2_000);
    const resp = await fetch(CLUSTER.vst.sensorListUrl, {
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!resp.ok) return null;
    const data: unknown = await resp.json();
    // The endpoint may return { sensors: [...] } or just an array directly.
    if (Array.isArray(data)) return data as SensorEntry[];
    if (data && typeof data === "object") {
      const obj = data as Record<string, unknown>;
      if (Array.isArray(obj.sensors)) return obj.sensors as SensorEntry[];
      if (Array.isArray(obj.data)) return obj.data as SensorEntry[];
    }
    return null;
  } catch {
    return null;
  }
}

function parseSensorList(
  entries: SensorEntry[]
): Array<{ sensorId: string; name: string; state: string; bitrateMbps: number; gop: number }> {
  const result: Array<{
    sensorId: string;
    name: string;
    state: string;
    bitrateMbps: number;
    gop: number;
  }> = [];
  for (const s of entries) {
    const sensorId = String(s.sensor_id ?? s.sensorId ?? s.id ?? "");
    if (!sensorId) continue;
    // VST's /sensor/list is a device registry: it carries name + state but no
    // live ingest stats. bitrate/gop stay 0 here (live codec/bitrate is enriched
    // from mediamtx on the Cameras page) — only surface them if a source ever does.
    const name = typeof s.name === "string" ? s.name : "";
    const state = typeof s.state === "string" ? s.state : "";
    const bitrateMbps =
      typeof s.bitrate_mbps === "number"
        ? s.bitrate_mbps
        : typeof s.bitrate_kbps === "number"
        ? s.bitrate_kbps / 1000
        : 0;
    const gop =
      typeof s.gov_length === "number"
        ? s.gov_length
        : typeof s.gop === "number"
        ? s.gop
        : 0;
    result.push({ sensorId, name, state, bitrateMbps, gop });
  }
  return result;
}

// ─── Docker helpers ───────────────────────────────────────────────────────────

// ─── GET ──────────────────────────────────────────────────────────────────────

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });


  let cfg: VstConfigJson;
  try {
    const { value } = await readConfigMapKey<VstConfigJson>(
      CLUSTER.vst.namespace,
      CLUSTER.vst.sensorConfigMap,
      CLUSTER.vst.configKey
    );
    cfg = value;
  } catch (err: unknown) {
    const { status, message } = extractK8sError(err);
    return NextResponse.json(
      { error: message, k8sCode: status },
      { status }
    );
  }

  // Fetch observed sensor data best-effort (2 s timeout).
  const sensorEntries = await fetchSensorList();
  let observed: VstTuningResponse["observed"] | undefined;
  if (sensorEntries !== null) {
    const sensors = parseSensorList(sensorEntries);
    if (sensors.length > 0) {
      observed = { sensors };
    }
  } else {
    log.warn("VST sensor list unavailable — omitting observed field");
  }

  const warnings = await checkRecorderDrift(cfg);

  const response: VstTuningResponse = {
    recordingMode: deriveRecordingMode(cfg),
    eventRecordLengthSecs: cfg.data?.event_record_length_secs ?? 10,
    recordBufferLengthSecs: cfg.data?.record_buffer_length_secs ?? 0,
    defaultGovLength: cfg.onvif?.default_gov_length ?? 60,
    supportedVideoCodecs: filterCodecs(cfg.data?.supported_video_codecs),
    storageThresholdPercentage: cfg.data?.storage_threshold_percentage ?? 95,
    storageMonitoringFrequencySecs: cfg.data?.storage_monitoring_frequency_secs ?? 2,
    defaultFileExpiryMinutes: cfg.data?.default_file_expiry_minutes ?? 10080,
    enableAgingPolicy: cfg.data?.enable_aging_policy ?? false,
    recorderEnableFrameDrop: cfg.data?.recorder_enable_frame_drop ?? false,
    ...(observed ? { observed } : {}),
  };

  return NextResponse.json({
    ...response,
    ...(warnings.length ? { warnings } : {}),
  });
}

// ─── PATCH ────────────────────────────────────────────────────────────────────

export const PATCH = withRequestContext(async function (req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const blocked = await rejectIfKiosk();
  if (blocked) return blocked;

  const body: unknown = await req.json().catch(() => null);

  // Guard: reject explicit cloud_storage_* keys before Zod touches the body.
  if (body && typeof body === "object") {
    const keys = Object.keys(body as Record<string, unknown>);
    const forbidden = keys.filter((k) => CLOUD_STORAGE_FIELDS.includes(k));
    if (forbidden.length > 0) {
      return NextResponse.json(
        {
          error: `cloud_storage_* fields are out of scope for this route. Manage S3 credentials at /secrets.`,
          forbidden,
        },
        { status: 400 }
      );
    }
  }

  const parsed = VstTuningPatchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", issues: parsed.error.issues },
      { status: 400 }
    );
  }
  const patches = parsed.data;


  // Sensor and streamprocessing each hold their own copy of vst_config.json
  // on the Helm path (identical on legacy, where both point at "vst-config")
  // — patch every distinct ConfigMap so they can't drift apart. Each target
  // is read/mutated/written independently so unrelated fields already set
  // differently per-component (if any) are preserved rather than clobbered.
  const configMapTargets = Array.from(
    new Set([CLUSTER.vst.sensorConfigMap, CLUSTER.vst.streamProcessingConfigMap])
  );

  for (const configMap of configMapTargets) {
    let cfg: VstConfigJson;
    let resourceVersion: string | undefined;
    try {
      const result = await readConfigMapKey<VstConfigJson>(
        CLUSTER.vst.namespace,
        configMap,
        CLUSTER.vst.configKey
      );
      cfg = result.value;
      resourceVersion = result.resourceVersion;
    } catch (err: unknown) {
      const { status, message } = extractK8sError(err);
      return NextResponse.json(
        { error: `${message} (configmap/${configMap})`, k8sCode: status },
        { status }
      );
    }

    applyVstPatches(cfg, patches);

    try {
      await patchConfigMapRawKey(
        CLUSTER.vst.namespace,
        configMap,
        CLUSTER.vst.configKey,
        JSON.stringify(cfg, null, 2),
        resourceVersion
      );
    } catch (err: unknown) {
      const { status, message } = extractK8sError(err);
      return NextResponse.json(
        { error: `${message} (configmap/${configMap})`, k8sCode: status },
        { status }
      );
    }
  }

  // Rollout-restart both VST components, using each one's actual resource
  // kind — streamprocessing is a StatefulSet on the Helm path, not a
  // Deployment (verified against the live cluster; legacy keeps both as
  // Deployments).
  const restarts: Array<{ kind: "Deployment" | "StatefulSet"; name: string }> = [
    { kind: CLUSTER.vst.sensorKind, name: CLUSTER.vst.sensorDeployment },
    {
      kind: CLUSTER.vst.streamProcessingKind,
      name: CLUSTER.vst.streamProcessingDeployment,
    },
  ];
  for (const { kind, name } of restarts) {
    try {
      await rolloutRestart(kind, CLUSTER.vst.namespace, name);
    } catch (err) {
      return NextResponse.json(
        {
          error: `Rollout restart of ${kind.toLowerCase()}/${name} failed: ${String(err)}`,
        },
        { status: 502 }
      );
    }
  }

  await auditLog("tuning-vst", `configmap/${configMapTargets.join(",")}`, {
    patches,
  });

  return NextResponse.json({ ok: true, applied: patches });
});

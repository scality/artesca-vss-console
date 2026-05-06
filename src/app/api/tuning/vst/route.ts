import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { z } from "zod";
import { rolloutRestart } from "@/lib/k8s";
import { readConfigMapKey, patchConfigMapRawKey } from "@/lib/helpers/configmaps";
import { auditLog } from "@/lib/helpers/audit";
import { CLUSTER } from "@/lib/cluster-refs";
import {
  execInContainer,
  dockerSock,
  DOCKER_TUNING_DIR,
} from "@/lib/helpers/docker-sock";
import fs from "fs/promises";
import path from "node:path";

export const dynamic = "force-dynamic";

const DOCKER_MODE = process.env.CONSOLE_RUNTIME === "docker";
const VST_SENSOR_CONTAINER = "sensor-ms-dev";
const VST_STREAM_CONTAINER = "streamprocessing-ms-dev";
// Config file path inside sensor-ms-dev (bind-mounted from host via VST_CONFIG_PATH).
// Verified against refs/video-search-and-summarization/deployments/vst/developer/vst/docker-compose.yaml volumes:.
const VST_DOCKER_CONFIG_PATH = "/home/vst/vst_release/configs/vst_config.json";
const VST_PERSIST_FILE = path.join(DOCKER_TUNING_DIR, "vst.json");

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

// ─── Sensor list response shape (best-effort) ─────────────────────────────────

interface SensorEntry {
  sensor_id?: string;
  sensorId?: string;
  id?: string;
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
    sensors: Array<{ sensorId: string; bitrateMbps: number; gop: number }>;
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
): Array<{ sensorId: string; bitrateMbps: number; gop: number }> {
  const result: Array<{ sensorId: string; bitrateMbps: number; gop: number }> = [];
  for (const s of entries) {
    const sensorId = String(s.sensor_id ?? s.sensorId ?? s.id ?? "");
    if (!sensorId) continue;
    // bitrate: prefer bitrate_mbps, else convert bitrate_kbps / 1000
    const bitrateMbps =
      typeof s.bitrate_mbps === "number"
        ? s.bitrate_mbps
        : typeof s.bitrate_kbps === "number"
        ? s.bitrate_kbps / 1000
        : 0;
    // gop: accept gov_length or gop
    const gop =
      typeof s.gov_length === "number"
        ? s.gov_length
        : typeof s.gop === "number"
        ? s.gop
        : 0;
    result.push({ sensorId, bitrateMbps, gop });
  }
  return result;
}

// ─── Docker helpers ───────────────────────────────────────────────────────────

async function readVstConfigDocker(): Promise<VstConfigJson | null> {
  const raw = await execInContainer(VST_SENSOR_CONTAINER, ["cat", VST_DOCKER_CONFIG_PATH]);
  if (raw === null) return null;
  try {
    return JSON.parse(raw.trim()) as VstConfigJson;
  } catch {
    return null;
  }
}

async function writeVstConfigDocker(cfg: VstConfigJson): Promise<void> {
  const json = JSON.stringify(cfg, null, 2);
  const b64 = Buffer.from(json).toString("base64");
  const result = await execInContainer(VST_SENSOR_CONTAINER, [
    "sh",
    "-c",
    `printf '%s' '${b64}' | base64 -d > '${VST_DOCKER_CONFIG_PATH}'`,
  ]);
  if (result === null) throw new Error(`exec write to ${VST_DOCKER_CONFIG_PATH} failed`);
  // Also persist backup for GET fallback when containers are stopped.
  await fs.mkdir(DOCKER_TUNING_DIR, { recursive: true });
  await fs.writeFile(VST_PERSIST_FILE, json, "utf-8");
}

async function readPersistedVstConfig(): Promise<VstConfigJson | null> {
  try {
    const raw = await fs.readFile(VST_PERSIST_FILE, "utf-8");
    return JSON.parse(raw) as VstConfigJson;
  } catch {
    return null;
  }
}

// ─── GET ──────────────────────────────────────────────────────────────────────

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (DOCKER_MODE) {
    const cfg = (await readVstConfigDocker()) ?? (await readPersistedVstConfig()) ?? {};
    const warnings: string[] = [];
    if (!cfg || Object.keys(cfg).length === 0) {
      warnings.push("sensor-ms-dev container not running and no persisted config — showing defaults");
    }
    const sensorEntries = await fetchSensorList();
    let observed: VstTuningResponse["observed"] | undefined;
    if (sensorEntries !== null) {
      const sensors = parseSensorList(sensorEntries);
      if (sensors.length > 0) observed = { sensors };
    }
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
    return NextResponse.json({ ...response, runtime: "docker", ...(warnings.length ? { warnings } : {}) });
  }

  let cfg: VstConfigJson;
  try {
    const { value } = await readConfigMapKey<VstConfigJson>(
      CLUSTER.vst.namespace,
      CLUSTER.vst.configMap,
      CLUSTER.vst.configKey
    );
    cfg = value;
  } catch (err: unknown) {
    const k8sErr = err as { statusCode?: number; body?: { message?: string } };
    return NextResponse.json(
      { error: k8sErr.body?.message ?? String(err), k8sCode: k8sErr.statusCode },
      { status: k8sErr.statusCode ?? 502 }
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
    console.warn("[tuning/vst] GET: VST sensor list unavailable — omitting observed field");
  }

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

  return NextResponse.json(response);
}

// ─── PATCH ────────────────────────────────────────────────────────────────────

export async function PATCH(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

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

  if (DOCKER_MODE) {
    const current = (await readVstConfigDocker()) ?? (await readPersistedVstConfig()) ?? {};
    const cfg: VstConfigJson = { ...current };
    cfg.data = cfg.data ?? {};
    cfg.onvif = cfg.onvif ?? {};

    if (patches.recordingMode !== undefined) {
      cfg.data.always_recording = patches.recordingMode === "always" || patches.recordingMode === "both";
      cfg.data.event_recording = patches.recordingMode === "event" || patches.recordingMode === "both";
    }
    if (patches.eventRecordLengthSecs !== undefined) cfg.data.event_record_length_secs = patches.eventRecordLengthSecs;
    if (patches.recordBufferLengthSecs !== undefined) cfg.data.record_buffer_length_secs = patches.recordBufferLengthSecs;
    if (patches.defaultGovLength !== undefined) cfg.onvif.default_gov_length = patches.defaultGovLength;
    if (patches.supportedVideoCodecs !== undefined) cfg.data.supported_video_codecs = patches.supportedVideoCodecs;
    if (patches.storageThresholdPercentage !== undefined) cfg.data.storage_threshold_percentage = patches.storageThresholdPercentage;
    if (patches.storageMonitoringFrequencySecs !== undefined) cfg.data.storage_monitoring_frequency_secs = patches.storageMonitoringFrequencySecs;
    if (patches.defaultFileExpiryMinutes !== undefined) cfg.data.default_file_expiry_minutes = patches.defaultFileExpiryMinutes;
    if (patches.enableAgingPolicy !== undefined) cfg.data.enable_aging_policy = patches.enableAgingPolicy;
    if (patches.recorderEnableFrameDrop !== undefined) cfg.data.recorder_enable_frame_drop = patches.recorderEnableFrameDrop;

    try {
      await writeVstConfigDocker(cfg);
    } catch (err) {
      return NextResponse.json(
        { error: `VST config write failed: ${String(err)}`, runtime: "docker" },
        { status: 502 },
      );
    }

    const restartErrors: string[] = [];
    for (const container of [VST_SENSOR_CONTAINER, VST_STREAM_CONTAINER]) {
      try {
        await dockerSock("POST", `/containers/${encodeURIComponent(container)}/restart?t=10`, undefined, 30_000);
      } catch (err) {
        restartErrors.push(`${container}: ${String(err)}`);
      }
    }

    await auditLog("tuning-vst", `docker/${VST_SENSOR_CONTAINER}`, { patches });
    return NextResponse.json({
      ok: true,
      applied: patches,
      runtime: "docker",
      ...(restartErrors.length ? { restartErrors } : {}),
    });
  }

  // Read current ConfigMap JSON.
  let cfg: VstConfigJson;
  let resourceVersion: string | undefined;
  try {
    const result = await readConfigMapKey<VstConfigJson>(
      CLUSTER.vst.namespace,
      CLUSTER.vst.configMap,
      CLUSTER.vst.configKey
    );
    cfg = result.value;
    resourceVersion = result.resourceVersion;
  } catch (err: unknown) {
    const k8sErr = err as { statusCode?: number; body?: { message?: string } };
    return NextResponse.json(
      { error: k8sErr.body?.message ?? String(err), k8sCode: k8sErr.statusCode },
      { status: k8sErr.statusCode ?? 502 }
    );
  }

  // Ensure nested objects exist.
  cfg.data = cfg.data ?? {};
  cfg.onvif = cfg.onvif ?? {};

  // Apply mutations.
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
    cfg.data.storage_monitoring_frequency_secs = patches.storageMonitoringFrequencySecs;
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

  // Write back as JSON string.
  try {
    await patchConfigMapRawKey(
      CLUSTER.vst.namespace,
      CLUSTER.vst.configMap,
      CLUSTER.vst.configKey,
      JSON.stringify(cfg, null, 2),
      resourceVersion
    );
  } catch (err: unknown) {
    const k8sErr = err as { statusCode?: number; body?: { message?: string } };
    return NextResponse.json(
      { error: k8sErr.body?.message ?? String(err), k8sCode: k8sErr.statusCode },
      { status: k8sErr.statusCode ?? 502 }
    );
  }

  // Rollout-restart both VST deployments to pick up the new config.
  const deployments = [
    CLUSTER.vst.sensorDeployment,
    CLUSTER.vst.streamProcessingDeployment,
  ];
  for (const dep of deployments) {
    try {
      await rolloutRestart("Deployment", CLUSTER.vst.namespace, dep);
    } catch (err) {
      return NextResponse.json(
        { error: `Rollout restart of ${dep} failed: ${String(err)}` },
        { status: 502 }
      );
    }
  }

  await auditLog("tuning-vst", `configmap/${CLUSTER.vst.configMap}`, {
    patches,
  });

  return NextResponse.json({ ok: true, applied: patches });
}

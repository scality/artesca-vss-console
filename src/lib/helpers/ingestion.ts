import "server-only";
import { CLUSTER } from "../cluster-refs";
import { readConfigMapKey } from "@/lib/helpers/configmaps";
import { vstListSensors } from "@/lib/helpers/vst";
import {
  listRealtimeRules,
  addRealtimeRule,
  deleteRealtimeRule,
} from "@/lib/helpers/alert-bridge";
import { createLogger } from "@/lib/logger";

const log = createLogger("ingestion");

// VLM ingestion = whether a camera has an active realtime alert rule on the
// alert-bridge (the rule that drives the VLM to analyze the stream and emit
// incidents). Distinct from *recording* (VST writing the stream to the
// objectstore). A camera can record without being ingested and vice-versa.

interface RulesDoc {
  model?: string;
  system_prompt?: string;
  chunk_duration?: number;
  chunk_overlap_duration?: number;
  enable_reasoning?: boolean;
  num_frames_per_second_or_fixed_frames_chunk?: number;
  use_fps_for_chunking?: boolean;
  rules?: Array<{
    sensor: string;
    alert_type: string;
    prompt: string;
    stream_url?: string;
  }>;
}

/** Set of camera ids (= VST sensor names) that currently have an active
 *  realtime rule. Fail-soft: empty set + warning on any error. */
export async function listIngestingCameras(): Promise<{
  ingesting: Set<string>;
  warning?: string;
}> {
  const { rules, warning } = await listRealtimeRules();
  const ingesting = new Set<string>();
  for (const r of rules) {
    if (r.sensor_name) ingesting.add(r.sensor_name);
  }
  return { ingesting, warning };
}

/** Resolve the VST stream id (UUID) for a camera id (= sensor name). */
async function resolveStreamId(cameraId: string): Promise<string | undefined> {
  const { sensors } = await vstListSensors();
  const match = sensors.find((s) => s.sensor_id === cameraId);
  // vstListSensors maps sensor_id ← name and stashes the real UUID under streamId.
  const sid = (match as { streamId?: unknown } | undefined)?.streamId;
  return typeof sid === "string" ? sid : undefined;
}

/** Read the canonical rule spec (alert_type / prompt / stream_url + globals)
 *  for a camera from the realtime-alert-rules ConfigMap. */
async function readRuleSpec(cameraId: string): Promise<{
  doc?: RulesDoc;
  rule?: NonNullable<RulesDoc["rules"]>[number];
}> {
  try {
    const { value } = await readConfigMapKey<RulesDoc>(
      CLUSTER.alertBridge.rulesNamespace,
      CLUSTER.alertBridge.rulesConfigMap,
      "rules.json",
    );
    const rule = value.rules?.find((r) => r.sensor === cameraId);
    return { doc: value, rule };
  } catch (err) {
    log.warn("rules CM read failed", { err });
    return {};
  }
}

/** Turn VLM ingestion on or off for a camera.
 *  enable  → create a realtime rule (spec from the CM, stream id from VST).
 *  disable → delete every realtime rule bound to this camera's sensor name.
 *  Fail-soft: returns ok:false + warning, never throws. */
export async function setIngestion(
  cameraId: string,
  enabled: boolean,
  rtspUrl?: string,
): Promise<{ ok: boolean; warning?: string }> {
  if (!enabled) {
    const { rules, warning } = await listRealtimeRules();
    if (warning) return { ok: false, warning };
    const mine = rules.filter((r) => r.sensor_name === cameraId && r.id);
    if (mine.length === 0) return { ok: true }; // already not ingesting
    const warnings: string[] = [];
    for (const r of mine) {
      const res = await deleteRealtimeRule(r.id);
      if (!res.ok && res.warning) warnings.push(res.warning);
    }
    return warnings.length ? { ok: false, warning: warnings.join("; ") } : { ok: true };
  }

  // enable
  const { doc, rule } = await readRuleSpec(cameraId);
  const streamUrl = rule?.stream_url || rtspUrl;
  if (!streamUrl) {
    return {
      ok: false,
      warning: `no stream URL for ${cameraId} (not in realtime-alert-rules CM and no rtspUrl)`,
    };
  }
  const sensorId = await resolveStreamId(cameraId);
  const res = await addRealtimeRule({
    streamUrl,
    alertType: rule?.alert_type ?? "general-activity",
    prompt: rule?.prompt ?? "Alert on any notable or anomalous activity.",
    sensorName: cameraId,
    sensorId,
    systemPrompt: doc?.system_prompt,
    model: doc?.model,
    chunkDuration: doc?.chunk_duration,
    chunkOverlapDuration: doc?.chunk_overlap_duration,
    enableReasoning: doc?.enable_reasoning,
    numFramesPerSecondOrFixedFramesChunk: doc?.num_frames_per_second_or_fixed_frames_chunk,
    useFpsForChunking: doc?.use_fps_for_chunking,
  });
  return { ok: res.ok, warning: res.warning };
}

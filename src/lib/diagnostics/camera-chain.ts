import "server-only";
import { CLUSTER } from "../cluster-refs";
import { vstListSensors } from "@/lib/helpers/vst";
import { probeRecording } from "@/lib/helpers/recording-health";
import { listRealtimeRules } from "@/lib/helpers/alert-bridge";
import { liveVlmModelId } from "@/lib/helpers/ingestion";
import { collectStoragePreflight, type StoragePreflight } from "./storage-preflight";
import { createLogger } from "@/lib/logger";

const log = createLogger("camera-chain");

// A camera only produces incidents-with-video when SIX things hold at once.
// Each has failed in production, and each failed silently — the Cameras page
// showed the same grey chip for "the bar is unplugged", "the recorder's S3
// credentials are dead" and "the alert rule names a model the VLM doesn't
// serve". This walks the chain and names the first broken link.
//
// Deliberately ordered: an earlier failure explains every later one, so only
// the first is reported as the verdict and the rest are marked "blocked".

export type StepState = "ok" | "fail" | "warn" | "blocked" | "unknown";

export type StepId =
  | "source"
  | "sensor"
  | "stream"
  | "recording"
  | "rule"
  | "scenario";

export interface ChainStep {
  id: StepId;
  label: string;
  state: StepState;
  /** What was observed — shown under the step. */
  detail?: string;
  /** What to do about it. Only set when the step is not ok. */
  fix?: string;
}

export interface CameraChain {
  cameraId: string;
  rtspUrl?: string;
  steps: ChainStep[];
  /** The first broken link, or undefined when the whole chain is healthy. */
  verdict?: { state: StepState; reason: string; fix?: string };
}

export interface CameraChainReport {
  cameras: CameraChain[];
  storage: StoragePreflight;
  checkedAt: string;
  warnings: string[];
}

export interface DesiredCamera {
  id: string;
  rtspUrl?: string;
}

export interface ScenarioBinding {
  id: string;
  enabled: boolean;
  /** Comma-separated sensor names, empty string = all cameras. */
  sensorFilter: string;
}

/** Cameras a scenario targets. An empty filter means "every camera". */
function scenarioTargets(s: ScenarioBinding): string[] | "all" {
  const raw = (s.sensorFilter ?? "").trim();
  if (!raw) return "all";
  return raw.split(",").map((v) => v.trim()).filter(Boolean);
}

/**
 * Build the per-camera diagnosis. Pure over its inputs so the ordering and
 * blocked-propagation rules are unit-testable without a cluster.
 */
export function buildCameraChain(input: {
  camera: DesiredCamera;
  registered: boolean;
  streamId?: string;
  recording: "recording" | "not-recording" | "unknown";
  rules: Array<{ sensor_name?: string; alert_type?: string; model?: string; id?: string }>;
  liveModel?: string;
  scenarios: ScenarioBinding[];
  storageOk: boolean;
  storageReason?: string;
}): CameraChain {
  const { camera, registered, streamId, recording, rules, liveModel, scenarios } = input;
  const steps: ChainStep[] = [];

  // 1. Source — we cannot dial RTSP from here cheaply, so this reports whether
  //    a URL is even known. A dead source shows up as step 4 (no segments).
  steps.push(
    camera.rtspUrl
      ? { id: "source", label: "RTSP source", state: "ok", detail: camera.rtspUrl }
      : {
          id: "source",
          label: "RTSP source",
          state: "fail",
          detail: "no RTSP URL recorded for this camera",
          fix: "Set the camera's RTSP URL in the config store (Cameras → edit).",
        },
  );

  // 2. Sensor registered in VST.
  steps.push(
    registered
      ? { id: "sensor", label: "Registered in VST", state: "ok", detail: streamId }
      : {
          id: "sensor",
          label: "Registered in VST",
          state: "fail",
          detail: "no VST sensor with this name",
          fix: "Use Re-register on this camera (sensor/add + proxy/stream/add).",
        },
  );

  // 3. Stream armed. VST keys the recording pipeline by the sensor's UUID, and
  //    re-registering mints a NEW UUID — arming against the old one is accepted
  //    and then silently records nothing. Without a UUID there is nothing armed.
  steps.push(
    registered && streamId
      ? { id: "stream", label: "Stream armed", state: "ok", detail: `stream ${streamId.slice(0, 8)}…` }
      : {
          id: "stream",
          label: "Stream armed",
          state: registered ? "fail" : "blocked",
          detail: registered ? "sensor has no stream id" : "needs a registered sensor",
          fix: registered ? "Use Re-register — arming must target the sensor's current UUID." : undefined,
        },
  );

  // 4. Recording — ground-truthed against VST storage, not the isTimelinePresent
  //    flag (which reads stale-true while nothing is written).
  if (!input.storageOk) {
    steps.push({
      id: "recording",
      label: "Recording to ARTESCA S3",
      state: "fail",
      detail: input.storageReason ?? "object storage unavailable",
      fix: "Fix object storage first — no camera can record until then (see Storage below).",
    });
  } else if (!registered || !streamId) {
    steps.push({
      id: "recording",
      label: "Recording to ARTESCA S3",
      state: "blocked",
      detail: "needs an armed stream",
    });
  } else {
    steps.push(
      recording === "recording"
        ? { id: "recording", label: "Recording to ARTESCA S3", state: "ok", detail: "segments present" }
        : recording === "unknown"
          ? {
              id: "recording",
              label: "Recording to ARTESCA S3",
              state: "unknown",
              detail: "storage probe unreachable",
            }
          : {
              id: "recording",
              label: "Recording to ARTESCA S3",
              state: "fail",
              detail: "no segments written in the probe window",
              fix: "Use Re-register to re-arm the recorder against the sensor's current UUID.",
            },
    );
  }

  // 5. VLM rule — present, unique, and naming a model the VLM actually serves.
  const mine = rules.filter((r) => r.sensor_name === camera.id);
  if (mine.length === 0) {
    steps.push({
      id: "rule",
      label: "VLM analysis rule",
      state: "fail",
      detail: "no realtime alert rule — this camera is recorded but never analyzed",
      fix: "Enable ingestion on this camera.",
    });
  } else {
    const badModel = liveModel
      ? mine.find((r) => r.model && r.model !== liveModel)
      : undefined;
    if (badModel) {
      steps.push({
        id: "rule",
        label: "VLM analysis rule",
        state: "fail",
        detail: `rule names model "${badModel.model}" but the VLM serves "${liveModel}"`,
        fix: "Toggle ingestion off and on — the rule is recreated against the live model.",
      });
    } else if (mine.length > 1) {
      steps.push({
        id: "rule",
        label: "VLM analysis rule",
        state: "warn",
        detail: `${mine.length} duplicate rules — this camera is captioned ${mine.length}× on the same GPU`,
        fix: "The reconciler dedupes automatically; if it persists, toggle ingestion off and on.",
      });
    } else {
      steps.push({
        id: "rule",
        label: "VLM analysis rule",
        state: "ok",
        detail: mine[0].alert_type,
      });
    }
  }

  // 6. Scenario binding — a camera analyzed under no enabled scenario produces
  //    captions that never become incidents.
  const bound = scenarios.filter((s) => {
    if (!s.enabled) return false;
    const t = scenarioTargets(s);
    return t === "all" || t.includes(camera.id);
  });
  steps.push(
    bound.length > 0
      ? {
          id: "scenario",
          label: "Scenario binding",
          state: "ok",
          detail: bound.map((s) => s.id).join(", "),
        }
      : {
          id: "scenario",
          label: "Scenario binding",
          state: "warn",
          detail: "no enabled scenario targets this camera — it will raise no incidents",
          fix: "Add this camera to a scenario's sensor list, or enable a scenario that covers it.",
        },
  );

  // Verdict = first genuinely broken link (blocked steps are consequences).
  const firstBad = steps.find((s) => s.state === "fail") ?? steps.find((s) => s.state === "warn");
  const verdict = firstBad
    ? { state: firstBad.state, reason: firstBad.detail ?? firstBad.label, fix: firstBad.fix }
    : undefined;

  return { cameraId: camera.id, rtspUrl: camera.rtspUrl, steps, verdict };
}

/** Collect the live report. Fail-soft throughout — a broken probe degrades a
 *  step to `unknown`, never takes the page down. */
export async function collectCameraChains(input: {
  desired: DesiredCamera[];
  scenarios: ScenarioBinding[];
}): Promise<CameraChainReport> {
  const warnings: string[] = [];
  const checkedAt = new Date().toISOString();

  const [storage, sensorsRes, rulesRes, liveModel] = await Promise.all([
    collectStoragePreflight().catch((err) => {
      warnings.push(`storage preflight failed: ${String(err)}`);
      return {
        state: "unknown" as const,
        reason: "preflight failed",
        checkedAt,
      } satisfies StoragePreflight;
    }),
    vstListSensors().catch((err) => {
      warnings.push(`VST sensor list failed: ${String(err)}`);
      return { sensors: [], warning: String(err) };
    }),
    listRealtimeRules().catch((err) => {
      warnings.push(`alert-bridge rule list failed: ${String(err)}`);
      return { rules: [], warning: String(err) };
    }),
    liveVlmModelId(),
  ]);

  if (sensorsRes.warning) warnings.push(sensorsRes.warning);
  if (rulesRes.warning) warnings.push(rulesRes.warning);
  if (!liveModel) warnings.push("VLM model list unreadable — model drift not checked");

  // name -> streamId for sensors VST considers live.
  const byName = new Map<string, string>();
  for (const s of sensorsRes.sensors) {
    const name = s.name ?? (s as { sensor_id?: string }).sensor_id;
    const sid = String((s as { streamId?: unknown }).streamId ?? "");
    if (typeof name === "string" && name && !byName.has(name)) byName.set(name, sid);
  }

  const storageOk = storage.state === "ok";

  const cameras = await Promise.all(
    input.desired.map(async (camera) => {
      const streamId = byName.get(camera.id);
      const registered = streamId !== undefined;
      // Skip the storage probe entirely when the backend is down — it would
      // return not-recording for every camera and bury the real cause.
      let recording: "recording" | "not-recording" | "unknown" = "unknown";
      if (storageOk && streamId) {
        recording = await probeRecording(streamId).catch(() => "unknown");
      }
      return buildCameraChain({
        camera,
        registered,
        streamId,
        recording,
        rules: rulesRes.rules ?? [],
        liveModel,
        scenarios: input.scenarios,
        storageOk,
        storageReason: storage.reason,
      });
    }),
  );

  log.info("camera chain collected", {
    cameras: cameras.length,
    storage: storage.state,
    unhealthy: cameras.filter((c) => c.verdict).length,
  });

  return { cameras, storage, checkedAt, warnings };
}

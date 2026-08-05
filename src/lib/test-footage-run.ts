import "server-only";
import { registerSensorAndArm } from "@/lib/helpers/vst-register";
import { vstDeleteSensor, vstListSensors } from "@/lib/helpers/vst";
import { setIngestion } from "@/lib/helpers/ingestion";
import {
  footageCameraId,
  footageRtspUrl,
  isFootageCamera,
  sanitiseFilename,
  type PlaybackMode,
} from "@/lib/test-footage";
import { createLogger } from "@/lib/logger";

const log = createLogger("test-footage-run");

// Starting a run means putting the file through exactly the path a real camera
// takes, so nothing about the test is special-cased downstream:
//
//   register in VST (+ arm the recorder)  →  enable VLM ingestion  →  scenarios
//
// Both steps reuse the shared helpers, so a test run exercises the same code an
// operator's camera does — including the UUID arming rule that silently broke
// recording when it was duplicated.

export interface RunRequest {
  fileName: string;
  mode: PlaybackMode;
  /** Stop ingesting the live cameras for the duration of the run. */
  pauseLive: boolean;
}

export interface RunResult {
  cameraId: string;
  rtspUrl: string;
  /** Live cameras whose ingestion this run turned off, to restore on stop. */
  pausedCameras: string[];
  warnings: string[];
}

/** Cameras currently being analysed that are NOT test footage. */
async function liveIngestingCameras(): Promise<string[]> {
  const { listIngestingCameras } = await import("@/lib/helpers/ingestion");
  const { ingesting } = await listIngestingCameras();
  return [...ingesting].filter((id) => !isFootageCamera(id));
}

/**
 * Bring a footage file up as a camera.
 *
 * The GPU is the binding constraint on the converged node — five live cameras
 * already saturate it — so `pauseLive` stops the live cameras' VLM ingestion
 * first. That is what makes a prompt comparison meaningful: without it, VLM
 * latency and the frames each stream gets vary with whatever else is running.
 * Recording of the live cameras is untouched; only their analysis pauses.
 */
export async function startRun(req: RunRequest): Promise<RunResult> {
  const fileName = sanitiseFilename(req.fileName);
  const cameraId = footageCameraId(fileName);
  const rtspUrl = footageRtspUrl(fileName, req.mode);
  const warnings: string[] = [];
  const pausedCameras: string[] = [];

  if (req.pauseLive) {
    for (const id of await liveIngestingCameras()) {
      const res = await setIngestion(id, false);
      if (res.ok) {
        pausedCameras.push(id);
      } else if (res.warning) {
        warnings.push(`could not pause ${id}: ${res.warning}`);
      }
    }
    log.info("paused live cameras for a footage run", { pausedCameras, cameraId });
  }

  const reg = await registerSensorAndArm({
    name: cameraId,
    rtspUrl,
    description: `Test footage: ${fileName} (${req.mode})`,
  });
  warnings.push(...reg.warnings);
  if (!reg.ok) {
    // Registration failed — put the live cameras back before surfacing it,
    // otherwise a failed test leaves the showroom half-off.
    await restoreCameras(pausedCameras);
    throw new Error(`could not register the footage camera: ${reg.warnings.join("; ") || "unknown"}`);
  }

  // Analysis on: this is what produces captions and therefore incidents.
  const ing = await setIngestion(cameraId, true, rtspUrl);
  if (!ing.ok && ing.warning) warnings.push(ing.warning);

  return { cameraId, rtspUrl, pausedCameras, warnings };
}

/** Re-enable ingestion on cameras a run paused. Best-effort per camera so one
 *  failure cannot leave the rest off. */
async function restoreCameras(ids: string[]): Promise<string[]> {
  const warnings: string[] = [];
  for (const id of ids) {
    const res = await setIngestion(id, true);
    if (!res.ok && res.warning) warnings.push(`could not resume ${id}: ${res.warning}`);
  }
  return warnings;
}

export interface StopResult {
  stopped: string[];
  resumed: string[];
  warnings: string[];
}

/**
 * Tear a run down: stop its analysis, de-register it from VST (which also stops
 * the on-demand ffmpeg, since nothing is reading the stream any more), and
 * resume whichever live cameras were paused.
 */
export async function stopRun(input: {
  cameraId?: string;
  resume: string[];
}): Promise<StopResult> {
  const warnings: string[] = [];
  const stopped: string[] = [];

  const { sensors } = await vstListSensors().catch(() => ({ sensors: [] }));
  // Stop the named run, or every test camera when none is named — the latter is
  // the "clean up after me" case an operator wants when a run was abandoned.
  const targets = sensors.filter((s) => {
    const name = s.sensor_id;
    if (!name || !isFootageCamera(name)) return false;
    return input.cameraId ? name === input.cameraId : true;
  });

  for (const s of targets) {
    const name = s.sensor_id as string;
    // Never let one teardown failure short-circuit the loop: the live cameras
    // are resumed below, and leaving the showroom's analysis off because a test
    // camera would not delete is the worst possible outcome here.
    try {
      const ing = await setIngestion(name, false);
      if (!ing?.ok && ing?.warning) warnings.push(`${name}: ${ing.warning}`);

      const uuid = String((s as { streamId?: unknown }).streamId ?? "") || name;
      const del = await vstDeleteSensor(uuid);
      if (!del?.ok && del?.warning) warnings.push(`${name}: ${del.warning}`);
      stopped.push(name);
    } catch (err) {
      warnings.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const resumeWarnings = await restoreCameras(input.resume);
  warnings.push(...resumeWarnings);

  log.info("footage run stopped", { stopped, resumed: input.resume });
  return { stopped, resumed: input.resume, warnings };
}

/** Test cameras currently registered in VST — the live runs. */
export async function listRuns(): Promise<Array<{ cameraId: string; streamId?: string }>> {
  const { sensors } = await vstListSensors().catch(() => ({ sensors: [] }));
  return sensors
    .filter((s) => s.sensor_id && isFootageCamera(s.sensor_id))
    .map((s) => ({
      cameraId: s.sensor_id as string,
      streamId: String((s as { streamId?: unknown }).streamId ?? "") || undefined,
    }));
}

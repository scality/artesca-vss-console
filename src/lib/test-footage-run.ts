import "server-only";
import { registerSensorAndArm } from "@/lib/helpers/vst-register";
import { vstDeleteSensor, vstListSensors } from "@/lib/helpers/vst";
import { setIngestion, suspendIngestion } from "@/lib/helpers/ingestion";
import {
  footageCameraId,
  footageRtspUrl,
  isFootageCamera,
  sanitiseFilename,
  type PlaybackMode,
} from "@/lib/test-footage";
import { createLogger } from "@/lib/logger";
import { CLUSTER } from "@/lib/cluster-refs";
import { readConfigMapKey, patchConfigMapRawKey } from "@/lib/helpers/configmaps";
import {
  deploymentExists,
  quiesceDeployment,
  rolloutRestart,
  scaleDeployment,
  waitForRollout,
} from "@/lib/k8s";

const log = createLogger("test-footage-run");

/** The watcher that re-seeds alert rules from the ConfigMap. */
const RECONCILER_DEPLOYMENT = process.env.VLM_RECONCILER_DEPLOYMENT ?? "vlm-stream-reconciler";

/**
 * Record (or clear) the sensors a run has paused, in the same rules ConfigMap
 * the vlm-stream-reconciler converges from.
 *
 * Without this the pause does not hold: the reconciler treats every sensor in
 * the CM as desired and re-seeds a rule for it within one 15 s tick, so the
 * live cameras were analysing again seconds after being paused and the clip
 * still competed for the GPU. The reconciler skips anything listed here.
 */
async function setPausedSensors(sensors: string[]): Promise<string | undefined> {
  // Writing the marker is not enough on its own. The reconciler reads the rules
  // document from a MOUNTED ConfigMap, and a mount takes 60-90s to reflect an
  // edit — so within its 15s tick it re-seeds the cameras from the stale copy
  // and the pause evaporates. A restart makes the NEW pod read the current
  // document; the pause path additionally quiesces the old one first (see
  // quiesceReconciler), because a restart alone leaves it running.
  try {
    const { value, resourceVersion } = await readConfigMapKey<Record<string, unknown>>(
      CLUSTER.alertBridge.rulesNamespace,
      CLUSTER.alertBridge.rulesConfigMap,
      "rules.json",
    );
    const doc = { ...value, paused_sensors: sensors };
    if (sensors.length === 0) delete (doc as { paused_sensors?: unknown }).paused_sensors;
    await patchConfigMapRawKey(
      CLUSTER.alertBridge.rulesNamespace,
      CLUSTER.alertBridge.rulesConfigMap,
      "rules.json",
      JSON.stringify(doc),
      resourceVersion,
    );
    try {
      await rolloutRestart("Deployment", CLUSTER.alertBridge.rulesNamespace, RECONCILER_DEPLOYMENT);
    } catch (err) {
      return `paused set written but the reconciler could not be restarted, so it may re-seed from its stale mounted copy: ${
        err instanceof Error ? err.message : String(err)
      }`;
    }
    const rolled = await waitForRollout(
      CLUSTER.alertBridge.rulesNamespace,
      RECONCILER_DEPLOYMENT,
    );
    if (!rolled) {
      return "the reconciler did not finish restarting in time — it may act on its stale copy for a while";
    }
    return undefined;
  } catch (err) {
    return `could not record the paused set (the reconciler may resume the live cameras mid-run): ${
      err instanceof Error ? err.message : String(err)
    }`;
  }
}

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
  /** Which scenario the clip is judged against. Omitted → general-activity,
   *  which asks the VLM for "anything notable" and therefore tests nothing in
   *  particular — pick a profile to exercise a real prompt. */
  alertType?: string;
  prompt?: string;
}

/** A VLM configuration a run can adopt: the alert_type + prompt pair a live
 *  camera is running, so a clip can be judged against exactly what production
 *  asks for rather than a generic "notable activity" prompt. */
export interface AlertProfile {
  alertType: string;
  prompt: string;
  /** Live cameras configured this way — shown so the operator can tell which
   *  part of the store a profile belongs to. */
  cameras: string[];
}

/** The default profile, used when a run names no scenario. Deliberately vague:
 *  it is the honest description of "we did not choose one". */
export const DEFAULT_PROFILE: AlertProfile = {
  alertType: "general-activity",
  prompt: "Alert on any notable or anomalous activity.",
  cameras: [],
};

/**
 * The alert profiles configured on this deployment, newest-configured first.
 *
 * Read from the rules ConfigMap rather than the scenarios document on purpose:
 * scenarios are keyword filters applied to a caption AFTER the VLM has spoken,
 * so they cannot make the VLM look for anything. What decides whether a theft
 * is described at all is the alert_type + prompt on the realtime rule — which
 * is what this returns.
 */
export async function listAlertProfiles(): Promise<AlertProfile[]> {
  let rules: Array<{ sensor?: string; alert_type?: string; prompt?: string }> = [];
  try {
    const { value } = await readConfigMapKey<{
      rules?: Array<{ sensor?: string; alert_type?: string; prompt?: string }>;
    }>(CLUSTER.alertBridge.rulesNamespace, CLUSTER.alertBridge.rulesConfigMap, "rules.json");
    rules = value.rules ?? [];
  } catch (err) {
    log.warn("could not read alert profiles from the rules CM", { err });
    return [DEFAULT_PROFILE];
  }

  const byType = new Map<string, AlertProfile>();
  for (const r of rules) {
    if (!r.alert_type || !r.prompt) continue;
    // A test camera's own entry is not a profile — offering it back would let a
    // run inherit the previous run's ad-hoc choice as if it were production.
    if (r.sensor && isFootageCamera(r.sensor)) continue;
    const existing = byType.get(r.alert_type);
    if (existing) {
      if (r.sensor) existing.cameras.push(r.sensor);
    } else {
      byType.set(r.alert_type, {
        alertType: r.alert_type,
        prompt: r.prompt,
        cameras: r.sensor ? [r.sensor] : [],
      });
    }
  }

  const profiles = [...byType.values()];
  return profiles.length ? profiles : [DEFAULT_PROFILE];
}

/** Sensors currently marked paused in the rules ConfigMap.
 *
 *  Surfaced so an abandoned run is visible: a run that is interrupted between
 *  pausing the cameras and stopping (browser closed, pod restarted) leaves the
 *  showroom analysing nothing, and without this the console showed no sign of
 *  it — the cameras simply looked idle. */
export async function pausedSensors(): Promise<string[]> {
  try {
    const { value } = await readConfigMapKey<{ paused_sensors?: unknown }>(
      CLUSTER.alertBridge.rulesNamespace,
      CLUSTER.alertBridge.rulesConfigMap,
      "rules.json",
    );
    return Array.isArray(value.paused_sensors) ? value.paused_sensors.map(String) : [];
  } catch {
    return [];
  }
}

export interface RunResult {
  cameraId: string;
  rtspUrl: string;
  /** Live cameras whose ingestion this run turned off, to restore on stop. */
  pausedCameras: string[];
  /** The profile the clip is actually being judged against. */
  alertType: string;
  warnings: string[];
}

/** Cameras currently being analysed that are NOT test footage. */
async function liveIngestingCameras(): Promise<string[]> {
  const { listIngestingCameras } = await import("@/lib/helpers/ingestion");
  const { ingesting } = await listIngestingCameras();
  return [...ingesting].filter((id) => !isFootageCamera(id));
}

/**
 * Every non-test camera this deployment WANTS analysed, whether or not it
 * happens to have a live rule right now.
 *
 * This, not the currently-ingesting list, is the correct pause target. The
 * reconciler seeds from the ConfigMap, so a camera that is momentarily ruleless
 * — mid-reseed, or after a failed create — is absent from the ingesting list,
 * never gets marked paused, and is then legitimately re-seeded during the run.
 * Observed exactly that: checkout-1 was seeded microseconds before the pause set
 * was computed, so it analysed alongside the clip for the whole run.
 */
async function desiredLiveCameras(): Promise<string[]> {
  const [ingesting, profiles] = await Promise.all([
    liveIngestingCameras(),
    readConfigMapKey<{ rules?: Array<{ sensor?: string }> }>(
      CLUSTER.alertBridge.rulesNamespace,
      CLUSTER.alertBridge.rulesConfigMap,
      "rules.json",
    )
      .then(({ value }) =>
        (value.rules ?? []).map((r) => r.sensor).filter((s): s is string => Boolean(s)),
      )
      .catch(() => [] as string[]),
  ]);
  return [...new Set([...ingesting, ...profiles])].filter((id) => !isFootageCamera(id));
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
    const live = await desiredLiveCameras();
    // Mark them paused first, so the reconciler will not want them back when it
    // comes up again.
    const markWarning = await setPausedSensors(live);
    if (markWarning) warnings.push(markWarning);

    // Then stop the reconciler outright for the few seconds it takes to remove
    // the rules. Restarting it is not enough — measured on the showroom, the
    // outgoing pod issued two rule-creating POSTs *after* the rollout reported
    // itself complete, because maxSurge overlaps the pods and the old one keeps
    // ticking (15s loop) for its whole 30s termination grace. Scaling to zero
    // and waiting for the pod to be gone is the only state in which "no other
    // writer exists" is actually true.
    const quiesce = await quiesceDeployment(
      CLUSTER.alertBridge.rulesNamespace,
      RECONCILER_DEPLOYMENT,
    ).catch((err) => {
      warnings.push(
        `could not stop the reconciler before pausing (it may re-seed the live cameras): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    });
    if (quiesce && !quiesce.quiesced) {
      warnings.push(
        "the reconciler did not stop in time — it may re-seed the live cameras during the run",
      );
    }

    try {
      for (const id of live) {
        // suspend, NOT setIngestion(false): the latter also deletes the camera's
        // desired spec from the ConfigMap, which is what a resume reads. The
        // paused_sensors marker written above is what stops the reconciler
        // re-seeding it once it is running again.
        const res = await suspendIngestion(id);
        if (res.ok) {
          pausedCameras.push(id);
        } else if (res.warning) {
          warnings.push(`could not pause ${id}: ${res.warning}`);
        }
      }
    } finally {
      // Always bring it back, including on a throw: the reconciler is what
      // re-fires a caption task when the VLM ends one (~every two minutes), so
      // the test stream itself needs it running.
      if (quiesce) {
        await scaleDeployment(
          CLUSTER.alertBridge.rulesNamespace,
          RECONCILER_DEPLOYMENT,
          quiesce.previousReplicas || 1,
        ).catch((err) => {
          warnings.push(
            `the reconciler was left scaled to zero — no rule will be re-fired until it is restored: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        });
      }
    }

    // Verify. Anything still ingesting was re-seeded despite the above, which
    // is worth removing again and worth saying — a silently-unpaused camera
    // makes the run's timings meaningless.
    const stillLive = await liveIngestingCameras();
    const reSeeded = pausedCameras.filter((id) => stillLive.includes(id));
    for (const id of reSeeded) {
      const res = await suspendIngestion(id);
      if (!res.ok && res.warning) warnings.push(`could not re-pause ${id}: ${res.warning}`);
    }
    if (reSeeded.length) {
      warnings.push(`re-paused ${reSeeded.join(", ")} — something had re-seeded them`);
    }

    log.info("paused live cameras for a footage run", { pausedCameras, reSeeded, cameraId });
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

  // Analysis on: this is what produces captions and therefore incidents. The
  // chosen profile decides what the VLM is asked to look for; scenarios then
  // match keywords against whatever it says.
  const ing = await setIngestion(cameraId, true, rtspUrl, {
    alertType: req.alertType,
    prompt: req.prompt,
  });
  if (!ing.ok && ing.warning) warnings.push(ing.warning);

  return {
    cameraId,
    rtspUrl,
    pausedCameras,
    alertType: req.alertType ?? DEFAULT_PROFILE.alertType,
    warnings,
  };
}

/**
 * Re-enable ingestion on cameras a run paused.
 *
 * Where the reconciler is deployed, clearing the marker IS the resume: it owns
 * rule creation and seeds every unpaused camera in the ConfigMap. The console
 * deliberately does not also create the rules itself.
 *
 * It used to do both, and the two writers raced. Neither sees the other's
 * create in time — the alert-bridge's rule index is eventually consistent, so
 * each reads "no rule for this sensor" and posts one. Measured after a stop: 6
 * rules with pyramid-16-cam0 twice, then 0, 2, 4, settling at 5 about two
 * minutes later, with the reconciler logging `deduped extra rule` as it cleaned
 * up after us. Duplicate rules mean a camera is analysed twice and the GPU
 * budget is wrong, and the churn is indistinguishable from a fault to anyone
 * watching the console.
 *
 * Deduping afterwards treats the symptom; one writer removes the race.
 */
async function restoreCameras(ids: string[]): Promise<string[]> {
  const warnings: string[] = [];
  // Clearing the marker also restarts the reconciler and waits for it, so the
  // new pod reads the current document and seeds on its first tick.
  const clearWarning = await setPausedSensors([]);
  if (clearWarning) warnings.push(clearWarning);

  if (await deploymentExists(CLUSTER.alertBridge.rulesNamespace, RECONCILER_DEPLOYMENT)) {
    log.info("resume delegated to the reconciler", { cameras: ids });
    return warnings;
  }

  // No reconciler on this profile — nothing else will create the rules, so the
  // console has to. There is no second writer here, so no race either.
  log.info("no reconciler deployed — resuming cameras directly", { cameras: ids });
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

  // Resume the union of what the caller remembers pausing and what the CM says
  // is paused. The caller's list is lost whenever the browser tab that started
  // the run is gone — which is exactly the case where the showroom is left
  // analysing nothing, so recovering from the CM is what makes "Stop all" a
  // genuine repair rather than a request the operator has to know to make from
  // the right tab.
  const marked = await pausedSensors();
  const resume = [...new Set([...input.resume, ...marked])].filter((id) => !isFootageCamera(id));
  const resumeWarnings = await restoreCameras(resume);
  warnings.push(...resumeWarnings);

  log.info("footage run stopped", { stopped, resumed: resume });
  return { stopped, resumed: resume, warnings };
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

import "server-only";
import { gcsCamerasGet, gcsHealthCheck } from "./helpers/gcs-config";
import { vstAddSensor } from "./helpers/vst";

// ─── Bootstrap logic ──────────────────────────────────────────────────────────
//
// On console container startup (CONSOLE_RUNTIME=docker), read the GCS camera
// list and re-register each camera with VST. Runs once per process lifetime,
// asynchronously — does not block the first request.
//
// Callers import `bootstrapComplete` to await completion when they need the
// bootstrap to have finished before returning data (e.g. the first GET
// /api/cameras call).

let _bootstrapPromise: Promise<void> | null = null;

/** Trigger the one-shot GCS → VST re-registration.  Safe to call multiple
 *  times — only the first call does work. Returns the shared promise. */
export function triggerCameraBootstrap(): Promise<void> {
  if (_bootstrapPromise === null) {
    _bootstrapPromise = runBootstrap();
  }
  return _bootstrapPromise;
}

/** Await the bootstrap if it was triggered.  No-op if it was never started. */
export async function awaitBootstrap(): Promise<void> {
  if (_bootstrapPromise !== null) {
    await _bootstrapPromise;
  }
}

async function runBootstrap(): Promise<void> {
  // Only runs in docker mode.
  if (process.env.CONSOLE_RUNTIME !== "docker") {
    console.log("[cameras-bootstrap] skipped (CONSOLE_RUNTIME !== docker)");
    return;
  }

  const instance = process.env.VSS_INSTANCE_NAME;
  if (!instance) {
    console.log("[cameras-bootstrap] skipped (VSS_INSTANCE_NAME not set)");
    return;
  }

  // Gate on GCS availability.
  let health: Awaited<ReturnType<typeof gcsHealthCheck>>;
  try {
    health = await gcsHealthCheck();
  } catch {
    console.warn("[cameras-bootstrap] gcsHealthCheck threw — skipping bootstrap");
    return;
  }

  if (health.status !== "ok") {
    console.log(
      `[cameras-bootstrap] skipped — GCS health: ${health.status}${
        health.detail ? ` (${health.detail})` : ""
      }`,
    );
    return;
  }

  // Fetch the persisted camera list.
  const list = await gcsCamerasGet(instance);
  if (!list) {
    console.log(
      `[cameras-bootstrap] no camera list found at cameras/${instance}.json — nothing to restore`,
    );
    return;
  }

  if (list.cameras.length === 0) {
    console.log("[cameras-bootstrap] camera list is empty — nothing to restore");
    return;
  }

  console.log(
    `[cameras-bootstrap] restoring ${list.cameras.length} cameras from GCS (last updated ${list.updatedAt} by ${list.updatedBy})`,
  );

  let registered = 0;
  let alreadyThere = 0;
  let failed = 0;

  for (const cam of list.cameras) {
    const result = await vstAddSensor({
      sensorId: cam.id,
      rtspUrl: cam.rtspUrl,
      description: cam.description,
    });

    if (result.ok) {
      if (result.warning?.includes("already")) {
        alreadyThere++;
        console.log(`[cameras-bootstrap]   ✓ ${cam.id} already registered`);
      } else {
        registered++;
        console.log(`[cameras-bootstrap]   + ${cam.id} registered`);
      }
    } else {
      failed++;
      console.warn(`[cameras-bootstrap]   ✗ ${cam.id} failed: ${result.warning}`);
    }
  }

  console.log(
    `[cameras-bootstrap] done — registered: ${registered}, already-there: ${alreadyThere}, failed: ${failed}`,
  );
}

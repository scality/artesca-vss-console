import "server-only";
import {
  gcsCamerasGet,
  gcsPromptGet,
  gcsScenariosGet,
  gcsHealthCheck,
} from "./helpers/gcs-config";
import { vstAddSensor } from "./helpers/vst";
import { applyPromptLive } from "./helpers/prompt-apply";
import { applyScenariosLive } from "./helpers/scenarios-apply";

// ─── Bootstrap logic ──────────────────────────────────────────────────────────
//
// On console container startup (CONSOLE_RUNTIME=docker), read GCS objects for
// cameras, prompt, and scenarios, and restore them to the live runtime.
// Runs once per process lifetime, asynchronously — does not block the first
// request.  Each surface skips silently if its GCS object doesn't exist or if
// GCS is unavailable.

let _bootstrapPromise: Promise<void> | null = null;

/** Trigger the one-shot GCS → runtime restore.  Safe to call multiple times —
 *  only the first call does work. Returns the shared promise. */
export function triggerGcsBootstrap(): Promise<void> {
  if (_bootstrapPromise === null) {
    _bootstrapPromise = runBootstrap();
  }
  return _bootstrapPromise;
}

/** Await the bootstrap if it was triggered.  No-op if it was never started. */
export async function awaitGcsBootstrap(): Promise<void> {
  if (_bootstrapPromise !== null) {
    await _bootstrapPromise;
  }
}

// Keep the cameras-bootstrap-compatible aliases so the cameras route doesn't
// need to change its imports.
export const triggerCameraBootstrap = triggerGcsBootstrap;
export const awaitBootstrap = awaitGcsBootstrap;

async function runBootstrap(): Promise<void> {
  // Only runs in docker mode.
  if (process.env.CONSOLE_RUNTIME !== "docker") {
    console.log("[gcs-bootstrap] skipped (CONSOLE_RUNTIME !== docker)");
    return;
  }

  const instance = process.env.VSS_INSTANCE_NAME;
  if (!instance) {
    console.log("[gcs-bootstrap] skipped (VSS_INSTANCE_NAME not set)");
    return;
  }

  // Gate on GCS availability — one health check shared across all surfaces.
  let health: Awaited<ReturnType<typeof gcsHealthCheck>>;
  try {
    health = await gcsHealthCheck();
  } catch {
    console.warn("[gcs-bootstrap] gcsHealthCheck threw — skipping bootstrap");
    return;
  }

  if (health.status !== "ok") {
    console.log(
      `[gcs-bootstrap] skipped — GCS health: ${health.status}${
        health.detail ? ` (${health.detail})` : ""
      }`,
    );
    return;
  }

  // Run each surface in series — cameras first (most critical), then prompt,
  // then scenarios.  Each surface is wrapped so a failure doesn't skip the rest.
  await restoreCameras(instance);
  await restorePrompt(instance);
  await restoreScenarios(instance);
}

async function restoreCameras(instance: string): Promise<void> {
  const list = await gcsCamerasGet(instance);
  if (!list) {
    console.log(`[gcs-bootstrap] cameras — no object at cameras/${instance}.json`);
    return;
  }
  if (list.cameras.length === 0) {
    console.log("[gcs-bootstrap] cameras — list is empty, nothing to restore");
    return;
  }

  console.log(
    `[gcs-bootstrap] cameras — restoring ${list.cameras.length} cameras (last updated ${list.updatedAt} by ${list.updatedBy})`,
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
        console.log(`[gcs-bootstrap] cameras   ✓ ${cam.id} already registered`);
      } else {
        registered++;
        console.log(`[gcs-bootstrap] cameras   + ${cam.id} registered`);
      }
    } else {
      failed++;
      console.warn(`[gcs-bootstrap] cameras   ✗ ${cam.id} failed: ${result.warning}`);
    }
  }

  console.log(
    `[gcs-bootstrap] cameras done — registered: ${registered}, already-there: ${alreadyThere}, failed: ${failed}`,
  );
}

async function restorePrompt(instance: string): Promise<void> {
  const config = await gcsPromptGet(instance);
  if (!config) {
    console.log(`[gcs-bootstrap] prompt — no object at prompt/${instance}.json`);
    return;
  }

  console.log(
    `[gcs-bootstrap] prompt — restoring (last updated ${config.updatedAt} by ${config.updatedBy})`,
  );

  const dockerMode = process.env.CONSOLE_RUNTIME === "docker";
  try {
    await applyPromptLive(dockerMode, config.prompt);
    console.log("[gcs-bootstrap] prompt — applied successfully");
  } catch (err) {
    console.warn(
      `[gcs-bootstrap] prompt — apply failed (will remain at container default): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

async function restoreScenarios(instance: string): Promise<void> {
  const config = await gcsScenariosGet(instance);
  if (!config) {
    console.log(`[gcs-bootstrap] scenarios — no object at scenarios/${instance}.json`);
    return;
  }

  console.log(
    `[gcs-bootstrap] scenarios — restoring ${config.scenarios.length} scenarios (last updated ${config.updatedAt} by ${config.updatedBy})`,
  );

  const dockerMode = process.env.CONSOLE_RUNTIME === "docker";
  try {
    await applyScenariosLive(dockerMode, config.scenarios);
    console.log("[gcs-bootstrap] scenarios — applied successfully");
  } catch (err) {
    console.warn(
      `[gcs-bootstrap] scenarios — apply failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

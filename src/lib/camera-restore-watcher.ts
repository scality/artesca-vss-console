import "server-only";

import { gcsCamerasGet } from "@/lib/helpers/gcs-config";
import { vstListSensors, vstAddSensor } from "@/lib/helpers/vst";

const POLL_INTERVAL_MS = 60_000;
// After VST restarts it takes a few seconds to be ready — wait before
// attempting registration so we don't hit a 503 immediately.
const POST_RESTART_DELAY_MS = 10_000;

async function restoreCamerasFromGcs(instance: string): Promise<void> {
  const list = await gcsCamerasGet(instance);
  if (!list || list.cameras.length === 0) return;

  console.log(`[camera-watcher] restoring ${list.cameras.length} cameras from GCS`);
  let ok = 0;
  for (const cam of list.cameras) {
    const result = await vstAddSensor({
      sensorId: cam.id,
      rtspUrl: cam.rtspUrl,
      description: cam.description,
    });
    if (result.ok) {
      ok++;
    } else {
      console.warn(`[camera-watcher] failed to register ${cam.id}: ${result.warning}`);
    }
  }
  console.log(`[camera-watcher] restore done — ${ok}/${list.cameras.length} registered`);
}

export function startCameraRestoreWatcher(instance: string): void {
  let restoreInProgress = false;

  async function tick() {
    if (restoreInProgress) return;
    try {
      const { sensors, warning } = await vstListSensors();
      if (warning) return; // VST not reachable yet
      if (sensors.length > 0) return; // sensors present — nothing to do

      restoreInProgress = true;
      // Brief pause so VST finishes initialising after a restart.
      await new Promise((r) => setTimeout(r, POST_RESTART_DELAY_MS));
      await restoreCamerasFromGcs(instance);
    } catch (err) {
      console.warn(`[camera-watcher] tick error: ${err instanceof Error ? err.message : err}`);
    } finally {
      restoreInProgress = false;
    }
  }

  // Check immediately on startup, then on every interval.
  tick();
  setInterval(tick, POLL_INTERVAL_MS);

  console.log(
    `[camera-watcher] started — polling VST every ${POLL_INTERVAL_MS / 1000}s for instance ${instance}`,
  );
}

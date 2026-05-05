import "server-only";

import { gcsCamerasGet } from "@/lib/helpers/gcs-config";
import { vstListSensors, vstAddSensor, vstStartStream } from "@/lib/helpers/vst";

const POLL_INTERVAL_MS = 60_000;
const POST_RESTART_DELAY_MS = 10_000;

const isDockerRuntime = process.env.CONSOLE_RUNTIME === "docker";

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
    if (!result.ok) {
      console.warn(`[camera-watcher] failed to register ${cam.id}: ${result.warning}`);
      continue;
    }
    ok++;
    if (isDockerRuntime) {
      const streamResult = await vstStartStream({ sensorId: cam.id, rtspUrl: cam.rtspUrl });
      if (!streamResult.ok) {
        console.warn(
          `[camera-watcher] failed to start stream for ${cam.id}: ${streamResult.warning}`,
        );
      }
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
      if (warning) return;
      if (sensors.length > 0) return;

      restoreInProgress = true;
      await new Promise((r) => setTimeout(r, POST_RESTART_DELAY_MS));
      await restoreCamerasFromGcs(instance);
    } catch (err) {
      console.warn(`[camera-watcher] tick error: ${err instanceof Error ? err.message : err}`);
    } finally {
      restoreInProgress = false;
    }
  }

  tick();
  setInterval(tick, POLL_INTERVAL_MS);

  console.log(
    `[camera-watcher] started — polling VST every ${POLL_INTERVAL_MS / 1000}s for instance ${instance}`,
  );
}

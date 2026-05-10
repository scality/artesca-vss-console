import "server-only";

import { gcsCamerasGet } from "@/lib/helpers/gcs-config";
import { vstListSensors, vstAddSensor, vstStartStream } from "@/lib/helpers/vst";
import { createLogger } from "@/lib/logger";

const log = createLogger("camera-watcher");

const POLL_INTERVAL_MS = 60_000;
const POST_RESTART_DELAY_MS = 10_000;

const isDockerRuntime = process.env.CONSOLE_RUNTIME === "docker";

async function restoreCamerasFromGcs(instance: string): Promise<void> {
  const list = await gcsCamerasGet(instance);
  if (!list || list.cameras.length === 0) return;

  log.info(`restoring ${list.cameras.length} cameras from GCS`);
  let ok = 0;
  for (const cam of list.cameras) {
    const result = await vstAddSensor({
      sensorId: cam.id,
      rtspUrl: cam.rtspUrl,
      description: cam.description,
    });
    if (!result.ok) {
      log.warn(`failed to register ${cam.id}`, { warning: result.warning });
      continue;
    }
    ok++;
    if (isDockerRuntime) {
      const streamResult = await vstStartStream({ sensorId: cam.id, rtspUrl: cam.rtspUrl });
      if (!streamResult.ok) {
        log.warn(`failed to start stream for ${cam.id}`, { warning: streamResult.warning });
      }
    }
  }
  log.info(`restore done — ${ok}/${list.cameras.length} registered`);
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
      log.warn("tick error", { err });
    } finally {
      restoreInProgress = false;
    }
  }

  tick();
  setInterval(tick, POLL_INTERVAL_MS);

  log.info(`started — polling VST every ${POLL_INTERVAL_MS / 1000}s for instance ${instance}`);
}

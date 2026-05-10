/**
 * Next.js instrumentation — runs once when the server process starts.
 *
 * Starts background watchers:
 *
 *  camera-restore: polls VST every 60 s and re-registers cameras from GCS
 *  whenever VST reports 0 sensors (happens after every docker-compose restart
 *  because VST's sensor list is in-memory).
 *
 *  caption-bridge: polls rtvi-vlm for registered streams and appends VLM
 *  captions to the synthetic-events JSONL (CONSOLE_RUNTIME=docker only).
 *
 * Only active in the Node.js runtime (not edge).
 */

import { createLogger } from "@/lib/logger";

const log = createLogger("instrumentation");

const globalForInstrumentation = globalThis as unknown as {
  __started?: boolean;
};

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  if (globalForInstrumentation.__started) return;
  globalForInstrumentation.__started = true;

  const required = ["AUTH_SECRET"];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) log.warn(`missing env vars: ${missing.join(", ")}`);

  const instance = process.env.VSS_INSTANCE_NAME;
  if (instance) {
    const { startCameraRestoreWatcher } = await import(
      "@/lib/camera-restore-watcher"
    );
    startCameraRestoreWatcher(instance);
  }

  if (process.env.CONSOLE_RUNTIME === "docker") {
    const { startCaptionBridge } = await import("@/lib/caption-bridge");
    startCaptionBridge();
  }
}

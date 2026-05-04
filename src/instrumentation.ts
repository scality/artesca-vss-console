/**
 * Next.js instrumentation — runs once when the server process starts.
 *
 * Starts a background camera-restore watcher: polls VST every 60 s and
 * re-registers cameras from GCS whenever VST reports 0 sensors (happens
 * after every docker-compose restart because VST's sensor list is in-memory).
 *
 * Only active in the Node.js runtime (not edge). Requires:
 *   VSS_INSTANCE_NAME — which GCS cameras/<instance>.json to read
 *   GOOGLE_APPLICATION_CREDENTIALS — service-account key for GCS reads
 */

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const instance = process.env.VSS_INSTANCE_NAME;
  if (!instance) return;

  const { startCameraRestoreWatcher } = await import(
    "@/lib/camera-restore-watcher"
  );
  startCameraRestoreWatcher(instance);
}

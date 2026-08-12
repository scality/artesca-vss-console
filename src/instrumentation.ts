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

import * as Sentry from "@/lib/telemetry";

import { createLogger } from "@/lib/logger";

const log = createLogger("instrumentation");

// Idempotency guard keyed on globalThis so it survives module re-evaluation
// under `next dev` HMR — a module-level flag would reset on hot reload and
// double-start the background watchers / reconcile loop.
const globalForInstrumentation = globalThis as unknown as { __started?: boolean };

export async function register() {
  // Sentry initializes on both Node.js and edge runtimes; background watchers
  // only run on Node.js. Init before anything else so early errors are caught.
  if (process.env.NEXT_RUNTIME === "edge") {
    await import("../sentry.edge.config");
    return;
  }
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  await import("../sentry.server.config");

  const { filterKnownUpstreamWarnings } = await import("@/lib/deprecation-filter");
  filterKnownUpstreamWarnings();

  if (globalForInstrumentation.__started) return;
  globalForInstrumentation.__started = true;

  const { startErrorBridge } = await import("@/lib/error-bridge");
  void startErrorBridge();

  if (process.env.RECONCILE_AGENT === "1") {
    const { startReconcileLoop } = await import("@/lib/reconcile-agent");
    await startReconcileLoop();
    return;
  }

  const required = ["AUTH_SECRET"];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) log.warn(`missing env vars: ${missing.join(", ")}`);

  const instance = process.env.VSS_INSTANCE_NAME;
  const dockerMode = process.env.CONSOLE_RUNTIME === "docker";
  const reconcileLoopDisabled = process.env.CONSOLE_DISABLE_RECONCILE_LOOP === "1";

  if (instance && !dockerMode) {
    // k8s full-console. One idempotent convergence pass ALWAYS runs on startup so
    // the node is configured after any restart. CONSOLE_DISABLE_RECONCILE_LOOP=1
    // only suppresses the periodic loop (set it when a dedicated reconcile-agent
    // owns steady-state convergence); the startup pass runs either way.
    const { startReconcileLoop } = await import("@/lib/reconcile-agent");
    await startReconcileLoop({ periodic: !reconcileLoopDisabled });
  } else if (instance) {
    // docker: GCS-backed camera restore after compose restarts.
    const { startCameraRestoreWatcher } = await import(
      "@/lib/camera-restore-watcher"
    );
    startCameraRestoreWatcher(instance);
  }

  if (dockerMode) {
    const { startCaptionBridge } = await import("@/lib/caption-bridge");
    startCaptionBridge();
  }
}

// Captures all unhandled server-side request errors.
export const onRequestError = Sentry.captureRequestError;

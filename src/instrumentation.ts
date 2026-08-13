/**
 * Next.js instrumentation — runs once when the server process starts.
 *
 * Runs one idempotent reconcile pass so the node is configured after any
 * restart, then starts the periodic convergence loop unless a dedicated
 * reconcile-agent owns it (CONSOLE_DISABLE_RECONCILE_LOOP=1).
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
  const reconcileLoopDisabled = process.env.CONSOLE_DISABLE_RECONCILE_LOOP === "1";

  // One idempotent convergence pass ALWAYS runs on startup so the node is
  // configured after any restart. CONSOLE_DISABLE_RECONCILE_LOOP=1 only
  // suppresses the periodic loop (set it when a dedicated reconcile-agent owns
  // steady-state convergence); the startup pass runs either way.
  if (instance) {
    const { startReconcileLoop } = await import("@/lib/reconcile-agent");
    await startReconcileLoop({ periodic: !reconcileLoopDisabled });
  }
}

// Captures all unhandled server-side request errors.
export const onRequestError = Sentry.captureRequestError;

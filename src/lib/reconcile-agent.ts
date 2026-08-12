// console/src/lib/reconcile-agent.ts
import "server-only";

import { makeConfigStore, configStoreKind, storeKindWasInferred } from "@/lib/config-store";
import { VstClusterAdapter, type ClusterAdapter } from "@/lib/reconcile/cluster-adapter";
import { reconcileInstanceCameras } from "@/lib/reconcile/run";
import type { ReconcileRunOptions } from "@/lib/reconcile/run";
import type { ConfigStore, ReconcileStatus } from "@/lib/config-store/types";
import { createLogger } from "@/lib/logger";

const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_AGENT_VERSION = process.env.RECONCILE_AGENT_VERSION ?? "agent@plan2";

interface AgentLog {
  info: (msg: string, meta?: unknown) => void;
  warn: (msg: string, meta?: unknown) => void;
}

export interface RunReconcileAgentDeps {
  store: ConfigStore;
  adapter: ClusterAdapter;
  instance: string;
  prune?: boolean;
  agentVersion?: string;
  log: AgentLog;
  /** Cluster targets for prompt + scenarios convergence. When absent, only cameras converge. */
  refs?: ReconcileRunOptions["refs"];
}

/** One agent pass: converge the instance's cameras, prompt, and scenarios; log a summary. */
export async function runReconcileAgentOnce(deps: RunReconcileAgentDeps): Promise<ReconcileStatus> {
  const status = await reconcileInstanceCameras(deps.store, deps.adapter, deps.instance, {
    prune: deps.prune ?? false,
    agentVersion: deps.agentVersion ?? DEFAULT_AGENT_VERSION,
    refs: deps.refs,
  });
  deps.log.info(
    `reconciled ${deps.instance}: +${status.applied.camerasAdded} cameras, ` +
      `prompt=${status.applied.promptUpdated}, scenarios=${status.applied.scenariosUpdated}, ` +
      `${status.errors.length} error(s), ${status.drift.length} drift note(s)`,
    { instance: deps.instance, applied: status.applied },
  );

  // Recording-recovery pass — guarded auto-heal for the VST cloud recorder's
  // silent-stall failure mode. Fail-soft: never lets a probe/rearm error take
  // the reconcile tick down. Gated on RECORDING_AUTOHEAL_ENABLED !== "0"
  // (CLUSTER.recording.enabled). See
  // docs/superpowers/specs/2026-07-04-vss-recording-recovery-design.md.
  try {
    const { CLUSTER } = await import("@/lib/cluster-refs");
    if (CLUSTER.recording.enabled) {
      const { vstListSensors } = await import("@/lib/helpers/vst");
      const { probeRecording } = await import("@/lib/helpers/recording-health");
      const { rearmRecording } = await import("@/lib/helpers/rearm-recording");
      const { recoverStalledRecording } = await import("@/lib/reconcile/recording-recovery");
      const { VstClusterAdapter } = await import("@/lib/reconcile/cluster-adapter");
      const recoveryAdapter = new VstClusterAdapter();

      const [{ sensors }, desired] = await Promise.all([
        vstListSensors(),
        deps.store.readCameras(deps.instance),
      ]);
      const summary = await recoverStalledRecording({
        sensors,
        desired,
        probe: probeRecording,
        rearm: rearmRecording,
        restartStreamProcessing: () => recoveryAdapter.restartStreamProcessing!(),
        config: CLUSTER.recording,
        log: deps.log,
      });
      deps.log.info(
        `recording-recovery ${deps.instance}: re-armed: [${summary.reArmed.join(", ")}], ` +
          `degraded: [${summary.degraded.join(", ")}]` +
          (summary.escalated ? " — ESCALATED: streamprocessing restart fired" : "") +
          ` (${summary.outcomes.length} sensor(s) checked)`,
      );
    }
  } catch (err) {
    deps.log.warn("recording-recovery pass failed — continuing", { err });
  }

  return status;
}

/**
 * Start the reconcile agent. Builds the Firestore store once, then fires one
 * idempotent fire-and-forget startup convergence pass so the cluster is
 * configured on every boot. When `periodic !== false` (default), also schedules
 * a recurring interval — each tick is guarded against overlap and never throws.
 * Returns once the startup pass is enqueued and the interval (if any) is set.
 * No-op (logs) when no instance is resolvable.
 */
export async function startReconcileLoop(opts?: { intervalMs?: number; instance?: string; periodic?: boolean }): Promise<void> {
  const log = createLogger("reconcile-agent");
  const instance = opts?.instance ?? process.env.VSS_INSTANCE_NAME;
  if (!instance) {
    log.warn("RECONCILE_AGENT set but VSS_INSTANCE_NAME missing — agent idle");
    return;
  }
  const intervalMs =
    opts?.intervalMs ?? (Number(process.env.RECONCILE_INTERVAL_MS) || DEFAULT_INTERVAL_MS);

  const adapter = new VstClusterAdapter();
  let store: ConfigStore;
  try {
    store = await makeConfigStore();
    log.info(
      `config store: ${configStoreKind()}` +
        (storeKindWasInferred() ? " (inferred from FIRESTORE_PROJECT_ID; set CONSOLE_CONFIG_STORE)" : ""),
    );
  } catch (err) {
    // `log.warn` + `return` was wrong here, and quietly so: the agent went idle
    // and the only trace was one warn line among a booting Next server's output,
    // while `kubectl get pods` showed Running. An agent that cannot reach its
    // store converges nothing, so a lab looked configured and was not.
    //
    // In the dedicated agent pod, converging IS the process's only job — rethrow,
    // and let the CrashLoopBackOff be the signal. In the console pod the same
    // failure must not take the web UI down, because the UI is where an operator
    // reads what went wrong (`/about` names the store and its status).
    log.error("config store init failed", { err });
    if (process.env.RECONCILE_AGENT === "1") throw err;
    log.error("reconcile loop not started — the console will serve, but nothing converges");
    return;
  }

  // cluster-refs import is deferred to here so the pure reconciler modules (run.ts,
  // prompt.ts, scenarios.ts) remain free of the "server-only" cluster-refs import.
  const { CLUSTER } = await import("@/lib/cluster-refs");
  const { buildReconcileRefs } = await import("@/lib/reconcile/refs");
  const refs: ReconcileRunOptions["refs"] = buildReconcileRefs(CLUSTER);

  // One-shot idempotent seed: if the instance has no prompt-sets yet, seed a
  // "default" set (migrating any existing legacy prompt, else the bundled
  // default) and mark it active. Fail-soft; never blocks the loop.
  try {
    const { readDefaultPrompt } = await import("@/lib/helpers/default-prompt");
    const { seedDefaultPromptSet } = await import("@/lib/reconcile/prompt-seed");
    await seedDefaultPromptSet(store, instance, readDefaultPrompt());
  } catch (err) {
    log.warn("prompt seed step failed — continuing", { err });
  }

  // Adapt Logger (ctx: Record<string,unknown>|undefined) → AgentLog (meta?: unknown)
  const agentLog: AgentLog = {
    info: (msg, meta) => log.info(msg, meta as Record<string, unknown> | undefined),
    warn: (msg, meta) => log.warn(msg, meta as Record<string, unknown> | undefined),
  };

  let inFlight = false;
  const tick = async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      await runReconcileAgentOnce({ store, adapter, instance, refs, log: agentLog });
    } catch (err) {
      log.warn("reconcile tick failed", { err });
    } finally {
      inFlight = false;
    }
  };

  // Always fire one idempotent startup convergence pass so the node is configured
  // on every boot. Keep it fire-and-forget (void) so a slow cluster never blocks
  // Next's boot/readiness. The periodic loop is opt-out via opts.periodic
  // (default true); a deployment with a dedicated reconcile-agent sets
  // periodic:false to avoid continuously racing it — the one startup pass still runs.
  void tick();
  const periodic = opts?.periodic ?? true;
  if (periodic) {
    setInterval(tick, intervalMs);
    log.info(`reconcile agent started — instance=${instance} interval=${intervalMs / 1000}s (periodic)`);
  } else {
    log.info(`reconcile agent — one-shot startup convergence fired for ${instance} (periodic loop off)`);
  }
}

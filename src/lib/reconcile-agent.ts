// console/src/lib/reconcile-agent.ts
import "server-only";

import { makeFirestoreConfigStore } from "@/lib/config-store/firestore";
import { VstClusterAdapter, type ClusterAdapter } from "@/lib/reconcile/cluster-adapter";
import { reconcileInstanceCameras } from "@/lib/reconcile/run";
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
}

/** One agent pass: converge the instance's cameras and log a summary. */
export async function runReconcileAgentOnce(deps: RunReconcileAgentDeps): Promise<ReconcileStatus> {
  const status = await reconcileInstanceCameras(deps.store, deps.adapter, deps.instance, {
    prune: deps.prune ?? false,
    agentVersion: deps.agentVersion ?? DEFAULT_AGENT_VERSION,
  });
  deps.log.info(
    `reconciled ${deps.instance}: +${status.applied.camerasAdded} cameras, ` +
      `${status.errors.length} error(s), ${status.drift.length} drift note(s)`,
    { instance: deps.instance, applied: status.applied },
  );
  return status;
}

/**
 * Start the headless reconcile loop. Builds the Firestore store once, then ticks
 * every `intervalMs`. Each tick is guarded against overlap and never throws out
 * of the loop. Returns once the loop is scheduled (the interval keeps the
 * process alive). No-op (logs) when no instance is resolvable.
 */
export async function startReconcileLoop(opts?: { intervalMs?: number; instance?: string }): Promise<void> {
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
    store = await makeFirestoreConfigStore();
  } catch (err) {
    log.warn("could not init Firestore store — agent idle", { err });
    return;
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
      await runReconcileAgentOnce({ store, adapter, instance, log: agentLog });
    } catch (err) {
      log.warn("reconcile tick failed", { err });
    } finally {
      inFlight = false;
    }
  };

  void tick();
  setInterval(tick, intervalMs);
  log.info(`reconcile agent started — instance=${instance} interval=${intervalMs / 1000}s`);
}

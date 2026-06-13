import type { ConfigStore, ReconcileStatus } from "@/lib/config-store/types";
import { emptyStatus } from "@/lib/config-store/types";
import type { ClusterAdapter } from "@/lib/reconcile/cluster-adapter";
import { reconcileCameras } from "@/lib/reconcile/cameras";
import { reconcilePrompt } from "@/lib/reconcile/prompt";
import type { PromptRefs } from "@/lib/reconcile/prompt";
import { reconcileScenarios } from "@/lib/reconcile/scenarios";
import type { ScenarioRefs } from "@/lib/reconcile/scenarios";

export interface ReconcileRunOptions {
  prune: boolean;
  /** Injectable clock for deterministic tests. */
  now?: () => string;
  /** Agent build id stamped into the status. */
  agentVersion?: string;
  /** Cluster targets for prompt + scenarios convergence. When absent, only cameras converge. */
  refs?: { prompt: PromptRefs; scenarios: ScenarioRefs };
}

/**
 * One reconcile pass for an instance's cameras: read desired from the store,
 * converge the cluster via the adapter, persist a status doc.
 *
 * Reconcile failures (store read, adapter calls, per-camera errors) are caught
 * and recorded in `status.errors` — those never throw. The final
 * `store.writeStatus` is intentionally NOT guarded and DOES propagate: a
 * persistence failure cannot be recorded in the status it failed to write, so
 * swallowing it would falsely signal success. Callers running this in a loop
 * (the reconcile agent) should wrap each pass to tolerate writeback errors.
 */
export async function reconcileInstanceCameras(
  store: ConfigStore,
  adapter: ClusterAdapter,
  instance: string,
  opts: ReconcileRunOptions,
): Promise<ReconcileStatus> {
  const now = opts.now ?? (() => new Date().toISOString());
  const status = emptyStatus(opts.agentVersion ?? "dev", now());

  try {
    const desired = await store.readCameras(instance);
    const result = await reconcileCameras(desired, adapter, { prune: opts.prune });
    status.applied.camerasAdded = result.added.length;
    status.applied.camerasPruned = result.pruned.length;
    status.drift = result.drift;
    status.errors = result.failed.map((f) => `camera ${f.id}: ${f.warning ?? "unknown error"}`);

    if (opts.refs) {
      const { reconcileVlmStrategy } = await import("@/lib/reconcile/vlm-strategy");
      const stratRes = await reconcileVlmStrategy(adapter, { ns: opts.refs.prompt.ns, deployment: opts.refs.prompt.deployment });
      if (stratRes.error) status.errors.push(`vlm-strategy: ${stratRes.error}`);

      const desiredPrompt = await store.readPrompt(instance);
      const promptRes = await reconcilePrompt(desiredPrompt, adapter, opts.refs.prompt);
      status.applied.promptUpdated = promptRes.updated;
      if (promptRes.error) status.errors.push(`prompt: ${promptRes.error}`);

      const desiredScenarios = await store.readScenarios(instance);
      const scenariosRes = await reconcileScenarios(desiredScenarios, adapter, opts.refs.scenarios);
      status.applied.scenariosUpdated = scenariosRes.updated;
      if (scenariosRes.error) status.errors.push(`scenarios: ${scenariosRes.error}`);
    }
  } catch (err) {
    status.errors.push(err instanceof Error ? err.message : String(err));
  }

  await store.writeStatus(instance, status);
  return status;
}

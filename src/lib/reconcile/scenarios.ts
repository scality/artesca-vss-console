import type { ClusterAdapter } from "@/lib/reconcile/cluster-adapter";
import type { ScenarioEntry } from "@/lib/config-store/types";
import { stringify as yamlStringify } from "yaml";

export interface ScenarioRefs { ns: string; configMap: string; yamlKey: string; alertWorkerDeployment: string }
export interface ScenarioReconcileResult { updated: boolean; skipped?: string; error?: string }

/** Default serializer: the ConfigMap payload shape `{ scenarios: [...] }` as YAML. */
export function serializeScenarios(scenarios: ScenarioEntry[]): string {
  return yamlStringify({ scenarios });
}

/**
 * Converge alert scenarios: if the serialized desired differs from the live
 * ConfigMap key, patch it + restart the alert worker. Idempotent. Never throws.
 * `serialize` is injectable for deterministic tests; defaults to YAML.
 */
export async function reconcileScenarios(
  desired: ScenarioEntry[],
  adapter: ClusterAdapter,
  refs: ScenarioRefs,
  serialize: (s: ScenarioEntry[]) => string = serializeScenarios,
): Promise<ScenarioReconcileResult> {
  if (!adapter.getConfigMapKey || !adapter.patchConfigMapKey || !adapter.restartDeployment) {
    return { updated: false, skipped: "adapter cannot patch configmap" };
  }
  try {
    const want = serialize(desired);
    const current = await adapter.getConfigMapKey(refs.ns, refs.configMap, refs.yamlKey);
    if (current === want) return { updated: false };
    await adapter.patchConfigMapKey(refs.ns, refs.configMap, refs.yamlKey, want);
    await adapter.restartDeployment(refs.ns, refs.alertWorkerDeployment);
    return { updated: true };
  } catch (err) {
    return { updated: false, error: err instanceof Error ? err.message : String(err) };
  }
}

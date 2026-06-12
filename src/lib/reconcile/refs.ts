import type { CLUSTER as ClusterType } from "@/lib/cluster-refs";
import type { ReconcileRunOptions } from "@/lib/reconcile/run";

/** Build the prompt + scenarios cluster refs from the resolved CLUSTER object.
 *  Shared by the headless agent loop and the Console write-through routes so
 *  both converge against identical targets. */
export function buildReconcileRefs(cluster: typeof ClusterType): NonNullable<ReconcileRunOptions["refs"]> {
  return {
    prompt: {
      ns: cluster.rtvi.vlmNamespace,
      deployment: cluster.rtvi.vlmDeployment,
      promptKey: cluster.rtvi.promptKey,
    },
    scenarios: {
      ns: cluster.scenarios.namespace,
      configMap: cluster.scenarios.configMap,
      yamlKey: cluster.scenarios.yamlKey,
      alertWorkerDeployment: cluster.scenarios.alertWorkerDeployment,
    },
  };
}

import type { ClusterAdapter } from "@/lib/reconcile/cluster-adapter";

export interface VlmStrategyRefs { ns: string; deployment: string }
export interface VlmStrategyResult { patched: boolean; skipped?: string; error?: string }

/** Assert the VLM Deployment uses Recreate strategy so single-GPU rolls don't
 *  deadlock (new pod can't load the VLM until the old frees the GPU). Pure +
 *  fail-soft: never throws. */
export async function reconcileVlmStrategy(a: ClusterAdapter, refs: VlmStrategyRefs): Promise<VlmStrategyResult> {
  if (!a.ensureDeploymentStrategy) return { patched: false, skipped: "adapter cannot set strategy" };
  try {
    const patched = await a.ensureDeploymentStrategy(refs.ns, refs.deployment, "Recreate");
    return { patched };
  } catch (err) {
    return { patched: false, error: err instanceof Error ? err.message : String(err) };
  }
}

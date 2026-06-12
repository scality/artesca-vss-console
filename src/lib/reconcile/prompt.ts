import type { ClusterAdapter } from "@/lib/reconcile/cluster-adapter";
import type { PromptDoc } from "@/lib/config-store/types";

export interface PromptRefs { ns: string; deployment: string; promptKey: string }
export interface PromptReconcileResult { updated: boolean; skipped?: string; error?: string }

/**
 * Converge the VLM system prompt: if the desired prompt differs from the live
 * Deployment env value, patch it + restart. Idempotent (restart only on a real
 * diff). Never throws — failures land in `error`.
 */
export async function reconcilePrompt(
  desired: PromptDoc | null,
  adapter: ClusterAdapter,
  refs: PromptRefs,
): Promise<PromptReconcileResult> {
  if (!desired) return { updated: false, skipped: "no desired prompt" };
  if (!adapter.getDeploymentEnv || !adapter.patchDeploymentEnv || !adapter.restartDeployment) {
    return { updated: false, skipped: "adapter cannot patch deployment env" };
  }
  try {
    const current = await adapter.getDeploymentEnv(refs.ns, refs.deployment, refs.promptKey);
    if (current === desired.prompt) return { updated: false };
    await adapter.patchDeploymentEnv(refs.ns, refs.deployment, refs.promptKey, desired.prompt);
    await adapter.restartDeployment(refs.ns, refs.deployment);
    return { updated: true };
  } catch (err) {
    return { updated: false, error: err instanceof Error ? err.message : String(err) };
  }
}

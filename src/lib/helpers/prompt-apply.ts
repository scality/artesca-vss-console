/**
 * Shared helper for applying a VLM prompt update. Isolates the Kubernetes
 * read/patch logic so callers do not need an HTTP round-trip through the route.
 */
import "server-only";
import { patchConfigMapRawKey } from "./configmaps";
import { CLUSTER } from "../cluster-refs";

// ─── Public API ───────────────────────────────────────────────────────────────

/** Read the current VLM prompt from the live runtime. */
export async function readPromptLive(): Promise<string> {
  const { coreV1, appsV1 } = await import("../k8s");
  // Helm path: prompt is a direct env var on the Deployment.
  // Legacy path: prompt lives in ConfigMap rtvi-runtime-env.
  if (!CLUSTER.rtvi.runtimeEnvCm) {
    const deploy = await appsV1().readNamespacedDeployment({
      name: CLUSTER.rtvi.vlmDeployment,
      namespace: CLUSTER.rtvi.nimNamespace,
    });
    const envVars = deploy.spec?.template?.spec?.containers?.[0]?.env ?? [];
    return envVars.find((e) => e.name === CLUSTER.rtvi.promptKey)?.value ?? "";
  }
  const cm = await coreV1().readNamespacedConfigMap({
    name: CLUSTER.rtvi.runtimeEnvCm,
    namespace: CLUSTER.rtvi.nimNamespace,
  });
  return cm.data?.[CLUSTER.rtvi.promptKey] ?? "";
}

/** Apply a new VLM prompt to the live runtime.  Throws on failure. */
export async function applyPromptLive(prompt: string): Promise<void> {
  // Helm path: patch env var directly on the Deployment.
  // Legacy path: patch ConfigMap.
  if (!CLUSTER.rtvi.runtimeEnvCm) {
    const { appsV1, MERGE_PATCH_OPTS } = await import("../k8s");
    const deploy = await appsV1().readNamespacedDeployment({
      name: CLUSTER.rtvi.vlmDeployment,
      namespace: CLUSTER.rtvi.nimNamespace,
    });
    const container = deploy.spec?.template?.spec?.containers?.[0];
    if (!container) throw new Error(`No containers in ${CLUSTER.rtvi.vlmDeployment}`);
    const envPatch = [...(container.env ?? [])];
    const idx = envPatch.findIndex((e) => e.name === CLUSTER.rtvi.promptKey);
    if (idx >= 0) envPatch[idx] = { name: CLUSTER.rtvi.promptKey, value: prompt };
    else envPatch.push({ name: CLUSTER.rtvi.promptKey, value: prompt });
    await appsV1().patchNamespacedDeployment({
      name: CLUSTER.rtvi.vlmDeployment,
      namespace: CLUSTER.rtvi.nimNamespace,
      body: { spec: { template: { spec: { containers: [{ name: container.name, env: envPatch }] } } } },
    }, MERGE_PATCH_OPTS);
    return;
  }
  await patchConfigMapRawKey(
    CLUSTER.rtvi.nimNamespace,
    CLUSTER.rtvi.runtimeEnvCm,
    CLUSTER.rtvi.promptKey,
    prompt,
  );
}

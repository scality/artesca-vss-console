import "server-only";
import { CLUSTER } from "@/lib/cluster-refs";
import { readConfigMapKey, patchConfigMapKey } from "@/lib/helpers/configmaps";
import { appsV1, rolloutRestart, MERGE_PATCH_OPTS } from "@/lib/k8s";
import { extractK8sError } from "@/lib/errors";
import { AGENT_DEPLOYMENT_NAME } from "@/lib/agent-config";

/**
 * agent-config-write.ts — Save+Restart path for the /agent editor page.
 *
 * Mirrors the /api/tuning/* routes' mechanism (direct @kubernetes/client-node
 * ConfigMap + Deployment env patches, then a rollout restart) rather than the
 * Firestore-backed reconcile path used by /cameras, /prompt, /scenarios — the
 * agent's workflow config isn't part of that persistence layer today (see
 * console/CLAUDE.md "Persistence layers").
 *
 * IMPORTANT — durability: k8s/nvidia-vss-helm-overlay/60-agent-config-patch-job.yaml
 * re-asserts the deployment-context prompt block (and, going forward, a
 * pinned LLM default) on every Helm upgrade. A save through this module is a
 * LIVE override that lasts only until the next redeploy re-applies the patch
 * Job. The /agent page surfaces this to the operator — it is not restated
 * here beyond this note.
 */

/** Loosely-typed config.yml document — only `workflow` is read/written here;
 *  every other top-level key is preserved verbatim across a patch. */
interface AgentConfigDoc {
  workflow?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface AgentConfigPatch {
  maxIterations?: number;
  prompt?: string;
}

/**
 * Patch workflow.max_iterations and/or workflow.prompt in the
 * vss-agent-config ConfigMap. Reads the full document, merges only the
 * targeted fields, and re-serializes the whole thing — every other key
 * (including unknown ones) survives untouched. Creates the ConfigMap if it
 * doesn't exist yet (patchConfigMapKey's 404 fallback).
 */
export async function patchAgentWorkflowConfig(patch: AgentConfigPatch): Promise<void> {
  if (patch.maxIterations === undefined && patch.prompt === undefined) return;

  let doc: AgentConfigDoc = {};
  let resourceVersion: string | undefined;
  try {
    const read = await readConfigMapKey<AgentConfigDoc>(
      CLUSTER.vssNamespace,
      CLUSTER.agent.configMap,
      CLUSTER.agent.configKey,
    );
    doc = { ...(read.value ?? {}) };
    resourceVersion = read.resourceVersion;
  } catch (err) {
    const { status } = extractK8sError(err);
    if (status !== 404) throw err;
    // ConfigMap absent — patchConfigMapKey below creates it fresh.
  }

  const workflow: Record<string, unknown> = { ...(doc.workflow ?? {}) };
  if (patch.maxIterations !== undefined) workflow.max_iterations = patch.maxIterations;
  if (patch.prompt !== undefined) workflow.prompt = patch.prompt;
  doc.workflow = workflow;

  await patchConfigMapKey(
    CLUSTER.vssNamespace,
    CLUSTER.agent.configMap,
    CLUSTER.agent.configKey,
    doc,
    resourceVersion,
  );
}

export interface AgentEnvPatch {
  llmBaseUrl?: string;
  llmName?: string;
}

/**
 * Patch LLM_BASE_URL / LLM_NAME on the vss-agent Deployment's first
 * container env, preserving every other env var (including valueFrom
 * entries). Same merge-by-name strategic-merge-patch approach as
 * /api/tuning/rtvi's patchVlmDeploymentEnv.
 */
export async function patchAgentDeploymentEnv(patch: AgentEnvPatch): Promise<void> {
  const envPatches: Record<string, string> = {};
  if (patch.llmBaseUrl !== undefined) envPatches.LLM_BASE_URL = patch.llmBaseUrl;
  if (patch.llmName !== undefined) envPatches.LLM_NAME = patch.llmName;
  if (Object.keys(envPatches).length === 0) return;

  const ns = CLUSTER.vssNamespace;
  const name = AGENT_DEPLOYMENT_NAME;

  const deployment = await appsV1().readNamespacedDeployment({ name, namespace: ns });
  const currentEnv = deployment.spec?.template?.spec?.containers?.[0]?.env ?? [];
  const containerName = deployment.spec?.template?.spec?.containers?.[0]?.name ?? name;

  const envMap = new Map<string, string>();
  for (const ev of currentEnv) {
    if (ev.name && ev.value !== undefined && ev.value !== null) {
      envMap.set(ev.name, ev.value);
    }
  }
  for (const [key, value] of Object.entries(envPatches)) {
    envMap.set(key, value);
  }

  // Preserve valueFrom entries (secretKeyRef, configMapKeyRef) untouched.
  const valueFromEntries = currentEnv.filter((ev) => ev.valueFrom !== undefined);
  const plainEntries = Array.from(envMap.entries()).map(([n, v]) => ({ name: n, value: v }));

  const patchBody = {
    spec: {
      template: {
        spec: {
          containers: [
            {
              name: containerName,
              env: [...valueFromEntries, ...plainEntries],
            },
          ],
        },
      },
    },
  };

  await appsV1().patchNamespacedDeployment(
    { name, namespace: ns, body: patchBody },
    MERGE_PATCH_OPTS,
  );
}

/** Rollout-restart the vss-agent Deployment — same mechanism as `kubectl
 *  rollout restart` (patches the pod-template restartedAt annotation). */
export async function restartAgentDeployment(): Promise<void> {
  await rolloutRestart("Deployment", CLUSTER.vssNamespace, AGENT_DEPLOYMENT_NAME);
}

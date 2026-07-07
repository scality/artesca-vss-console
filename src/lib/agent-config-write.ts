import "server-only";
import { type V1Deployment, type V1EnvVar } from "@kubernetes/client-node";
import { CLUSTER } from "@/lib/cluster-refs";
import { readConfigMapKey, patchConfigMapKey } from "@/lib/helpers/configmaps";
import { appsV1, rolloutRestart, JSON_PATCH_OPTS } from "@/lib/k8s";
import { extractK8sError } from "@/lib/errors";
import { AGENT_DEPLOYMENT_NAME } from "@/lib/agent-config";

/** K8s secret (ns = CLUSTER.vssNamespace) holding the Anthropic API key,
 *  seeded out-of-band from Secret Manager. Referenced via secretKeyRef so the
 *  key is never a plaintext env value or exposed to the browser. */
export const ANTHROPIC_KEY_SECRET = { name: "vss-agent-anthropic", key: "OPENAI_API_KEY" } as const;

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
  /** Remove `temperature` from the openai LLM profile(s) in config.yml.
   *  Anthropic's 4.6+ models reject `temperature` on the OpenAI-compatible
   *  endpoint (HTTP 400 "temperature is deprecated for this model"), so it must
   *  be absent for the agent to route to Claude. Targets `openai_llm` / `llm`
   *  only — the `*_vlm` profiles point at the local VLM NIM and keep theirs. */
  stripOpenaiLlmTemperature?: boolean;
}

/**
 * Patch workflow.max_iterations and/or workflow.prompt in the
 * vss-agent-config ConfigMap. Reads the full document, merges only the
 * targeted fields, and re-serializes the whole thing — every other key
 * (including unknown ones) survives untouched. Creates the ConfigMap if it
 * doesn't exist yet (patchConfigMapKey's 404 fallback).
 */
export async function patchAgentWorkflowConfig(patch: AgentConfigPatch): Promise<void> {
  if (
    patch.maxIterations === undefined &&
    patch.prompt === undefined &&
    !patch.stripOpenaiLlmTemperature
  ) {
    return;
  }

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

  if (patch.stripOpenaiLlmTemperature) {
    const llms = doc.llms;
    if (llms && typeof llms === "object") {
      for (const key of ["openai_llm", "llm"]) {
        const profile = (llms as Record<string, unknown>)[key];
        if (profile && typeof profile === "object" && "temperature" in profile) {
          delete (profile as Record<string, unknown>).temperature;
        }
      }
    }
  }

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
  llmModelType?: "nim" | "openai";
}

/**
 * Patch LLM_BASE_URL / LLM_NAME / LLM_MODEL_TYPE on the vss-agent Deployment's
 * first container env, preserving every other env var (including valueFrom
 * entries). Same merge-by-name strategic-merge-patch approach as
 * /api/tuning/rtvi's patchVlmDeploymentEnv.
 *
 * `llmModelType: "openai"` additionally wires OPENAI_API_KEY as a
 * secretKeyRef onto ANTHROPIC_KEY_SECRET — the agent's single `llm` profile
 * has no explicit `api_key` in config.yml, so `_type: openai` falls back to
 * that env var. Any plaintext OPENAI_API_KEY value is dropped so the two
 * representations never collide on the same env name.
 */
export async function patchAgentDeploymentEnv(patch: AgentEnvPatch): Promise<void> {
  const envPatches: Record<string, string> = {};
  if (patch.llmBaseUrl !== undefined) envPatches.LLM_BASE_URL = patch.llmBaseUrl;
  if (patch.llmName !== undefined) envPatches.LLM_NAME = patch.llmName;
  if (patch.llmModelType !== undefined) envPatches.LLM_MODEL_TYPE = patch.llmModelType;

  const wireOpenaiKey = patch.llmModelType === "openai";
  if (Object.keys(envPatches).length === 0 && !wireOpenaiKey) return;

  const ns = CLUSTER.vssNamespace;
  const name = AGENT_DEPLOYMENT_NAME;

  const deployment = await appsV1().readNamespacedDeployment({ name, namespace: ns });
  const currentEnv = deployment.spec?.template?.spec?.containers?.[0]?.env ?? [];

  const envMap = new Map<string, string>();
  for (const ev of currentEnv) {
    if (ev.name && ev.value !== undefined && ev.value !== null) {
      envMap.set(ev.name, ev.value);
    }
  }
  for (const [key, value] of Object.entries(envPatches)) {
    envMap.set(key, value);
  }

  // Preserve valueFrom entries (secretKeyRef, configMapKeyRef) untouched,
  // deduped by name so the OPENAI_API_KEY secretKeyRef below can be upserted
  // in place instead of appended as a duplicate env entry.
  const valueFromEntries = new Map<string, V1EnvVar>();
  for (const ev of currentEnv) {
    if (ev.name && ev.valueFrom !== undefined) valueFromEntries.set(ev.name, ev);
  }

  if (wireOpenaiKey) {
    // OPENAI_API_KEY must come from the secret, never a plaintext value —
    // remove any plain-value copy so the two don't collide.
    envMap.delete(ANTHROPIC_KEY_SECRET.key);
    valueFromEntries.set(ANTHROPIC_KEY_SECRET.key, {
      name: ANTHROPIC_KEY_SECRET.key,
      valueFrom: {
        secretKeyRef: { name: ANTHROPIC_KEY_SECRET.name, key: ANTHROPIC_KEY_SECRET.key },
      },
    });
  }

  const plainEntries = Array.from(envMap.entries()).map(([n, v]) => ({ name: n, value: v }));
  const newEnv = [...valueFromEntries.values(), ...plainEntries];

  // Replace the whole env array via JSON Patch rather than a strategic merge.
  // A strategic merge patches each env entry by name, which would keep the old
  // plaintext `value` on OPENAI_API_KEY when we swap it to a secretKeyRef — the
  // apiserver then rejects the Deployment ("may not specify valueFrom when
  // value is not empty"). Replacing the array wholesale drops the stale field.
  const jsonPatch = [
    { op: "replace", path: "/spec/template/spec/containers/0/env", value: newEnv },
  ];

  await appsV1().patchNamespacedDeployment(
    { name, namespace: ns, body: jsonPatch as unknown as V1Deployment },
    JSON_PATCH_OPTS,
  );
}

/** Rollout-restart the vss-agent Deployment — same mechanism as `kubectl
 *  rollout restart` (patches the pod-template restartedAt annotation). */
export async function restartAgentDeployment(): Promise<void> {
  await rolloutRestart("Deployment", CLUSTER.vssNamespace, AGENT_DEPLOYMENT_NAME);
}

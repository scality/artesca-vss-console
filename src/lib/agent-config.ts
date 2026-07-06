import "server-only";
import { CLUSTER } from "@/lib/cluster-refs";
import { readConfigMapKey } from "@/lib/helpers/configmaps";
import { appsV1 } from "@/lib/k8s";

/**
 * agent-config.ts — reads the live vss-agent-config ConfigMap and (optionally)
 * the vss-agent Deployment env to surface agent behaviour on the /capabilities
 * page.
 *
 * Always resolves — any failure degrades to nulls + warnings[] rather than
 * throwing, matching the fail-soft contract of other console collectors
 * (collectOverviewSnapshot, collectAgentReachability, etc.).
 */

export interface AgentLlm {
  baseUrl: string;
  modelName: string;
}

/** vss-agent Deployment name — shared with agent-config-write.ts so the
 *  read and write paths never drift. Matches the Helm chart's object name;
 *  the legacy pre-Helm layout uses "nvidia-vss-agent" in ns "agent" instead,
 *  a distinction this collector has always simplified away (see
 *  CLUSTER.restartable for the legacy-aware mapping). */
export const AGENT_DEPLOYMENT_NAME = "vss-agent";

export interface AgentBehavior {
  /** workflow.prompt from the vss-agent-config ConfigMap, or null on failure. */
  prompt: string | null;
  /** workflow.max_iterations from the ConfigMap, or null on failure. */
  maxIterations: number | null;
  /** LLM_BASE_URL / LLM_NAME from the vss-agent Deployment env, or null when unavailable. */
  llm: AgentLlm | null;
  warnings: string[];
}

/** Shape of the parsed config.yml document — only the fields we consume. */
interface AgentConfigDoc {
  workflow?: {
    prompt?: unknown;
    max_iterations?: unknown;
  };
}

export async function collectAgentBehavior(): Promise<AgentBehavior> {
  const warnings: string[] = [];
  let prompt: string | null = null;
  let maxIterations: number | null = null;
  let llm: AgentLlm | null = null;

  // ── Read workflow config from vss-agent-config ConfigMap ─────────────────
  try {
    const { value } = await readConfigMapKey<AgentConfigDoc>(
      CLUSTER.vssNamespace,
      CLUSTER.agent.configMap,
      CLUSTER.agent.configKey,
    );
    const wf = value?.workflow;
    if (typeof wf?.prompt === "string") {
      prompt = wf.prompt;
    } else {
      warnings.push(
        `${CLUSTER.agent.configMap}/${CLUSTER.agent.configKey}: workflow.prompt missing or not a string`,
      );
    }
    if (typeof wf?.max_iterations === "number") {
      maxIterations = wf.max_iterations;
    } else {
      warnings.push(
        `${CLUSTER.agent.configMap}/${CLUSTER.agent.configKey}: workflow.max_iterations missing or not a number`,
      );
    }
  } catch (err) {
    warnings.push(
      `Cannot read ConfigMap ${CLUSTER.agent.configMap}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // ── Optionally resolve the LLM endpoint from the vss-agent Deployment env ─
  // Secondary / fail-soft: a missing or inaccessible Deployment is non-fatal.
  try {
    const deployment = await appsV1().readNamespacedDeployment({
      name: AGENT_DEPLOYMENT_NAME,
      namespace: CLUSTER.vssNamespace,
    });
    const env = new Map<string, string>();
    for (const c of deployment.spec?.template?.spec?.containers ?? []) {
      for (const e of c.env ?? []) {
        if (typeof e.value === "string" && !env.has(e.name)) {
          env.set(e.name, e.value);
        }
      }
    }
    const baseUrl = env.get("LLM_BASE_URL") ?? "";
    const modelName = env.get("LLM_NAME") ?? "";
    if (baseUrl) {
      llm = { baseUrl, modelName };
    }
  } catch (err) {
    // LLM resolution is secondary; a missing Deployment is non-fatal.
    warnings.push(
      `LLM endpoint lookup skipped: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return { prompt, maxIterations, llm, warnings };
}

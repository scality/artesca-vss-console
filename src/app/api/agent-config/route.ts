import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { withRequestContext } from "@/lib/with-request-context";
import { rejectIfKiosk } from "@/lib/kiosk-server";
import { auditLog } from "@/lib/helpers/audit";
import { extractK8sError } from "@/lib/errors";
import { CLUSTER } from "@/lib/cluster-refs";
import { appsV1 } from "@/lib/k8s";
import { collectAgentBehavior, AGENT_DEPLOYMENT_NAME } from "@/lib/agent-config";
import {
  patchAgentWorkflowConfig,
  patchAgentDeploymentEnv,
  restartAgentDeployment,
} from "@/lib/agent-config-write";
import { probeRemoteLlmEndpoint } from "@/lib/gpu-allocation";
import { collectAgentReachability } from "@/lib/agent-health";

export const dynamic = "force-dynamic";

/**
 * /api/agent-config — read + edit the VSS agent's workflow config
 * (workflow.prompt, workflow.max_iterations from the vss-agent-config
 * ConfigMap) and its LLM wiring (LLM_BASE_URL / LLM_NAME env on the
 * vss-agent Deployment). Backs the unified /agent page (config editor +
 * tool catalog + health).
 *
 * Thin auth + JSON wrapper around collectAgentBehavior() (GET) and
 * agent-config-write.ts (PATCH) — same split as the /api/tuning/* routes.
 * GET also folds in collectAgentReachability() (the vss-agent /health probe,
 * distinct from the LLM-endpoint probe below) so the page's agent-reachability
 * chip doesn't need a second round-trip.
 */

/** Read NVIDIA_API_KEY / OPENAI_API_KEY off the vss-agent Deployment env so
 *  the models probe below can authenticate exactly as the agent does.
 *  Never returned to the client. Fail-soft: an unreadable Deployment just
 *  means the probe runs unauthenticated. */
async function readAgentApiKey(): Promise<string | undefined> {
  try {
    const deployment = await appsV1().readNamespacedDeployment({
      name: AGENT_DEPLOYMENT_NAME,
      namespace: CLUSTER.vssNamespace,
    });
    const env = new Map<string, string>();
    for (const c of deployment.spec?.template?.spec?.containers ?? []) {
      for (const e of c.env ?? []) {
        if (typeof e.value === "string" && !env.has(e.name)) env.set(e.name, e.value);
      }
    }
    return env.get("NVIDIA_API_KEY") ?? env.get("OPENAI_API_KEY");
  } catch {
    return undefined;
  }
}

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const [behavior, reachability] = await Promise.all([
    collectAgentBehavior(),
    collectAgentReachability(),
  ]);

  let health: string = "unknown";
  let healthDetail = "";
  let models: string[] = [];

  if (behavior.llm?.baseUrl) {
    const apiKey = await readAgentApiKey();
    const probe = await probeRemoteLlmEndpoint(behavior.llm.baseUrl, apiKey);
    health = probe.health;
    healthDetail = probe.detail;
    models = probe.models;
  }

  return NextResponse.json({
    prompt: behavior.prompt ?? "",
    maxIterations: behavior.maxIterations,
    llmBaseUrl: behavior.llm?.baseUrl ?? "",
    llmName: behavior.llm?.modelName ?? "",
    health,
    healthDetail,
    models,
    warnings: behavior.warnings,
    agentReachable: reachability.reachable,
    agentReachabilityWarnings: reachability.warnings,
  });
}

const AgentConfigPatchSchema = z
  .object({
    maxIterations: z.number().int().min(1).max(100).optional(),
    prompt: z.string().min(1).optional(),
    llmBaseUrl: z.string().min(1).optional(),
    llmName: z.string().min(1).optional(),
  })
  .refine((d) => Object.values(d).some((v) => v !== undefined), {
    message: "At least one field is required",
  });

export const PATCH = withRequestContext(async (req: NextRequest) => {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const blocked = await rejectIfKiosk();
  if (blocked) return blocked;

  const body = await req.json().catch(() => null);
  const parsed = AgentConfigPatchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Validation failed", issues: parsed.error.issues }, { status: 400 });
  }
  const { maxIterations, prompt, llmBaseUrl, llmName } = parsed.data;

  // The agent appends /v1 itself — a trailing /v1 already in the base URL
  // doubles to /v1/v1 and 404s on every chat turn ("age not found" bug).
  // Warn but don't block the save; the operator may be mid-edit.
  const trailingV1 = llmBaseUrl !== undefined && /\/v1\/?$/.test(llmBaseUrl);

  try {
    await patchAgentWorkflowConfig({ maxIterations, prompt });
  } catch (err) {
    const { status, message } = extractK8sError(err);
    return NextResponse.json(
      { error: `vss-agent-config ConfigMap patch failed: ${message}`, k8sCode: status },
      { status },
    );
  }

  try {
    await patchAgentDeploymentEnv({ llmBaseUrl, llmName });
  } catch (err) {
    const { status, message } = extractK8sError(err);
    return NextResponse.json(
      { error: `vss-agent Deployment env patch failed: ${message}`, k8sCode: status },
      { status },
    );
  }

  try {
    await restartAgentDeployment();
  } catch (err) {
    const { message } = extractK8sError(err);
    return NextResponse.json(
      { error: `vss-agent rollout restart failed: ${message}` },
      { status: 502 },
    );
  }

  await auditLog("agent-config-update", `deployment/${AGENT_DEPLOYMENT_NAME}`, {
    maxIterations,
    promptLength: prompt?.length,
    llmBaseUrl,
    llmName,
  });

  return NextResponse.json({
    ok: true,
    restarted: [`deployment/${AGENT_DEPLOYMENT_NAME}`],
    ...(trailingV1
      ? {
          warning:
            "LLM_BASE_URL ends in /v1 — the agent appends /v1 itself, which doubles to /v1/v1 and 404s on every query.",
        }
      : {}),
  });
});

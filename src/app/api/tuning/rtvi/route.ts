import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { coreV1, appsV1, rolloutRestart, MERGE_PATCH_OPTS } from "@/lib/k8s";
import { withRequestContext } from "@/lib/with-request-context";
import { patchConfigMapRawKey } from "@/lib/helpers/configmaps";
import { auditLog } from "@/lib/helpers/audit";
import { CLUSTER } from "@/lib/cluster-refs";
import { inspectContainer, dockerRecreateWithEnv } from "@/lib/helpers/docker-sock";
import { extractK8sError } from "@/lib/errors";
import { rejectIfKiosk } from "@/lib/kiosk-server";
import { RtviTuningSchema } from "./schema";

export const dynamic = "force-dynamic";

const DOCKER_MODE = process.env.CONSOLE_RUNTIME === "docker";
const NIM_CONTAINER = "cosmos-reason2-8b";

// Defaults align with k8s/nvidia-vss/rtvi/11-configmap-runtime-env.yaml + the
// RtviTuningForm client contract (field names `maxNumSeqs`, `kvCachePct`,
// `maxModelLen`). Note: client uses `kvCachePct` while PATCH accepts
// `kvCachePercent` — GET mirrors the client schema.
const RTVI_TUNING_DEFAULTS = {
  maxNumSeqs: 4,
  kvCachePct: 0.8,
  maxModelLen: 32768,
  modelProfile: "",
  disableCudaGraph: false,
  numSchedulerSteps: 8,
  maxNumBatchedTokens: 5120,
  maxGenerationTokens: 16384,
} as const;

function parseIntOrDefault(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

function parseFloatOrDefault(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Read env vars from the rtvi-vlm Deployment (spec.template.spec.containers[0].env).
 * Returns a record of env var name → value. Missing env vars are absent from the record.
 */
async function readVlmDeploymentEnv(): Promise<Record<string, string>> {
  const ns = CLUSTER.rtvi.vlmNamespace;
  const name = CLUSTER.rtvi.vlmDeployment;
  const result: Record<string, string> = {};
  try {
    const deployment = await appsV1().readNamespacedDeployment({ name, namespace: ns });
    const envVars = deployment.spec?.template?.spec?.containers?.[0]?.env ?? [];
    for (const ev of envVars) {
      if (ev.name && ev.value !== undefined && ev.value !== null) {
        result[ev.name] = ev.value;
      }
    }
  } catch {
    // Non-fatal: return empty record, caller falls back to defaults.
  }
  return result;
}

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (DOCKER_MODE) {
    const inspect = await inspectContainer(NIM_CONTAINER);
    if (!inspect) {
      return NextResponse.json(
        {
          ...RTVI_TUNING_DEFAULTS,
          kvCachePct: RTVI_TUNING_DEFAULTS.kvCachePct,
          runtime: "docker",
          warnings: ["cosmos-reason2-8b container not running — showing defaults"],
        },
      );
    }
    const env: Record<string, string> = {};
    for (const line of inspect.Config.Env ?? []) {
      const eq = line.indexOf("=");
      if (eq > 0) env[line.slice(0, eq)] = line.slice(eq + 1);
    }
    return NextResponse.json({
      maxNumSeqs: parseIntOrDefault(env[CLUSTER.rtvi.nimMaxNumSeqsKey], RTVI_TUNING_DEFAULTS.maxNumSeqs),
      kvCachePct: parseFloatOrDefault(env[CLUSTER.rtvi.nimKvCacheKey], RTVI_TUNING_DEFAULTS.kvCachePct),
      maxModelLen: parseIntOrDefault(env[CLUSTER.rtvi.nimMaxModelLenKey], RTVI_TUNING_DEFAULTS.maxModelLen),
      modelProfile: env[CLUSTER.rtvi.nimModelProfileKey] ?? RTVI_TUNING_DEFAULTS.modelProfile,
      disableCudaGraph: env["NIM_DISABLE_CUDA_GRAPH"] === "1",
      numSchedulerSteps: parseIntOrDefault(env["VLLM_NUM_SCHEDULER_STEPS"], RTVI_TUNING_DEFAULTS.numSchedulerSteps),
      maxNumBatchedTokens: parseIntOrDefault(env["VLLM_MAX_NUM_BATCHED_TOKENS"], RTVI_TUNING_DEFAULTS.maxNumBatchedTokens),
      maxGenerationTokens: parseIntOrDefault(env["VLM_MAX_GENERATION_TOKENS"], RTVI_TUNING_DEFAULTS.maxGenerationTokens),
      runtime: "docker",
    });
  }

  // Helm "alerts" profile: no NIM tuning ConfigMap — the VLM tunables are env
  // vars on the vss-rtvi-vlm Deployment. Other Helm layouts keep a per-NIM CM.
  // Legacy path: NIM tuning lives in rtvi-runtime-env.
  const cmName = CLUSTER.rtvi.nimTuningConfigMap || CLUSTER.rtvi.runtimeEnvCm;
  const cmNs = CLUSTER.rtvi.nimTuningNamespace;

  // Read deployment env vars for the rtvi-vlm Deployment.
  const vlmEnv = await readVlmDeploymentEnv();

  // When no tuning ConfigMap exists, the Deployment env IS the source of truth.
  let data: Record<string, string> | undefined;
  if (cmName) {
    try {
      const cm = await coreV1().readNamespacedConfigMap({
        name: cmName,
        namespace: cmNs,
      });
      data = cm.data;
    } catch (err: unknown) {
      const { status, message } = extractK8sError(err);
      return NextResponse.json(
        { error: message, k8sCode: status },
        { status }
      );
    }
  } else {
    data = vlmEnv;
  }

  return NextResponse.json({
    maxNumSeqs: parseIntOrDefault(data?.[CLUSTER.rtvi.nimMaxNumSeqsKey], RTVI_TUNING_DEFAULTS.maxNumSeqs),
    kvCachePct: parseFloatOrDefault(data?.[CLUSTER.rtvi.nimKvCacheKey], RTVI_TUNING_DEFAULTS.kvCachePct),
    maxModelLen: parseIntOrDefault(data?.[CLUSTER.rtvi.nimMaxModelLenKey], RTVI_TUNING_DEFAULTS.maxModelLen),
    modelProfile: data?.[CLUSTER.rtvi.nimModelProfileKey] ?? RTVI_TUNING_DEFAULTS.modelProfile,
    disableCudaGraph: vlmEnv["NIM_DISABLE_CUDA_GRAPH"] === "1",
    numSchedulerSteps: parseIntOrDefault(vlmEnv["VLLM_NUM_SCHEDULER_STEPS"], RTVI_TUNING_DEFAULTS.numSchedulerSteps),
    maxNumBatchedTokens: parseIntOrDefault(vlmEnv["VLLM_MAX_NUM_BATCHED_TOKENS"], RTVI_TUNING_DEFAULTS.maxNumBatchedTokens),
    maxGenerationTokens: parseIntOrDefault(vlmEnv["VLM_MAX_GENERATION_TOKENS"], RTVI_TUNING_DEFAULTS.maxGenerationTokens),
  });
}

/**
 * Patch the rtvi-vlm Deployment env vars using a strategic merge patch on the
 * containers array. For NIM_DISABLE_CUDA_GRAPH: presence with value "1" means
 * disabled; absence means vLLM default (graphs enabled). So toggling OFF removes
 * the env var by rebuilding the env list without it.
 */
async function patchVlmDeploymentEnv(
  envPatches: Record<string, string | null> // null = remove the env var
): Promise<void> {
  const ns = CLUSTER.rtvi.vlmNamespace;
  const name = CLUSTER.rtvi.vlmDeployment;

  // Read current env list to compute the new merged list.
  const deployment = await appsV1().readNamespacedDeployment({ name, namespace: ns });
  const currentEnv = deployment.spec?.template?.spec?.containers?.[0]?.env ?? [];
  // Strategic-merge patches key containers by name — must match the live
  // container (e.g. "vss-rtvi-vlm" on the Helm chart) or a phantom container
  // gets appended instead of patching the real one.
  const containerName =
    deployment.spec?.template?.spec?.containers?.[0]?.name ?? name;

  // Build a map of existing env vars (preserving those we're not touching).
  const envMap = new Map<string, string>();
  for (const ev of currentEnv) {
    if (ev.name && ev.value !== undefined && ev.value !== null) {
      envMap.set(ev.name, ev.value);
    }
  }

  // Apply patches: set or delete.
  for (const [key, value] of Object.entries(envPatches)) {
    if (value === null) {
      envMap.delete(key);
    } else {
      envMap.set(key, value);
    }
  }

  // Rebuild env list — only includes plain value entries we manage.
  // We must preserve valueFrom entries (secretKeyRef, configMapKeyRef) from
  // the current spec. Re-read and keep those intact.
  const valueFromEntries = currentEnv.filter((ev) => ev.valueFrom !== undefined);
  const plainEntries = Array.from(envMap.entries()).map(([name, value]) => ({ name, value }));

  const patch = {
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
    { name, namespace: ns, body: patch },
    MERGE_PATCH_OPTS,
  );
}

export const PATCH = withRequestContext(async function (req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const blocked = await rejectIfKiosk();
  if (blocked) return blocked;

  const body = await req.json().catch(() => null);
  const parsed = RtviTuningSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Validation failed", issues: parsed.error.issues }, { status: 400 });
  }

  const tuning = parsed.data;

  if (DOCKER_MODE) {
    const envPatch: Record<string, string> = {};
    if (tuning.maxNumSeqs !== undefined) {
      envPatch[CLUSTER.rtvi.nimMaxNumSeqsKey] = String(tuning.maxNumSeqs);
    }
    if (tuning.kvCachePercent !== undefined) {
      envPatch[CLUSTER.rtvi.nimKvCacheKey] = String(tuning.kvCachePercent);
    }
    if (tuning.maxModelLen !== undefined) {
      envPatch[CLUSTER.rtvi.nimMaxModelLenKey] = String(tuning.maxModelLen);
    }
    if (tuning.modelProfile !== undefined) {
      envPatch[CLUSTER.rtvi.nimModelProfileKey] = tuning.modelProfile;
    }
    if (tuning.disableCudaGraph !== undefined) {
      if (tuning.disableCudaGraph) {
        envPatch["NIM_DISABLE_CUDA_GRAPH"] = "1";
      }
      // In docker mode we can't "remove" an env var — set to "0" when false.
      // The container reads absence or "0" as graphs-enabled.
      else {
        envPatch["NIM_DISABLE_CUDA_GRAPH"] = "0";
      }
    }
    if (tuning.numSchedulerSteps !== undefined) {
      envPatch["VLLM_NUM_SCHEDULER_STEPS"] = String(tuning.numSchedulerSteps);
    }
    if (tuning.maxNumBatchedTokens !== undefined) {
      envPatch["VLLM_MAX_NUM_BATCHED_TOKENS"] = String(tuning.maxNumBatchedTokens);
    }
    if (tuning.maxGenerationTokens !== undefined) {
      envPatch["VLM_MAX_GENERATION_TOKENS"] = String(tuning.maxGenerationTokens);
    }
    try {
      const { id } = await dockerRecreateWithEnv(NIM_CONTAINER, envPatch);
      await auditLog("tuning-rtvi", `docker/${NIM_CONTAINER}`, { patches: envPatch });
      return NextResponse.json({
        ok: true,
        applied: envPatch,
        runtime: "docker",
        containerId: id.slice(0, 12),
        note: "NIM container recreating — expect 5–10 min downtime.",
      });
    } catch (err) {
      return NextResponse.json(
        {
          error: `cosmos-reason2-8b recreate failed: ${String(err)}`,
          hint: "Old container restored automatically.",
          runtime: "docker",
        },
        { status: 502 },
      );
    }
  }

  // ── Step 1: ConfigMap patches (NIM tuning CM) ─────────────────────────────
  const cmPatches: Array<[string, string]> = [];

  if (tuning.maxNumSeqs !== undefined) {
    cmPatches.push([CLUSTER.rtvi.nimMaxNumSeqsKey, String(tuning.maxNumSeqs)]);
  }
  if (tuning.kvCachePercent !== undefined) {
    cmPatches.push([CLUSTER.rtvi.nimKvCacheKey, String(tuning.kvCachePercent)]);
  }
  if (tuning.maxModelLen !== undefined) {
    cmPatches.push([CLUSTER.rtvi.nimMaxModelLenKey, String(tuning.maxModelLen)]);
  }
  if (tuning.modelProfile !== undefined) {
    cmPatches.push([CLUSTER.rtvi.nimModelProfileKey, tuning.modelProfile]);
  }

  // Helm "alerts" profile: no NIM tuning ConfigMap — fold the NIM tuning knobs
  // into the vss-rtvi-vlm Deployment env (cmName === ""). Other layouts patch
  // the per-NIM ConfigMap; legacy patches rtvi-runtime-env.
  const cmName = CLUSTER.rtvi.nimTuningConfigMap || CLUSTER.rtvi.runtimeEnvCm;
  const cmNs = CLUSTER.rtvi.nimTuningNamespace;

  // ── Step 2: rtvi-vlm Deployment env patches ───────────────────────────────
  const vlmEnvPatches: Record<string, string | null> = {};
  let hasVlmPatches = false;

  if (cmName) {
    if (cmPatches.length > 0) {
      try {
        for (const [key, val] of cmPatches) {
          await patchConfigMapRawKey(cmNs, cmName, key, val);
        }
      } catch (err: unknown) {
        const { status, message } = extractK8sError(err);
        return NextResponse.json({ error: message, k8sCode: status }, { status });
      }
    }
  } else {
    // No ConfigMap — these knobs live in the Deployment env.
    for (const [key, val] of cmPatches) {
      vlmEnvPatches[key] = val;
      hasVlmPatches = true;
    }
  }

  if (tuning.disableCudaGraph !== undefined) {
    // Absence = graphs enabled (vLLM default). Presence with "1" = disabled.
    vlmEnvPatches["NIM_DISABLE_CUDA_GRAPH"] = tuning.disableCudaGraph ? "1" : null;
    hasVlmPatches = true;
  }
  if (tuning.numSchedulerSteps !== undefined) {
    vlmEnvPatches["VLLM_NUM_SCHEDULER_STEPS"] = String(tuning.numSchedulerSteps);
    hasVlmPatches = true;
  }
  if (tuning.maxNumBatchedTokens !== undefined) {
    vlmEnvPatches["VLLM_MAX_NUM_BATCHED_TOKENS"] = String(tuning.maxNumBatchedTokens);
    hasVlmPatches = true;
  }
  if (tuning.maxGenerationTokens !== undefined) {
    vlmEnvPatches["VLM_MAX_GENERATION_TOKENS"] = String(tuning.maxGenerationTokens);
    hasVlmPatches = true;
  }

  if (hasVlmPatches) {
    try {
      await patchVlmDeploymentEnv(vlmEnvPatches);
    } catch (err: unknown) {
      const { status, message } = extractK8sError(err);
      return NextResponse.json(
        { error: `rtvi-vlm deployment patch failed: ${message}`, k8sCode: status },
        { status }
      );
    }
  }

  // ── Step 3: rollout restart — NIM workload + rtvi-vlm Deployment ──────────
  const nimKind = CLUSTER.legacy ? ("StatefulSet" as const) : ("Deployment" as const);
  const nimNs = CLUSTER.rtvi.nimTuningNamespace;

  // The NIM workload may be absent — e.g. the LLM runs remote (hosted NVIDIA
  // API) and its NIMService/Deployment was deleted. Treat NotFound as a no-op
  // instead of failing the whole save; the rtvi-vlm restart below still applies.
  let nimRestartSkipped = false;
  try {
    await rolloutRestart(nimKind, nimNs, CLUSTER.rtvi.nimStatefulSet);
  } catch (err) {
    const { status } = extractK8sError(err);
    if (status === 404) {
      nimRestartSkipped = true;
    } else {
      return NextResponse.json(
        { error: `NIM rollout restart failed: ${String(err)}` },
        { status: 502 }
      );
    }
  }

  if (hasVlmPatches || tuning.modelProfile !== undefined) {
    try {
      await rolloutRestart("Deployment", CLUSTER.rtvi.vlmNamespace, CLUSTER.rtvi.vlmDeployment);
    } catch (err) {
      return NextResponse.json(
        { error: `rtvi-vlm rollout restart failed: ${String(err)}` },
        { status: 502 }
      );
    }
  }

  // ── Step 4: audit log ─────────────────────────────────────────────────────
  const nimAuditTarget = `${nimKind.toLowerCase()}/${CLUSTER.rtvi.nimStatefulSet}`;
  const allPatches: Record<string, string> = {
    ...Object.fromEntries(cmPatches),
    ...Object.fromEntries(
      Object.entries(vlmEnvPatches).map(([k, v]) => [k, v ?? "(removed)"])
    ),
  };

  await auditLog(
    "tuning-rtvi",
    nimAuditTarget,
    { patches: allPatches }
  );

  return NextResponse.json({
    ok: true,
    applied: allPatches,
    restarted: [
      ...(nimRestartSkipped ? [] : [nimAuditTarget]),
      ...(hasVlmPatches || tuning.modelProfile !== undefined
        ? [`deployment/${CLUSTER.rtvi.vlmDeployment}`]
        : []),
    ],
    ...(nimRestartSkipped
      ? { note: `NIM workload ${CLUSTER.rtvi.nimStatefulSet} not found (likely running remote) — skipped its restart; ConfigMap values still patched.` }
      : {}),
  });
});

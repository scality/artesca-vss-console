import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { z } from "zod";
import { coreV1, rolloutRestart } from "@/lib/k8s";
import { withRequestContext } from "@/lib/with-request-context";
import { patchConfigMapRawKey } from "@/lib/helpers/configmaps";
import { auditLog } from "@/lib/helpers/audit";
import { CLUSTER } from "@/lib/cluster-refs";
import { inspectContainer, dockerRecreateWithEnv } from "@/lib/helpers/docker-sock";
import { extractK8sError } from "@/lib/errors";
import { rejectIfKiosk } from "@/lib/kiosk-server";

export const dynamic = "force-dynamic";

const DOCKER_MODE = process.env.CONSOLE_RUNTIME === "docker";
const NIM_CONTAINER = "cosmos-reason2-8b";

const RtviTuningSchema = z.object({
  maxNumSeqs: z.number().int().positive().optional(),
  kvCachePercent: z.number().min(0).max(1).optional(),
  maxModelLen: z.number().int().positive().optional(),
}).refine(
  (d) => Object.values(d).some((v) => v !== undefined),
  { message: "At least one tuning field is required" }
);

// Defaults align with k8s/nvidia-vss/rtvi/11-configmap-runtime-env.yaml + the
// RtviTuningForm client contract (field names `maxNumSeqs`, `kvCachePct`,
// `maxModelLen`). Note: client uses `kvCachePct` while PATCH accepts
// `kvCachePercent` — GET mirrors the client schema.
const RTVI_TUNING_DEFAULTS = {
  maxNumSeqs: 4,
  kvCachePct: 0.8,
  maxModelLen: 32768,
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
      runtime: "docker",
    });
  }

  // Helm path: NIM tuning lives in a per-NIM ConfigMap (nvidia-nemotron-nano-9b-v2-nim-env).
  // Legacy path: NIM tuning lives in rtvi-runtime-env.
  const cmName = CLUSTER.rtvi.nimTuningConfigMap || CLUSTER.rtvi.runtimeEnvCm;
  const cmNs = CLUSTER.rtvi.nimTuningNamespace;

  let data: Record<string, string> | undefined;
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

  return NextResponse.json({
    maxNumSeqs: parseIntOrDefault(data?.[CLUSTER.rtvi.nimMaxNumSeqsKey], RTVI_TUNING_DEFAULTS.maxNumSeqs),
    kvCachePct: parseFloatOrDefault(data?.[CLUSTER.rtvi.nimKvCacheKey], RTVI_TUNING_DEFAULTS.kvCachePct),
    maxModelLen: parseIntOrDefault(data?.[CLUSTER.rtvi.nimMaxModelLenKey], RTVI_TUNING_DEFAULTS.maxModelLen),
  });
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

  const patches: Array<[string, string]> = [];

  if (tuning.maxNumSeqs !== undefined) {
    patches.push([CLUSTER.rtvi.nimMaxNumSeqsKey, String(tuning.maxNumSeqs)]);
  }
  if (tuning.kvCachePercent !== undefined) {
    patches.push([CLUSTER.rtvi.nimKvCacheKey, String(tuning.kvCachePercent)]);
  }
  if (tuning.maxModelLen !== undefined) {
    patches.push([CLUSTER.rtvi.nimMaxModelLenKey, String(tuning.maxModelLen)]);
  }

  // Helm path: NIM tuning ConfigMap is nvidia-nemotron-nano-9b-v2-nim-env.
  // Legacy path: NIM tuning ConfigMap is rtvi-runtime-env.
  const cmName = CLUSTER.rtvi.nimTuningConfigMap || CLUSTER.rtvi.runtimeEnvCm;
  const cmNs = CLUSTER.rtvi.nimTuningNamespace;

  try {
    for (const [key, val] of patches) {
      await patchConfigMapRawKey(cmNs, cmName, key, val);
    }
  } catch (err: unknown) {
    const { status, message } = extractK8sError(err);
    return NextResponse.json(
      { error: message, k8sCode: status },
      { status }
    );
  }

  // Helm path: NIM is a Deployment; legacy path: StatefulSet.
  const nimKind = CLUSTER.legacy ? ("StatefulSet" as const) : ("Deployment" as const);
  try {
    await rolloutRestart(nimKind, cmNs, CLUSTER.rtvi.nimStatefulSet);
  } catch (err) {
    return NextResponse.json(
      { error: `NIM rollout restart failed: ${String(err)}` },
      { status: 502 }
    );
  }

  const auditTarget = `${nimKind.toLowerCase()}/${CLUSTER.rtvi.nimStatefulSet}`;
  await auditLog(
    "tuning-rtvi",
    auditTarget,
    { patches: Object.fromEntries(patches) }
  );

  return NextResponse.json({
    ok: true,
    applied: Object.fromEntries(patches),
    restarted: auditTarget,
  });
});

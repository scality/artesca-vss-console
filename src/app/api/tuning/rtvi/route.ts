import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { z } from "zod";
import { rolloutRestart } from "@/lib/k8s";
import { patchConfigMapRawKey } from "@/lib/helpers/configmaps";
import { auditLog } from "@/lib/helpers/audit";
import { CLUSTER } from "@/lib/cluster-refs";

export const dynamic = "force-dynamic";

const RtviTuningSchema = z.object({
  maxNumSeqs: z.number().int().positive().optional(),
  kvCachePercent: z.number().min(0).max(1).optional(),
  maxModelLen: z.number().int().positive().optional(),
}).refine(
  (d) => Object.values(d).some((v) => v !== undefined),
  { message: "At least one tuning field is required" }
);

export async function PATCH(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => null);
  const parsed = RtviTuningSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Validation failed", issues: parsed.error.issues }, { status: 400 });
  }

  const tuning = parsed.data;
  const patches: Array<[string, string]> = [];

  if (tuning.maxNumSeqs !== undefined) {
    patches.push([CLUSTER.rtvi.nimMaxNumSeqsKey, String(tuning.maxNumSeqs)]);
  }
  if (tuning.kvCachePercent !== undefined) {
    // ConfigMap key is VLM_NIM_KVCACHE_PERCENT (k8s/rtvi/30-nim-cosmos-reason2-8b.yaml),
    // not NIM_KVCACHE_PERCENT — the NIM container's env var is NIM_KVCACHE_PERCENT
    // but the ConfigMap key it reads from is VLM_NIM_KVCACHE_PERCENT.
    patches.push([CLUSTER.rtvi.nimKvCacheKey, String(tuning.kvCachePercent)]);
  }
  if (tuning.maxModelLen !== undefined) {
    patches.push([CLUSTER.rtvi.nimMaxModelLenKey, String(tuning.maxModelLen)]);
  }

  try {
    for (const [key, val] of patches) {
      await patchConfigMapRawKey(CLUSTER.rtvi.nimNamespace, CLUSTER.rtvi.runtimeEnvCm, key, val);
    }
  } catch (err: unknown) {
    const k8sErr = err as { statusCode?: number; body?: { message?: string } };
    return NextResponse.json(
      { error: k8sErr.body?.message ?? String(err), k8sCode: k8sErr.statusCode },
      { status: k8sErr.statusCode ?? 502 }
    );
  }

  // All three keys (NIM_MAX_NUM_SEQS, VLM_NIM_KVCACHE_PERCENT, NIM_MAX_MODEL_LEN)
  // are env vars on the cosmos-reason2-8b NIM StatefulSet — see
  // k8s/rtvi/30-nim-cosmos-reason2-8b.yaml containers[0].env. rtvi-vlm does
  // not consume them, so restarting it would be a no-op.
  try {
    await rolloutRestart("StatefulSet", CLUSTER.rtvi.nimNamespace, CLUSTER.rtvi.nimStatefulSet);
  } catch (err) {
    return NextResponse.json(
      { error: `NIM rollout restart failed: ${String(err)}` },
      { status: 502 }
    );
  }

  await auditLog(
    "tuning-rtvi",
    `statefulset/${CLUSTER.rtvi.nimStatefulSet}`,
    { patches: Object.fromEntries(patches) }
  );

  return NextResponse.json({
    ok: true,
    applied: Object.fromEntries(patches),
    restarted: `statefulset/${CLUSTER.rtvi.nimStatefulSet}`,
  });
}

import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { z } from "zod";
import { rolloutRestart } from "@/lib/k8s";
import { patchConfigMapRawKey } from "@/lib/helpers/configmaps";
import { auditLog } from "@/lib/helpers/audit";
import { CLUSTER } from "@/lib/cluster-refs";

export const dynamic = "force-dynamic";

const AlertsTuningSchema = z.object({
  cooldownSeconds: z.number().int().nonnegative().optional(),
  slackWebhookConfigured: z.boolean().optional(),
}).refine(
  (d) => Object.values(d).some((v) => v !== undefined),
  { message: "At least one tuning field is required" }
);

export async function PATCH(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => null);
  const parsed = AlertsTuningSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Validation failed", issues: parsed.error.issues }, { status: 400 });
  }

  const tuning = parsed.data;
  const patches: Array<[string, string]> = [];

  if (tuning.cooldownSeconds !== undefined) {
    patches.push([CLUSTER.alertsTuning.cooldownKey, String(tuning.cooldownSeconds)]);
  }
  if (tuning.slackWebhookConfigured !== undefined) {
    patches.push([CLUSTER.alertsTuning.slackConfiguredKey, tuning.slackWebhookConfigured ? "true" : "false"]);
  }

  try {
    // Real ConfigMap is "alerts-runtime-env" (k8s/alerts/11-configmap-runtime-env.yaml),
    // not "alert-worker-config".
    for (const [key, val] of patches) {
      await patchConfigMapRawKey(CLUSTER.alertsTuning.namespace, CLUSTER.alertsTuning.configMap, key, val);
    }
  } catch (err: unknown) {
    const k8sErr = err as { statusCode?: number; body?: { message?: string } };
    return NextResponse.json(
      { error: k8sErr.body?.message ?? String(err), k8sCode: k8sErr.statusCode },
      { status: k8sErr.statusCode ?? 502 }
    );
  }

  // Rollout-restart alert-worker to apply new env
  try {
    await rolloutRestart("Deployment", CLUSTER.alertsTuning.namespace, CLUSTER.scenarios.alertWorkerDeployment);
  } catch (err) {
    return NextResponse.json(
      { error: `Rollout restart failed: ${String(err)}` },
      { status: 502 }
    );
  }

  await auditLog("tuning-alerts", `configmap/${CLUSTER.alertsTuning.configMap}`, { patches: Object.fromEntries(patches) });

  return NextResponse.json({ ok: true, applied: Object.fromEntries(patches) });
}

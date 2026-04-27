import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { z } from "zod";
import { coreV1, rolloutRestart } from "@/lib/k8s";
import { patchConfigMapRawKey } from "@/lib/helpers/configmaps";
import { auditLog } from "@/lib/helpers/audit";
import { CLUSTER } from "@/lib/cluster-refs";

export const dynamic = "force-dynamic";

// ─── GET ───────────────────────────────────────────────────────────────────────

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const warnings: string[] = [];

  try {
    const cm = await coreV1().readNamespacedConfigMap({
      name: CLUSTER.rtvi.runtimeEnvCm,
      namespace: CLUSTER.rtvi.nimNamespace,
    });

    const prompt = cm.data?.[CLUSTER.rtvi.promptKey] ?? "";
    const model = cm.data?.[CLUSTER.rtvi.modelKey] ?? "";
    const resourceVersion = cm.metadata?.resourceVersion;

    return NextResponse.json({ prompt, model, resourceVersion, warnings });
  } catch (err) {
    warnings.push(`rtvi-runtime-env unreadable: ${String(err)}`);
    return NextResponse.json({ prompt: "", model: "", warnings }, { status: 502 });
  }
}

// ─── PATCH ─────────────────────────────────────────────────────────────────────

const PatchPromptSchema = z.object({
  prompt: z.string().min(1),
  model: z.string().optional(),
});

export async function PATCH(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => null);
  const parsed = PatchPromptSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Validation failed", issues: parsed.error.issues }, { status: 400 });
  }

  const { prompt, model } = parsed.data;
  const ifMatch = req.headers.get("If-Match") ?? undefined;

  try {
    // Read current resourceVersion if not provided via If-Match
    let resourceVersion = ifMatch;
    if (!resourceVersion) {
      const cm = await coreV1().readNamespacedConfigMap({
        name: CLUSTER.rtvi.runtimeEnvCm,
        namespace: CLUSTER.rtvi.nimNamespace,
      });
      resourceVersion = cm.metadata?.resourceVersion;
    }

    await patchConfigMapRawKey(
      CLUSTER.rtvi.nimNamespace,
      CLUSTER.rtvi.runtimeEnvCm,
      CLUSTER.rtvi.promptKey,
      prompt,
      resourceVersion
    );

    // If model is changing, also patch the model key
    if (model) {
      await patchConfigMapRawKey(CLUSTER.rtvi.nimNamespace, CLUSTER.rtvi.runtimeEnvCm, CLUSTER.rtvi.modelKey, model);
    }
  } catch (err: unknown) {
    const k8sErr = err as { statusCode?: number; body?: { message?: string } };
    if (k8sErr.statusCode === 409) {
      return NextResponse.json(
        { error: "Config modified by another operator — reload and retry" },
        { status: 409 }
      );
    }
    return NextResponse.json(
      { error: `ConfigMap patch failed: ${String(err)}` },
      { status: 502 }
    );
  }

  // Rollout-restart rtvi-vlm (and NIM StatefulSet if model changed)
  const restartErrors: string[] = [];
  try {
    await rolloutRestart("Deployment", CLUSTER.rtvi.nimNamespace, CLUSTER.rtvi.vlmDeployment);
  } catch (err) {
    restartErrors.push(`${CLUSTER.rtvi.vlmDeployment} restart failed: ${String(err)}`);
  }

  if (model) {
    try {
      // cosmos-reason2-8b is a StatefulSet (k8s/vss/rtvi/30-nim-cosmos-reason2-8b.yaml)
      await rolloutRestart("StatefulSet", CLUSTER.rtvi.nimNamespace, CLUSTER.rtvi.nimStatefulSet);
    } catch {
      // Best-effort — NIM restart may be disallowed by RBAC or timing
    }
  }

  await auditLog("prompt-update", `configmap/${CLUSTER.rtvi.runtimeEnvCm}`, {
    promptLength: prompt.length,
    modelChanged: !!model,
    newModel: model,
  });

  return NextResponse.json({
    ok: true,
    restartErrors: restartErrors.length ? restartErrors : undefined,
  });
}

import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { z } from "zod";
import { appsV1 } from "@/lib/k8s";
import { auditLog } from "@/lib/helpers/audit";
import { CLUSTER } from "@/lib/cluster-refs";

export const dynamic = "force-dynamic";

const DemoDataSchema = z.object({
  enabled: z.boolean().optional(),
  tickRate: z.number().positive().optional(),
  matchProbability: z.number().min(0).max(1).optional(),
}).refine(
  (d) => Object.values(d).some((v) => v !== undefined),
  { message: "At least one field required" }
);

export async function PATCH(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => null);
  const parsed = DemoDataSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Validation failed", issues: parsed.error.issues }, { status: 400 });
  }

  const { enabled, tickRate, matchProbability } = parsed.data;
  const apps = appsV1();

  // Scale the deployment if enabled flag is specified
  // Real Deployment name is "demo-producer" (k8s/nvidia-vss/demo-data/20-producer.yaml).
  if (enabled !== undefined) {
    try {
      await apps.patchNamespacedDeployment({
        name: CLUSTER.demoData.deployment,
        namespace: CLUSTER.demoData.namespace,
        body: {
          spec: { replicas: enabled ? 1 : 0 },
        },
      });
    } catch (err: unknown) {
      const k8sErr = err as { statusCode?: number; body?: { message?: string } };
      return NextResponse.json(
        { error: k8sErr.body?.message ?? String(err), k8sCode: k8sErr.statusCode },
        { status: k8sErr.statusCode ?? 502 }
      );
    }
  }

  // Patch env vars if tick rate or match probability are specified.
  // Real env keys (k8s/nvidia-vss/demo-data/11-configmap-runtime-env.yaml):
  //   TICK_SECONDS  — integer seconds (not milliseconds)
  //   MATCH_PROBABILITY — float [0, 1]
  if (tickRate !== undefined || matchProbability !== undefined) {
    try {
      const deployment = await apps.readNamespacedDeployment({
        name: CLUSTER.demoData.deployment,
        namespace: CLUSTER.demoData.namespace,
      });

      const containers = deployment.spec?.template?.spec?.containers ?? [];
      const envPatch = containers.map((c) => {
        const existingEnv = c.env ?? [];
        const newEnv = [...existingEnv];

        if (tickRate !== undefined) {
          // TICK_SECONDS is in whole seconds (tickRate from API is also in seconds)
          const idx = newEnv.findIndex((e) => e.name === CLUSTER.demoData.tickSecondsEnv);
          const entry = { name: CLUSTER.demoData.tickSecondsEnv, value: String(Math.round(tickRate)) };
          if (idx >= 0) newEnv[idx] = entry;
          else newEnv.push(entry);
        }

        if (matchProbability !== undefined) {
          const idx = newEnv.findIndex((e) => e.name === CLUSTER.demoData.matchProbabilityEnv);
          const entry = { name: CLUSTER.demoData.matchProbabilityEnv, value: String(matchProbability) };
          if (idx >= 0) newEnv[idx] = entry;
          else newEnv.push(entry);
        }

        return { ...c, env: newEnv };
      });

      await apps.patchNamespacedDeployment({
        name: CLUSTER.demoData.deployment,
        namespace: CLUSTER.demoData.namespace,
        body: {
          spec: {
            template: {
              spec: { containers: envPatch },
            },
          },
        },
      });
    } catch (err: unknown) {
      const k8sErr = err as { statusCode?: number; body?: { message?: string } };
      return NextResponse.json(
        { error: k8sErr.body?.message ?? String(err), k8sCode: k8sErr.statusCode },
        { status: k8sErr.statusCode ?? 502 }
      );
    }
  }

  await auditLog("demo-data-update", `deployment/${CLUSTER.demoData.namespace}/${CLUSTER.demoData.deployment}`, {
    enabled,
    tickRate,
    matchProbability,
  });

  return NextResponse.json({
    ok: true,
    enabled,
    tickRate,
    matchProbability,
  });
}

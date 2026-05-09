import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { z } from "zod";
import { appsV1 } from "@/lib/k8s";
import { extractK8sError } from "@/lib/errors";
import { rejectIfKiosk } from "@/lib/kiosk-server";
import { auditLog } from "@/lib/helpers/audit";
import { CLUSTER } from "@/lib/cluster-refs";
import { dockerSock, dockerRecreateWithEnv } from "@/lib/helpers/docker-sock";

export const dynamic = "force-dynamic";

const DOCKER_MODE = process.env.CONSOLE_RUNTIME === "docker";

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

  const blocked = await rejectIfKiosk();
  if (blocked) return blocked;

  const body = await req.json().catch(() => null);
  const parsed = DemoDataSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Validation failed", issues: parsed.error.issues }, { status: 400 });
  }

  const { enabled, tickRate, matchProbability } = parsed.data;

  if (DOCKER_MODE) {
    const container = CLUSTER.demoData.dockerContainer;
    try {
      if (tickRate !== undefined || matchProbability !== undefined) {
        const envOverrides: Record<string, string> = {};
        if (tickRate !== undefined) {
          envOverrides[CLUSTER.demoData.tickSecondsEnv] = String(Math.round(tickRate));
        }
        if (matchProbability !== undefined) {
          envOverrides[CLUSTER.demoData.matchProbabilityEnv] = String(matchProbability);
        }
        await dockerRecreateWithEnv(container, envOverrides);
        // If disabled requested after recreate, stop the container
        if (enabled === false) {
          await dockerSock("POST", `/containers/${encodeURIComponent(container)}/stop?t=10`);
        }
      } else if (enabled !== undefined) {
        if (enabled) {
          await dockerSock("POST", `/containers/${encodeURIComponent(container)}/start`);
        } else {
          await dockerSock("POST", `/containers/${encodeURIComponent(container)}/stop?t=10`);
        }
      }
    } catch (err) {
      return NextResponse.json({ error: String(err), runtime: "docker" }, { status: 502 });
    }

    await auditLog("demo-data-update", `docker/${container}`, { enabled, tickRate, matchProbability });
    return NextResponse.json({ ok: true, enabled, tickRate, matchProbability, runtime: "docker" });
  }

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
      const { status, message } = extractK8sError(err);
      return NextResponse.json(
        { error: message, k8sCode: status },
        { status }
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
      const { status, message } = extractK8sError(err);
      return NextResponse.json(
        { error: message, k8sCode: status },
        { status }
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

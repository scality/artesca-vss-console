import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { appsV1 } from "@/lib/k8s";
import { extractK8sError } from "@/lib/errors";
import { rejectIfKiosk } from "@/lib/kiosk-server";
import { auditLog } from "@/lib/helpers/audit";
import { CLUSTER } from "@/lib/cluster-refs";
import { inspectContainer, dockerRecreateWithEnv } from "@/lib/helpers/docker-sock";

export const dynamic = "force-dynamic";

const DOCKER_MODE = process.env.CONSOLE_RUNTIME === "docker";
const REHEARSAL_DURATION_MS = 60_000;
const REHEARSAL_MATCH_PROBABILITY = "0.95";
const RESTORE_MATCH_PROBABILITY = "0.1";

export async function POST() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const blocked = await rejectIfKiosk();
  if (blocked) return blocked;

  if (DOCKER_MODE) {
    const container = CLUSTER.demoData.dockerContainer;

    // Read current MATCH_PROBABILITY so we can restore it after rehearsal
    let originalProbability = RESTORE_MATCH_PROBABILITY;
    const inspect = await inspectContainer(container);
    if (inspect) {
      const envLine = inspect.Config.Env.find((e) => e.startsWith("MATCH_PROBABILITY="));
      if (envLine) originalProbability = envLine.slice("MATCH_PROBABILITY=".length);
    }

    try {
      await dockerRecreateWithEnv(container, {
        [CLUSTER.demoData.matchProbabilityEnv]: REHEARSAL_MATCH_PROBABILITY,
      });
    } catch (err) {
      return NextResponse.json({ error: String(err), runtime: "docker" }, { status: 502 });
    }

    const startedAt = new Date().toISOString();
    await auditLog("rehearsal-start", `docker/${container}`, {
      matchProbability: REHEARSAL_MATCH_PROBABILITY,
      durationMs: REHEARSAL_DURATION_MS,
    });

    void (async () => {
      await new Promise((resolve) => setTimeout(resolve, REHEARSAL_DURATION_MS));
      try {
        await dockerRecreateWithEnv(container, {
          [CLUSTER.demoData.matchProbabilityEnv]: originalProbability,
        });
      } catch (err) {
        console.error("[rehearsal] docker restore failed:", err);
      }
    })();

    return NextResponse.json({
      ok: true,
      startedAt,
      restoreAfterMs: REHEARSAL_DURATION_MS,
      matchProbability: REHEARSAL_MATCH_PROBABILITY,
      runtime: "docker",
    });
  }

  const apps = appsV1();

  // Read current state so we can restore it
  let originalProbability = RESTORE_MATCH_PROBABILITY;
  let originalReplicas = 0;

  try {
    const dep = await apps.readNamespacedDeployment({
      name: "demo-data-producer",
      namespace: "demo-data",
    });
    originalReplicas = dep.spec?.replicas ?? 0;
    const probEnv = dep.spec?.template?.spec?.containers?.[0]?.env?.find(
      (e) => e.name === "MATCH_PROBABILITY"
    );
    if (probEnv?.value) originalProbability = probEnv.value;
  } catch {
    // best-effort read
  }

  // Scale up to 1 with high match probability
  try {
    await apps.patchNamespacedDeployment({
      name: "demo-data-producer",
      namespace: "demo-data",
      body: {
        spec: {
          replicas: 1,
          template: {
            spec: {
              containers: [
                {
                  name: "demo-data-producer",
                  env: [{ name: "MATCH_PROBABILITY", value: REHEARSAL_MATCH_PROBABILITY }],
                },
              ],
            },
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

  const startedAt = new Date().toISOString();

  await auditLog("rehearsal-start", "deployment/demo-data/demo-data-producer", {
    matchProbability: REHEARSAL_MATCH_PROBABILITY,
    durationMs: REHEARSAL_DURATION_MS,
  });

  // Schedule restore after 60 s — fire and forget (no await)
  // This runs in the background; the request returns immediately.
  void (async () => {
    await new Promise((resolve) => setTimeout(resolve, REHEARSAL_DURATION_MS));
    try {
      await apps.patchNamespacedDeployment({
        name: "demo-data-producer",
        namespace: "demo-data",
        body: {
          spec: {
            replicas: originalReplicas,
            template: {
              spec: {
                containers: [
                  {
                    name: "demo-data-producer",
                    env: [{ name: "MATCH_PROBABILITY", value: originalProbability }],
                  },
                ],
              },
            },
          },
        },
      });
    } catch (err) {
      console.error("[rehearsal] restore failed:", err);
    }
  })();

  return NextResponse.json({
    ok: true,
    startedAt,
    restoreAfterMs: REHEARSAL_DURATION_MS,
    matchProbability: REHEARSAL_MATCH_PROBABILITY,
  });
}

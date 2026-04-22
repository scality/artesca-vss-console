import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { appsV1 } from "@/lib/k8s";
import { auditLog } from "@/lib/helpers/audit";

export const dynamic = "force-dynamic";

const REHEARSAL_DURATION_MS = 60_000;
const REHEARSAL_MATCH_PROBABILITY = "0.95";
const RESTORE_MATCH_PROBABILITY = "0.1";

export async function POST() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

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
    const k8sErr = err as { statusCode?: number; body?: { message?: string } };
    return NextResponse.json(
      { error: k8sErr.body?.message ?? String(err), k8sCode: k8sErr.statusCode },
      { status: k8sErr.statusCode ?? 502 }
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

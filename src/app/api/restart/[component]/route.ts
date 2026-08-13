import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { rolloutRestart } from "@/lib/k8s";
import { extractK8sError } from "@/lib/errors";
import { rejectIfKiosk } from "@/lib/kiosk-server";
import { auditLog } from "@/lib/helpers/audit";
import { CLUSTER } from "@/lib/cluster-refs";
import { withRequestContext } from "@/lib/with-request-context";

export const dynamic = "force-dynamic";

// Component whitelist is centralized in cluster-refs.ts.
// Real names verified against k8s/ manifests:
//   - "nvidia-vss-agent" (not "agent") — k8s/nvidia-vss/agent/20-nvidia-vss-agent.yaml
//   - "cosmos-reason2-8b" as StatefulSet (not "nim-cosmos-reason2" Deployment)
const { restartable: RESTARTABLE } = CLUSTER;
const COMPOSE_PROJECT = process.env.COMPOSE_PROJECT_NAME ?? "mdx";

// Maps console component keys → docker compose service names.
// Only entries that differ from the component key need an override.
const DOCKER_SERVICE_NAMES: Record<string, string> = {
  "sensor-ms": "sensor-ms-dev",
  "streamprocessing-ms": "streamprocessing-ms-dev",
  "nvidia-vss-agent": "vss-agent",
  "alert-worker": "vss-video-analytics-api-alerts",
};

export const POST = withRequestContext(async (
  _req: Request,
  { params }: { params: Promise<{ component: string }> }
) => {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const blocked = await rejectIfKiosk();
  if (blocked) return blocked;

  const { component } = await params;
  const spec = RESTARTABLE[component];

  if (!spec) {
    return NextResponse.json(
      {
        error: `Unknown component: ${component}. Restartable components: ${Object.keys(RESTARTABLE).join(", ")}`,
      },
      { status: 400 }
    );
  }

  const restartedAt = new Date().toISOString();


  try {
    await rolloutRestart(spec.kind, spec.namespace, spec.name);
  } catch (err: unknown) {
    const { status, message } = extractK8sError(err);
    return NextResponse.json(
      { error: message, k8sCode: status },
      { status }
    );
  }

  await auditLog("restart", `${spec.namespace}/${spec.kind.toLowerCase()}/${spec.name}`, {
    component,
    ...spec,
    restartedAt,
  });

  return NextResponse.json({ ok: true, restartedAt });
});

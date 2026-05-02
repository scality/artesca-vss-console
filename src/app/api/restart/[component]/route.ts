import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { rolloutRestart } from "@/lib/k8s";
import { auditLog } from "@/lib/helpers/audit";
import { CLUSTER } from "@/lib/cluster-refs";

export const dynamic = "force-dynamic";

// Component whitelist is centralized in cluster-refs.ts.
// Real names verified against k8s/ manifests:
//   - "nvidia-vss-agent" (not "agent") — k8s/nvidia-vss/agent/20-nvidia-vss-agent.yaml
//   - "demo-producer" (not "demo-data-producer") — k8s/nvidia-vss/demo-data/20-producer.yaml
//   - "cosmos-reason2-8b" as StatefulSet (not "nim-cosmos-reason2" Deployment)
const { restartable: RESTARTABLE } = CLUSTER;

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ component: string }> }
) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

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

  try {
    await rolloutRestart(spec.kind, spec.namespace, spec.name);
  } catch (err: unknown) {
    const k8sErr = err as { statusCode?: number; body?: { message?: string } };
    const status = k8sErr.statusCode ?? 502;
    return NextResponse.json(
      { error: k8sErr.body?.message ?? String(err), k8sCode: status },
      { status }
    );
  }

  const restartedAt = new Date().toISOString();

  await auditLog("restart", `${spec.namespace}/${spec.kind.toLowerCase()}/${spec.name}`, {
    component,
    ...spec,
    restartedAt,
  });

  return NextResponse.json({ ok: true, restartedAt });
}

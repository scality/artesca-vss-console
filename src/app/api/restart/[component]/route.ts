import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { rolloutRestart } from "@/lib/k8s";
import { auditLog } from "@/lib/helpers/audit";
import { dockerSock, listComposeContainers } from "@/lib/helpers/docker-sock";
import { CLUSTER } from "@/lib/cluster-refs";

export const dynamic = "force-dynamic";

// Component whitelist is centralized in cluster-refs.ts.
// Real names verified against k8s/ manifests:
//   - "nvidia-vss-agent" (not "agent") — k8s/nvidia-vss/agent/20-nvidia-vss-agent.yaml
//   - "demo-producer" (not "demo-data-producer") — k8s/nvidia-vss/demo-data/20-producer.yaml
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

  const restartedAt = new Date().toISOString();

  if (process.env.CONSOLE_RUNTIME === "docker") {
    const serviceName = DOCKER_SERVICE_NAMES[component] ?? component;
    const containers = await listComposeContainers(COMPOSE_PROJECT);
    const target = containers.find(
      (c) => c.Labels["com.docker.compose.service"] === serviceName,
    );
    if (!target) {
      return NextResponse.json(
        { error: `No running container found for compose service "${serviceName}"` },
        { status: 404 },
      );
    }
    try {
      await dockerSock("POST", `/containers/${target.Id}/restart?t=10`);
    } catch (err) {
      return NextResponse.json({ error: String(err) }, { status: 502 });
    }
    await auditLog("restart", `docker/${serviceName}`, { component, serviceName, restartedAt });
    return NextResponse.json({ ok: true, restartedAt });
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

  await auditLog("restart", `${spec.namespace}/${spec.kind.toLowerCase()}/${spec.name}`, {
    component,
    ...spec,
    restartedAt,
  });

  return NextResponse.json({ ok: true, restartedAt });
}

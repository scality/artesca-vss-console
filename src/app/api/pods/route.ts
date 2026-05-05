import { NextResponse, type NextRequest } from "next/server";
import { type V1Pod } from "@kubernetes/client-node";
import { auth } from "@/lib/auth";
import { coreV1, watchedNamespaces } from "@/lib/k8s";
import { listComposeContainers } from "@/lib/helpers/docker-sock";
import type { PodSummary } from "@/lib/types";

export const dynamic = "force-dynamic";

function podAge(startTime: Date | string | undefined): string {
  if (!startTime) return "?";
  const ms = Date.now() - new Date(startTime).getTime();
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h${mins % 60}m`;
  const days = Math.floor(hrs / 24);
  return `${days}d${hrs % 24}h`;
}

function summarisePod(pod: V1Pod, ns: string): PodSummary {
  const phase = (pod.status?.phase ?? "Unknown") as PodSummary["phase"];
  const containers = pod.status?.containerStatuses ?? [];
  const restarts = containers.reduce((s, c) => s + (c.restartCount ?? 0), 0);
  const ready =
    pod.status?.conditions?.some(
      (c) => c.type === "Ready" && c.status === "True"
    ) ?? false;

  const gpuAnnotation = pod.metadata?.annotations?.["nvidia.com/gpu.present"];
  const gpus = gpuAnnotation ? 1 : undefined;

  return {
    namespace: ns,
    name: pod.metadata?.name ?? "?",
    phase,
    ready,
    restarts,
    age: podAge(pod.status?.startTime),
    node: pod.spec?.nodeName,
    gpus,
  };
}

const COMPOSE_PROJECT = process.env.COMPOSE_PROJECT_NAME ?? "mdx";

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (process.env.CONSOLE_RUNTIME === "docker") {
    const containers = await listComposeContainers(COMPOSE_PROJECT);
    const pods: PodSummary[] = containers.map((c) => {
      const svc = c.Labels["com.docker.compose.service"] ?? c.Names[0]?.replace(/^\//, "") ?? "unknown";
      const running = c.State === "running";
      const status = (c.Status ?? "").toLowerCase();
      const exitMatch = status.match(/exited \((\d+)\)/);
      const exitCode = exitMatch ? parseInt(exitMatch[1], 10) : null;
      const succeeded = c.State === "exited" && exitCode === 0;
      const healthy = running && (status.includes("(healthy)") || !status.includes("("));
      const phase: PodSummary["phase"] = running ? "Running" : succeeded ? "Succeeded" : "Failed";
      return {
        namespace: svc,
        name: c.Names[0]?.replace(/^\//, "") ?? c.Id.slice(0, 12),
        phase,
        ready: running ? healthy : succeeded,
        restarts: 0,
        age: c.Status ?? "?",
      };
    });
    return NextResponse.json({ pods, warnings: [] });
  }

  const ns = req.nextUrl.searchParams.get("ns");
  const namespaces = !ns || ns === "all" ? watchedNamespaces() : [ns];

  const warnings: string[] = [];
  const pods: PodSummary[] = [];

  await Promise.allSettled(
    namespaces.map(async (namespace) => {
      try {
        const podList = await coreV1().listNamespacedPod({ namespace });
        for (const pod of podList.items) {
          pods.push(summarisePod(pod, namespace));
        }
      } catch (err) {
        warnings.push(`Failed to list pods in ${namespace}: ${String(err)}`);
      }
    })
  );

  return NextResponse.json({ pods, warnings });
}

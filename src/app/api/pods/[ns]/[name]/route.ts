import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { coreV1 } from "@/lib/k8s";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ ns: string; name: string }> }
) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { ns, name } = await params;

  try {
    const pod = await coreV1().readNamespacedPod({ name, namespace: ns });

    // Return rich detail: full status, conditions, container states
    const containers = pod.status?.containerStatuses ?? [];
    const initContainers = pod.status?.initContainerStatuses ?? [];

    return NextResponse.json({
      namespace: ns,
      name: pod.metadata?.name,
      phase: pod.status?.phase ?? "Unknown",
      conditions: pod.status?.conditions ?? [],
      containers: containers.map((c) => ({
        name: c.name,
        ready: c.ready,
        restartCount: c.restartCount,
        image: c.image,
        state: c.state,
        lastState: c.lastState,
      })),
      initContainers: initContainers.map((c) => ({
        name: c.name,
        ready: c.ready,
        restartCount: c.restartCount,
        image: c.image,
        state: c.state,
      })),
      node: pod.spec?.nodeName,
      startTime: pod.status?.startTime,
      podIP: pod.status?.podIP,
      labels: pod.metadata?.labels ?? {},
      annotations: pod.metadata?.annotations ?? {},
      resourceRequests: pod.spec?.containers?.map((c) => ({
        name: c.name,
        requests: c.resources?.requests,
        limits: c.resources?.limits,
      })),
    });
  } catch (err: unknown) {
    const k8sErr = err as { statusCode?: number; body?: { message?: string } };
    const status = k8sErr.statusCode ?? 500;
    return NextResponse.json(
      { error: k8sErr.body?.message ?? String(err), k8sCode: status },
      { status }
    );
  }
}

import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { coreV1, watchedNamespaces } from "@/lib/k8s";
import type { Health } from "@/lib/types";

export const dynamic = "force-dynamic";

interface TopologyNode {
  id: string;
  type: string;
  label: string;
  health: Health;
  namespace?: string;
  podPhase?: string;
  details?: Record<string, unknown>;
  position: { x: number; y: number };
}

interface TopologyEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
  protocol?: string;
}

// Static component definitions with layout positions
const COMPONENTS: Array<{
  id: string;
  label: string;
  namespace: string;
  deploymentName?: string;
  position: { x: number; y: number };
}> = [
  { id: "camera-sim", label: "camera-sim (EC2)", namespace: "external", position: { x: 50, y: 300 } },
  { id: "mediamtx", label: "mediamtx RTSP", namespace: "external", position: { x: 200, y: 300 } },
  { id: "sensor-ms", label: "VST sensor-ms", namespace: "vst", deploymentName: "sensor-ms", position: { x: 400, y: 200 } },
  { id: "streamprocessing-ms", label: "VST streamprocessing-ms", namespace: "vst", deploymentName: "streamprocessing-ms", position: { x: 400, y: 400 } },
  { id: "rtvi-vlm", label: "rtvi-vlm", namespace: "rtvi", deploymentName: "rtvi-vlm", position: { x: 600, y: 200 } },
  { id: "rtvi-embed", label: "rtvi-embed", namespace: "rtvi", deploymentName: "rtvi-embed", position: { x: 600, y: 400 } },
  { id: "nim-cosmos-reason2", label: "NIM (Cosmos 2 8B)", namespace: "rtvi", deploymentName: "nim-cosmos-reason2", position: { x: 800, y: 200 } },
  { id: "kafka", label: "Kafka", namespace: "demo-data", position: { x: 700, y: 500 } },
  { id: "alert-worker", label: "alert-worker", namespace: "alerts", deploymentName: "alert-worker", position: { x: 900, y: 400 } },
  { id: "agent", label: "Agent UI", namespace: "agent", deploymentName: "agent", position: { x: 900, y: 200 } },
  { id: "redis", label: "Redis", namespace: "agent", position: { x: 1100, y: 300 } },
  { id: "demo-data-producer", label: "demo-data-producer", namespace: "demo-data", deploymentName: "demo-data-producer", position: { x: 500, y: 600 } },
];

// Static edges based on docs/architecture.md
const EDGES: TopologyEdge[] = [
  { id: "e-cam-mtx", source: "camera-sim", target: "mediamtx", label: "RTSP", protocol: "rtsp" },
  { id: "e-mtx-sensor", source: "mediamtx", target: "sensor-ms", label: "RTSP", protocol: "rtsp" },
  { id: "e-sensor-stream", source: "sensor-ms", target: "streamprocessing-ms", label: "gRPC", protocol: "grpc" },
  { id: "e-stream-rtvi", source: "streamprocessing-ms", target: "rtvi-vlm", label: "HTTP", protocol: "http" },
  { id: "e-rtvi-nim", source: "rtvi-vlm", target: "nim-cosmos-reason2", label: "HTTP", protocol: "http" },
  { id: "e-nim-rtvi", source: "nim-cosmos-reason2", target: "rtvi-vlm", label: "inference", protocol: "http" },
  { id: "e-rtvi-kafka", source: "rtvi-vlm", target: "kafka", label: "Kafka", protocol: "kafka" },
  { id: "e-kafka-alert", source: "kafka", target: "alert-worker", label: "Kafka", protocol: "kafka" },
  { id: "e-alert-redis", source: "alert-worker", target: "redis", label: "Redis", protocol: "redis" },
  { id: "e-redis-agent", source: "redis", target: "agent", label: "Redis", protocol: "redis" },
  { id: "e-demo-kafka", source: "demo-data-producer", target: "kafka", label: "Kafka", protocol: "kafka" },
];

function podPhaseToHealth(phase?: string, ready?: boolean): Health {
  if (!phase) return "unknown";
  if (phase === "Running" && ready) return "ok";
  if (phase === "Running") return "warn";
  if (phase === "Succeeded") return "ok";
  if (phase === "Pending") return "warn";
  if (phase === "Failed") return "fail";
  return "unknown";
}

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const warnings: string[] = [];

  // Build a health map by listing pods across watched namespaces
  const healthMap = new Map<string, Health>();

  for (const ns of watchedNamespaces()) {
    try {
      const podList = await coreV1().listNamespacedPod({ namespace: ns });
      for (const pod of podList.items) {
        const name = pod.metadata?.name ?? "";
        // Match pods to component IDs by prefix
        for (const comp of COMPONENTS) {
          if (
            comp.namespace === ns &&
            comp.deploymentName &&
            name.startsWith(comp.deploymentName)
          ) {
            const ready = pod.status?.conditions?.some(
              (c) => c.type === "Ready" && c.status === "True"
            ) ?? false;
            const h = podPhaseToHealth(pod.status?.phase, ready);
            // Worst health wins
            const existing = healthMap.get(comp.id);
            if (!existing || h === "fail" || (h === "warn" && existing === "ok")) {
              healthMap.set(comp.id, h);
            }
          }
        }
      }
    } catch (err) {
      warnings.push(`Pod list for ${ns} failed: ${String(err)}`);
    }
  }

  // Build nodes
  const nodes: TopologyNode[] = COMPONENTS.map((comp) => ({
    id: comp.id,
    type: comp.namespace === "external" ? "external" : "service",
    label: comp.label,
    health: healthMap.get(comp.id) ?? (comp.namespace === "external" ? "unknown" : "unknown"),
    namespace: comp.namespace !== "external" ? comp.namespace : undefined,
    position: comp.position,
  }));

  return NextResponse.json({ nodes, edges: EDGES, warnings });
}

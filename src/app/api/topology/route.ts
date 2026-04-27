import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { coreV1, watchedNamespaces } from "@/lib/k8s";
import { CLUSTER } from "@/lib/cluster-refs";
import type { Health } from "@/lib/types";
import type { NodeType } from "@/lib/types/pipeline";

export const dynamic = "force-dynamic";

interface TopologyNode {
  id: string;
  type: NodeType;
  label: string;
  health: Health;
  namespace?: string;
  podPhase?: string;
  details?: Record<string, unknown>;
  position: { x: number; y: number };
  /** For feed sub-nodes — groups them visually under camera-sim. */
  parent?: string;
}

interface TopologyEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
  protocol?: string;
  /** When true the edge is rendered dashed (dormant path). */
  dormant?: boolean;
}

// Static component definitions with layout positions.
// Well-known node IDs (used by frontend agents and the pipeline aggregator):
//   camera-sim, mediamtx, sensor-ms, streamprocessing-ms, rtvi-vlm, rtvi-embed,
//   nim-cosmos-reason2, kafka, alert-worker, agent, demo-data-producer,
//   artesca-s3, vst-local-cache, vst-postgres, vst-redis.
// Alerts reuses the VST Redis (see k8s/vss/alerts/README.md § "Known gaps"),
// so there is no separate alerts-redis node — the alert-worker edge points
// at vst-redis.
const COMPONENTS: Array<{
  id: string;
  label: string;
  namespace: string;
  type: NodeType;
  deploymentName?: string;
  position: { x: number; y: number };
}> = [
  // ── External ────────────────────────────────────────────────────────────────
  {
    id: "camera-sim",
    label: "camera-sim (EC2)",
    namespace: "external",
    type: "external",
    position: { x: 50, y: 300 },
  },
  {
    id: "mediamtx",
    label: "mediamtx RTSP",
    namespace: "external",
    type: "external",
    position: { x: 220, y: 300 },
  },

  // ── VST ─────────────────────────────────────────────────────────────────────
  {
    id: "sensor-ms",
    label: "VST sensor-ms",
    namespace: "vst",
    type: "service",
    deploymentName: "sensor-ms",
    position: { x: 420, y: 180 },
  },
  {
    id: "streamprocessing-ms",
    label: "VST streamprocessing-ms",
    namespace: "vst",
    type: "service",
    deploymentName: "streamprocessing-ms",
    position: { x: 420, y: 380 },
  },

  // ── RTVI ────────────────────────────────────────────────────────────────────
  {
    id: "rtvi-vlm",
    label: "rtvi-vlm",
    namespace: "rtvi",
    type: "service",
    deploymentName: "rtvi-vlm",
    position: { x: 640, y: 180 },
  },
  {
    id: "rtvi-embed",
    label: "rtvi-embed",
    namespace: "rtvi",
    type: "service",
    deploymentName: "rtvi-embed",
    position: { x: 640, y: 380 },
  },
  {
    id: "nim-cosmos-reason2",
    label: "NIM (Cosmos 2 8B)",
    namespace: "rtvi",
    type: "service",
    deploymentName: "nim-cosmos-reason2",
    position: { x: 860, y: 180 },
  },

  // ── Kafka / Redpanda ─────────────────────────────────────────────────────────
  {
    id: "kafka",
    label: "Kafka (Redpanda)",
    namespace: "rtvi",
    type: "service",
    deploymentName: "redpanda",
    position: { x: 750, y: 520 },
  },

  // ── Alerts ──────────────────────────────────────────────────────────────────
  {
    id: "alert-worker",
    label: "alert-worker",
    namespace: "alerts",
    type: "service",
    deploymentName: "alert-worker",
    position: { x: 960, y: 380 },
  },

  // ── Agent ────────────────────────────────────────────────────────────────────
  {
    id: "agent",
    label: "Agent UI",
    namespace: "agent",
    type: "service",
    deploymentName: "vss-agent",
    position: { x: 960, y: 180 },
  },

  // ── Demo data ────────────────────────────────────────────────────────────────
  {
    id: "demo-data-producer",
    label: "demo-data-producer",
    namespace: "demo-data",
    type: "service",
    deploymentName: "demo-producer",
    position: { x: 550, y: 620 },
  },

  // ── Storage nodes (new) ──────────────────────────────────────────────────────
  {
    id: "artesca-s3",
    label: "ARTESCA S3 (vss-video)",
    namespace: "storage",
    type: "storage",
    position: { x: 1180, y: 500 },
  },
  {
    id: "vst-local-cache",
    label: "VST local cache",
    namespace: "vst",
    type: "storage",
    position: { x: 640, y: 500 },
  },

  // ── Database / Redis nodes (new) ─────────────────────────────────────────────
  {
    id: "vst-postgres",
    label: "VST Postgres",
    namespace: "vst",
    type: "database",
    deploymentName: "postgres",
    position: { x: 280, y: 560 },
  },
  {
    id: "vst-redis",
    label: "VST Redis (vst.event + alert cooldowns)",
    namespace: "vst",
    type: "redis",
    deploymentName: "redis",
    position: { x: 420, y: 620 },
  },
];

// Static edges based on docs/architecture.md.
// Edge IDs use the convention edge:<source-id>-><target-id>.
const STATIC_EDGES: TopologyEdge[] = [
  // RTSP ingest path
  { id: "edge:camera-sim->mediamtx", source: "camera-sim", target: "mediamtx", label: "RTSP", protocol: "rtsp" },
  { id: "edge:mediamtx->sensor-ms", source: "mediamtx", target: "sensor-ms", label: "RTSP", protocol: "rtsp" },
  // VST internal
  { id: "edge:sensor-ms->streamprocessing-ms", source: "sensor-ms", target: "streamprocessing-ms", label: "gRPC", protocol: "grpc" },
  { id: "edge:streamprocessing-ms->rtvi-vlm", source: "streamprocessing-ms", target: "rtvi-vlm", label: "HTTP", protocol: "http" },
  // RTVI inference loop
  { id: "edge:rtvi-vlm->nim-cosmos-reason2", source: "rtvi-vlm", target: "nim-cosmos-reason2", label: "HTTP", protocol: "http" },
  { id: "edge:nim-cosmos-reason2->rtvi-vlm", source: "nim-cosmos-reason2", target: "rtvi-vlm", label: "inference", protocol: "http" },
  // Kafka paths
  { id: "edge:rtvi-vlm->kafka", source: "rtvi-vlm", target: "kafka", label: "Kafka", protocol: "kafka" },
  { id: "edge:kafka->alert-worker", source: "kafka", target: "alert-worker", label: "Kafka", protocol: "kafka" },
  { id: "edge:demo-data-producer->kafka", source: "demo-data-producer", target: "kafka", label: "Kafka", protocol: "kafka" },
  // Storage paths
  { id: "edge:sensor-ms->vst-local-cache", source: "sensor-ms", target: "vst-local-cache", label: "write", protocol: "file" },
  { id: "edge:vst-local-cache->artesca-s3", source: "vst-local-cache", target: "artesca-s3", label: "S3 PUT", protocol: "s3" },
  // Database paths
  { id: "edge:sensor-ms->vst-postgres", source: "sensor-ms", target: "vst-postgres", label: "metadata", protocol: "postgres" },
  { id: "edge:sensor-ms->vst-redis", source: "sensor-ms", target: "vst-redis", label: "vst.event", protocol: "redis" },
  // Alert Redis
  // alert-worker reuses the VST Redis for cooldown state (SETNX EX). See
  // k8s/vss/alerts/README.md § "Known gaps / follow-ups".
  { id: "edge:alert-worker->vst-redis", source: "alert-worker", target: "vst-redis", label: "Redis", protocol: "redis" },
  // Console clip playback (dormant)
  { id: "edge:console->artesca-s3", source: "console", target: "artesca-s3", label: "S3 GET", protocol: "s3", dormant: true },
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

interface VstSensorRaw {
  sensor_id?: string;
  sensorId?: string;
  [key: string]: unknown;
}

async function fetchFeedNodes(
  warnings: string[]
): Promise<TopologyNode[]> {
  try {
    const resp = await fetch(CLUSTER.vst.sensorListUrl, {
      next: { revalidate: 0 },
      signal: AbortSignal.timeout(2_000),
    });

    if (!resp.ok) {
      warnings.push(`VST sensor list returned HTTP ${resp.status} — no feed sub-nodes emitted`);
      return [];
    }

    const body = (await resp.json()) as
      | { sensors?: VstSensorRaw[] }
      | VstSensorRaw[];

    const sensors: VstSensorRaw[] = Array.isArray(body)
      ? body
      : (body as { sensors?: VstSensorRaw[] }).sensors ?? [];

    return sensors.map((s, i) => {
      const sensorId = s.sensor_id ?? s.sensorId ?? `sensor-${i}`;
      return {
        id: `feed:${sensorId}`,
        type: "feed" as NodeType,
        label: sensorId,
        health: "unknown" as Health,
        namespace: "external",
        parent: "camera-sim",
        // Lay out feed nodes slightly offset from camera-sim
        position: { x: 50 + i * 40, y: 420 + i * 30 },
      };
    });
  } catch (err) {
    warnings.push(`VST sensor list failed: ${String(err)} — no feed sub-nodes emitted`);
    return [];
  }
}

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const warnings: string[] = [];

  // ── Pod health map ──────────────────────────────────────────────────────────

  const healthMap = new Map<string, Health>();

  for (const ns of watchedNamespaces()) {
    try {
      const podList = await coreV1().listNamespacedPod({ namespace: ns });
      for (const pod of podList.items) {
        const name = pod.metadata?.name ?? "";
        for (const comp of COMPONENTS) {
          if (
            comp.namespace === ns &&
            comp.deploymentName &&
            name.startsWith(comp.deploymentName)
          ) {
            const ready =
              pod.status?.conditions?.some(
                (c) => c.type === "Ready" && c.status === "True"
              ) ?? false;
            const h = podPhaseToHealth(pod.status?.phase, ready);
            const existing = healthMap.get(comp.id);
            if (
              !existing ||
              h === "fail" ||
              (h === "warn" && existing === "ok")
            ) {
              healthMap.set(comp.id, h);
            }
          }
        }
      }
    } catch (err) {
      warnings.push(`Pod list for ${ns} failed: ${String(err)}`);
    }
  }

  // ── Build static nodes ──────────────────────────────────────────────────────

  const nodes: TopologyNode[] = COMPONENTS.map((comp) => ({
    id: comp.id,
    type: comp.type,
    label: comp.label,
    health: healthMap.get(comp.id) ?? "unknown",
    namespace:
      comp.namespace !== "external" && comp.namespace !== "storage"
        ? comp.namespace
        : undefined,
    position: comp.position,
  }));

  // ── Dynamic feed sub-nodes ──────────────────────────────────────────────────

  const feedNodes = await fetchFeedNodes(warnings);
  nodes.push(...feedNodes);

  // ── Feed edges (dynamic) ────────────────────────────────────────────────────

  const feedEdges: TopologyEdge[] = feedNodes.flatMap((fn) => [
    {
      id: `edge:${fn.id}->mediamtx`,
      source: fn.id,
      target: "mediamtx",
      label: "RTSP",
      protocol: "rtsp",
    },
  ]);

  const edges: TopologyEdge[] = [...STATIC_EDGES, ...feedEdges];

  return NextResponse.json({ nodes, edges, warnings });
}

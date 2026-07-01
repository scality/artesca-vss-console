import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { coreV1, listAllPodsInNs, watchedNamespaces } from "@/lib/k8s";
import { CLUSTER } from "@/lib/cluster-refs";
import { probeRecording } from "@/lib/helpers/recording-health";
import type { Health } from "@/lib/types";
import type { NodeType } from "@/lib/types/pipeline";

// Helm namespace for VSS components (e.g. "vss-alerts").
const VSS_NS = CLUSTER.vssNamespace;
import { HeadBucketCommand } from "@aws-sdk/client-s3";
import { makeS3Client, s3BucketForRecordings, s3Endpoint } from "@/lib/s3";

export const dynamic = "force-dynamic";

// Canonical recordings bucket name for display labels — matches the bucket the
// S3 collectors actually scan (CLUSTER.s3.buckets.recordings).
const RECORDINGS_BUCKET = s3BucketForRecordings();

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
// Helm layout (default): all VSS components in VSS_NS (e.g. vss-alerts).
// Legacy layout (CONSOLE_LEGACY_NAMESPACES=1): vst/rtvi/agent/alerts split.
//
// Well-known node IDs (used by frontend agents and the pipeline aggregator):
//   camera-sim, mediamtx, vss-vios-sensor, vss-vios-streamprocessing,
//   vss-rtvi-vlm, nim-nemotron-nano, kafka, vss-video-analytics-api,
//   vss-agent, demo-data-producer, artesca-s3, vst-local-cache,
//   vss-vios-postgres, vss-redis.
const COMPONENTS: Array<{
  id: string;
  label: string;
  namespace: string;
  type: NodeType;
  deploymentName?: string;
  position: { x: number; y: number };
}> = CLUSTER.legacy
  ? [
      // ── Legacy layout (CONSOLE_LEGACY_NAMESPACES=1) ─────────────────────────
      { id: "camera-sim",           label: "camera-sim (EC2)",                     namespace: "external",  type: "external",  position: { x: 50,   y: 300 } },
      { id: "mediamtx",             label: "mediamtx RTSP",                        namespace: "external",  type: "external",  position: { x: 220,  y: 300 } },
      { id: "sensor-ms",            label: "VST sensor-ms",                        namespace: "vst",       type: "service",   deploymentName: "sensor-ms",            position: { x: 420, y: 180 } },
      { id: "streamprocessing-ms",  label: "VST streamprocessing-ms",              namespace: "vst",       type: "service",   deploymentName: "streamprocessing-ms",   position: { x: 420, y: 380 } },
      { id: "rtvi-vlm",             label: "rtvi-vlm",                             namespace: "rtvi",      type: "service",   deploymentName: "rtvi-vlm",              position: { x: 640, y: 180 } },
      { id: "rtvi-embed",           label: "rtvi-embed",                           namespace: "rtvi",      type: "service",   deploymentName: "rtvi-embed",            position: { x: 640, y: 380 } },
      { id: "nim-cosmos-reason2",   label: "NIM (Cosmos 2 8B)",                    namespace: "rtvi",      type: "service",   deploymentName: "cosmos-reason2-8b",     position: { x: 860, y: 180 } },
      { id: "kafka",                label: "Kafka (Redpanda)",                     namespace: "rtvi",      type: "service",   deploymentName: "redpanda",              position: { x: 750, y: 520 } },
      { id: "alert-worker",         label: "alert-worker",                         namespace: "alerts",    type: "service",   deploymentName: "alert-worker",          position: { x: 960, y: 380 } },
      { id: "agent",                label: "Agent UI",                             namespace: "agent",     type: "service",   deploymentName: "nvidia-vss-agent",      position: { x: 960, y: 180 } },
      { id: "demo-data-producer",   label: "demo-data-producer",                   namespace: "demo-data", type: "service",   deploymentName: "demo-producer",         position: { x: 550, y: 620 } },
      { id: "artesca-s3",           label: `ARTESCA S3 (${RECORDINGS_BUCKET})`,        namespace: "storage",   type: "storage",   position: { x: 1180, y: 500 } },
      { id: "vst-local-cache",      label: "VST local cache",                      namespace: "vst",       type: "storage",   position: { x: 640,  y: 500 } },
      { id: "vst-postgres",         label: "VST Postgres",                         namespace: "vst",       type: "database",  deploymentName: "postgres",              position: { x: 280, y: 560 } },
      { id: "vst-redis",            label: "VST Redis",                            namespace: "vst",       type: "redis",     deploymentName: "redis",                 position: { x: 420, y: 620 } },
    ]
  : [
      // ── Helm layout (default) ───────────────────────────────────────────────
      // All VSS components in VSS_NS. Service names verified on live cluster 2026-05-11.
      { id: "camera-sim",                  label: "camera-sim (EC2)",                      namespace: "external", type: "external",  position: { x: 50,   y: 300 } },
      { id: "mediamtx",                    label: "mediamtx RTSP",                         namespace: "external", type: "external",  position: { x: 220,  y: 300 } },
      { id: "vss-vios-sensor",             label: "vss-vios-sensor",                       namespace: VSS_NS,     type: "service",   deploymentName: "vss-vios-sensor",             position: { x: 420, y: 180 } },
      { id: "vss-vios-streamprocessing",   label: "vss-vios-streamprocessing",             namespace: VSS_NS,     type: "service",   deploymentName: "vss-vios-streamprocessing",   position: { x: 420, y: 380 } },
      { id: "vss-rtvi-vlm",               label: "vss-rtvi-vlm",                          namespace: VSS_NS,     type: "service",   deploymentName: "vss-rtvi-vlm",               position: { x: 640, y: 180 } },
      { id: "nim-nemotron-nano",           label: "NIM (Nemotron Nano 9B)",                namespace: VSS_NS,     type: "service",   deploymentName: "nvidia-nemotron-nano-9b-v2", position: { x: 860, y: 180 } },
      { id: "kafka",                       label: "Kafka (Confluent)",                     namespace: VSS_NS,     type: "service",   deploymentName: "kafka",                      position: { x: 750, y: 520 } },
      { id: "vss-video-analytics-api",     label: "vss-video-analytics-api",               namespace: VSS_NS,     type: "service",   deploymentName: "vss-video-analytics-api",    position: { x: 960, y: 380 } },
      { id: "vss-agent",                   label: "vss-agent",                             namespace: VSS_NS,     type: "service",   deploymentName: "vss-agent",                  position: { x: 960, y: 180 } },
      { id: "demo-data-producer",          label: "demo-data-producer",                    namespace: "demo-data",type: "service",   deploymentName: "demo-producer",              position: { x: 550, y: 620 } },
      { id: "artesca-s3",                  label: `ARTESCA S3 (${RECORDINGS_BUCKET})`,         namespace: "storage",  type: "storage",   position: { x: 1180, y: 500 } },
      { id: "vst-local-cache",             label: "VST local cache",                       namespace: VSS_NS,     type: "storage",   position: { x: 640,  y: 500 } },
      { id: "vss-vios-postgres",           label: "vss-vios-postgres",                     namespace: VSS_NS,     type: "database",  deploymentName: "vss-vios-postgres",          position: { x: 280, y: 560 } },
      { id: "vss-redis",                   label: "Redis",                                 namespace: VSS_NS,     type: "redis",     deploymentName: "redis",                      position: { x: 420, y: 620 } },
    ];

// Static edges based on docs/architecture.md.
// Edge IDs use the convention edge:<source-id>-><target-id>.
// Helm layout uses updated node IDs; legacy layout uses the old ones.
const _LEGACY_STATIC_EDGES: TopologyEdge[] = [
  { id: "edge:camera-sim->mediamtx", source: "camera-sim", target: "mediamtx", label: "RTSP", protocol: "rtsp" },
  { id: "edge:mediamtx->sensor-ms", source: "mediamtx", target: "sensor-ms", label: "RTSP", protocol: "rtsp" },
  { id: "edge:sensor-ms->streamprocessing-ms", source: "sensor-ms", target: "streamprocessing-ms", label: "gRPC", protocol: "grpc" },
  { id: "edge:streamprocessing-ms->rtvi-vlm", source: "streamprocessing-ms", target: "rtvi-vlm", label: "HTTP", protocol: "http" },
  { id: "edge:rtvi-vlm->nim-cosmos-reason2", source: "rtvi-vlm", target: "nim-cosmos-reason2", label: "HTTP", protocol: "http" },
  { id: "edge:nim-cosmos-reason2->rtvi-vlm", source: "nim-cosmos-reason2", target: "rtvi-vlm", label: "inference", protocol: "http" },
  { id: "edge:rtvi-vlm->rtvi-embed", source: "rtvi-vlm", target: "rtvi-embed", label: "embed", protocol: "http" },
  { id: "edge:rtvi-embed->kafka", source: "rtvi-embed", target: "kafka", label: "embeddings", protocol: "kafka" },
  { id: "edge:agent->nim-cosmos-reason2", source: "agent", target: "nim-cosmos-reason2", label: "HTTP", protocol: "http" },
  { id: "edge:agent->sensor-ms", source: "agent", target: "sensor-ms", label: "HTTP", protocol: "http" },
  { id: "edge:rtvi-vlm->kafka", source: "rtvi-vlm", target: "kafka", label: "Kafka", protocol: "kafka" },
  { id: "edge:kafka->alert-worker", source: "kafka", target: "alert-worker", label: "Kafka", protocol: "kafka" },
  { id: "edge:demo-data-producer->kafka", source: "demo-data-producer", target: "kafka", label: "Kafka", protocol: "kafka" },
  { id: "edge:sensor-ms->vst-local-cache", source: "sensor-ms", target: "vst-local-cache", label: "write", protocol: "file" },
  { id: "edge:vst-local-cache->artesca-s3", source: "vst-local-cache", target: "artesca-s3", label: "S3 PUT", protocol: "s3" },
  { id: "edge:sensor-ms->vst-postgres", source: "sensor-ms", target: "vst-postgres", label: "metadata", protocol: "postgres" },
  { id: "edge:sensor-ms->vst-redis", source: "sensor-ms", target: "vst-redis", label: "vst.event", protocol: "redis" },
  { id: "edge:alert-worker->vst-redis", source: "alert-worker", target: "vst-redis", label: "Redis", protocol: "redis" },
  { id: "edge:console->artesca-s3", source: "console", target: "artesca-s3", label: "S3 GET", protocol: "s3", dormant: true },
];

const _HELM_STATIC_EDGES: TopologyEdge[] = [
  // RTSP ingest
  { id: "edge:camera-sim->mediamtx",                source: "camera-sim",               target: "mediamtx",              label: "RTSP",      protocol: "rtsp" },
  { id: "edge:mediamtx->vss-vios-sensor",           source: "mediamtx",                 target: "vss-vios-sensor",       label: "RTSP",      protocol: "rtsp" },
  // VIOS internal
  { id: "edge:vss-vios-sensor->vss-vios-stream",    source: "vss-vios-sensor",          target: "vss-vios-streamprocessing", label: "gRPC", protocol: "grpc" },
  { id: "edge:vss-vios-stream->vss-rtvi-vlm",       source: "vss-vios-streamprocessing",target: "vss-rtvi-vlm",          label: "HTTP",      protocol: "http" },
  // VLM inference
  { id: "edge:vss-rtvi-vlm->nim-nemotron-nano",     source: "vss-rtvi-vlm",             target: "nim-nemotron-nano",     label: "HTTP",      protocol: "http" },
  { id: "edge:nim-nemotron-nano->vss-rtvi-vlm",     source: "nim-nemotron-nano",        target: "vss-rtvi-vlm",          label: "inference", protocol: "http" },
  // Agent
  { id: "edge:vss-agent->nim-nemotron-nano",        source: "vss-agent",                target: "nim-nemotron-nano",     label: "HTTP",      protocol: "http" },
  { id: "edge:vss-agent->vss-vios-sensor",          source: "vss-agent",                target: "vss-vios-sensor",       label: "HTTP",      protocol: "http" },
  // Kafka paths
  { id: "edge:vss-rtvi-vlm->kafka",                 source: "vss-rtvi-vlm",             target: "kafka",                 label: "Kafka",     protocol: "kafka" },
  { id: "edge:kafka->vss-video-analytics-api",      source: "kafka",                    target: "vss-video-analytics-api",label: "Kafka",   protocol: "kafka" },
  { id: "edge:demo-data-producer->kafka",           source: "demo-data-producer",       target: "kafka",                 label: "Kafka",     protocol: "kafka" },
  // Storage paths
  { id: "edge:vss-vios-sensor->vst-local-cache",    source: "vss-vios-sensor",          target: "vst-local-cache",       label: "write",     protocol: "file" },
  { id: "edge:vst-local-cache->artesca-s3",         source: "vst-local-cache",          target: "artesca-s3",            label: "S3 PUT",    protocol: "s3" },
  // Database + Redis
  { id: "edge:vss-vios-sensor->vss-vios-postgres",  source: "vss-vios-sensor",          target: "vss-vios-postgres",     label: "metadata",  protocol: "postgres" },
  { id: "edge:vss-vios-sensor->vss-redis",          source: "vss-vios-sensor",          target: "vss-redis",             label: "vst.event", protocol: "redis" },
  { id: "edge:vss-rtvi-vlm->vss-redis",             source: "vss-rtvi-vlm",             target: "vss-redis",             label: "Redis",     protocol: "redis" },
  // Console clip playback (dormant)
  { id: "edge:console->artesca-s3",                 source: "console",                  target: "artesca-s3",            label: "S3 GET",    protocol: "s3", dormant: true },
];

const STATIC_EDGES: TopologyEdge[] = CLUSTER.legacy
  ? _LEGACY_STATIC_EDGES
  : _HELM_STATIC_EDGES;

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
  name?: string;
  /** VST lifecycle state — "online" | "removed" | … . VST keeps deleted
   *  sensors in /list as `state: "removed"`; those must not render. */
  state?: string;
  status?: string;
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

    // VST /list retains deleted sensors as `state: "removed"`, and a
    // delete+re-add leaves both the old (removed) and new (online) entry under
    // the same camera name. Drop removed sensors, then dedupe by display name
    // (prefer an online entry) so each camera renders once.
    const activeByName = new Map<string, VstSensorRaw>();
    for (const s of sensors) {
      const lifecycle = s.state ?? s.status;
      if (lifecycle === "removed") continue;
      const key = (s.name ?? "").trim();
      if (!key) continue; // skip nameless sensors — not a real camera to render
      const existing = activeByName.get(key);
      if (!existing || (existing.state ?? existing.status) !== "online") {
        activeByName.set(key, s);
      }
    }

    return await Promise.all(
      [...activeByName.values()].map(async (s, i) => {
        const sensorId = s.sensor_id ?? s.sensorId ?? `sensor-${i}`;
        // Ground-truth recording health (not the stale isTimelinePresent flag):
        // a feed node is only green when VST actually has a recent recording.
        const uuid = typeof s.sensorId === "string" ? s.sensorId : "";
        const rec = uuid ? await probeRecording(uuid) : "unknown";
        const health: Health =
          rec === "recording" ? "ok" : rec === "not-recording" ? "fail" : "unknown";
        return {
          id: `feed:${sensorId}`,
          type: "feed" as NodeType,
          label: s.name ?? sensorId, // friendly camera name; UUID is the stable id
          health,
          namespace: "external",
          parent: "camera-sim",
          // Lay out feed nodes slightly offset from camera-sim
          position: { x: 50 + i * 40, y: 420 + i * 30 },
        };
      }),
    );
  } catch (err) {
    warnings.push(`VST sensor list failed: ${String(err)} — no feed sub-nodes emitted`);
    return [];
  }
}

/* -------------------------------------------------------------------------- */
/* Docker-runtime topology (CONSOLE_RUNTIME=docker)                           */
/*                                                                            */
/* The default k8s-shaped graph is the wrong abstraction for the upstream     */
/* blueprint compose stack: pod namespaces don't exist, alert-worker/demo-    */
/* data are k8s-only, and most nodes report unknown health because there's    */
/* no kube-apiserver to query. This branch emits a clean stack-specific      */
/* graph derived from `docker ps` (via the daemon socket mounted read-only    */
/* at /var/run/docker.sock).                                                  */
/* -------------------------------------------------------------------------- */

interface DockerContainer {
  Id: string;
  Names: string[];
  Image: string;
  State: string;
  Status: string;
}

async function dockerListContainers(): Promise<DockerContainer[]> {
  // Talk to the daemon over its UNIX socket. Node's http supports
  // socketPath natively, no npm dep needed.
  const http = await import("node:http");
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath: "/var/run/docker.sock",
        path: "/containers/json?all=true",
        method: "GET",
        timeout: 4_000,
      },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(body) as DockerContainer[]);
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("docker.sock timeout")));
    req.end();
  });
}

function dockerHealth(c: DockerContainer | undefined): Health {
  if (!c) return "fail";
  if (c.State !== "running") return "fail";
  // Status string carries health: "Up 12 minutes (healthy)" etc.
  if (/\(healthy\)/i.test(c.Status)) return "ok";
  if (/\(unhealthy\)/i.test(c.Status)) return "fail";
  return "ok"; // running, no healthcheck → assume ok
}

/** Probe the configured S3 / ARTESCA endpoint and return a health status.
 *  SSL verification failures (custom CA not yet trusted) are reported as
 *  "warn" rather than "fail" because the endpoint IS reachable — the
 *  operator just needs to pass NODE_EXTRA_CA_CERTS or OBJECTSTORE_CA_BUNDLE. */
async function probeObjectStore(): Promise<Health> {
  const bucket = s3BucketForRecordings();
  if (!bucket) return "unknown";
  if (!s3Endpoint() && !process.env.AWS_ACCESS_KEY_ID && !process.env.OBJECTSTORE_ACCESS_KEY_ID) {
    return "unknown";
  }
  try {
    const client = makeS3Client();
    await Promise.race([
      client.send(new HeadBucketCommand({ Bucket: bucket })),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(Object.assign(new Error("probe timeout"), { code: "ETIMEOUT" })),
          3_000,
        ),
      ),
    ]);
    return "ok";
  } catch (err) {
    const msg = String((err as Error).message ?? err);
    const code = String((err as NodeJS.ErrnoException).code ?? "");
    if (/UNABLE_TO_VERIFY|CERT_UNTRUSTED|SELF_SIGNED|ERR_TLS/i.test(code + msg)) return "warn";
    if (/AccessDenied|403|404|NoSuchBucket/i.test(msg)) return "warn";
    return "fail";
  }
}

/**
 * Build a docker-stack topology. Layout is layered left-to-right by data
 * flow: ingest → processing → inference → agent / UI on top, storage +
 * messaging on bottom, observability on the right.
 */
async function buildDockerTopology() {
  const warnings: string[] = [];
  const [containers, s3Health] = await Promise.all([
    dockerListContainers().catch((e: Error) => {
      warnings.push(`docker socket unreachable: ${e.message}`);
      return [] as DockerContainer[];
    }),
    probeObjectStore().catch(() => "unknown" as Health),
  ]);

  // Lookup by container name (Docker prefixes a leading slash).
  const byName = new Map<string, DockerContainer>();
  for (const c of containers) {
    for (const n of c.Names) {
      byName.set(n.replace(/^\//, ""), c);
    }
  }

  // Node spec: id (also container name), label, type, position. Layout:
  //
  //   ┌─ INGEST ─┐ ┌─ PROCESSING ─┐ ┌─ INFERENCE ─┐ ┌─ AGENT/UI ─┐
  //   nvstreamer  sensor-ms       rtvi-vlm        nvidia-vss-agent       phoenix
  //               streamprocess.  cosmos VLM      nvidia-vss-va-mcp      kibana
  //               sdr-processing  (LLM=remote)    metropolis-ui
  //               envoy-process.                  nvidia-vss-console
  //   ┌── STORAGE / MESSAGING (bottom) ──┐
  //   centralizedb   redis   kafka   ES   logstash   nvidia-vss-video-analytics-api
  type NodeSpec = {
    id: string;
    label: string;
    type: NodeType;
    position: { x: number; y: number };
    details?: Record<string, unknown>;
  };
  const COL = (n: number) => 80 + n * 200;
  const ROW = (n: number) => 80 + n * 110;

  const specs: NodeSpec[] = [
    // INGEST col 0
    { id: "mdx-nvstreamer-alerts", label: "nvstreamer (alerts)", type: "external", position: { x: COL(0), y: ROW(0) } },

    // VST col 1 — three rows for sensor-ms, streamprocessing, sdr+envoy pair
    { id: "sensor-ms-dev", label: "sensor-ms", type: "service", position: { x: COL(1), y: ROW(0) } },
    { id: "streamprocessing-ms-dev", label: "streamprocessing-ms", type: "service", position: { x: COL(1), y: ROW(1) } },
    { id: "sdr-streamprocessing", label: "sdr (router)", type: "service", position: { x: COL(1), y: ROW(2) } },
    { id: "envoy-streamprocessing", label: "envoy ingress", type: "service", position: { x: COL(1), y: ROW(3) } },
    { id: "vst-mcp-dev", label: "vst-mcp", type: "service", position: { x: COL(1), y: ROW(4) } },
    { id: "vst-ingress-dev", label: "vst-ingress", type: "service", position: { x: COL(1), y: ROW(5) } },

    // VLM col 2
    { id: "rtvi-vlm", label: "rtvi-vlm", type: "service", position: { x: COL(2), y: ROW(0) } },
    { id: "cosmos-reason2-8b", label: "cosmos VLM (NIM)", type: "service", position: { x: COL(2), y: ROW(1) } },

    // AGENT / UI col 3
    { id: "vss-agent", label: "nvidia-vss-agent", type: "service", position: { x: COL(3), y: ROW(0) } },
    { id: "vss-va-mcp", label: "nvidia-vss-va-mcp", type: "service", position: { x: COL(3), y: ROW(1) } },
    { id: "metropolis-vss-ui", label: "metropolis UI", type: "service", position: { x: COL(3), y: ROW(2) } },
    { id: "nvidia-vss-console", label: "nvidia-vss-console (Scality)", type: "service", position: { x: COL(3), y: ROW(3) } },

    // STORAGE / MESSAGING (lower band)
    { id: "centralizedb-dev", label: "centralizedb (postgres)", type: "database", position: { x: COL(1), y: ROW(6) } },
    { id: "mdx-redis", label: "redis", type: "redis", position: { x: COL(2), y: ROW(6) } },
    { id: "mdx-kafka", label: "kafka", type: "service", position: { x: COL(3), y: ROW(6) } },
    { id: "mdx-elastic", label: "elasticsearch", type: "service", position: { x: COL(4), y: ROW(5) } },
    { id: "mdx-logstash", label: "logstash", type: "service", position: { x: COL(4), y: ROW(6) } },
    { id: "vss-video-analytics-api-alerts", label: "video-analytics-api", type: "service", position: { x: COL(4), y: ROW(2) } },

    // OBSERVABILITY col 4
    { id: "phoenix", label: "phoenix (traces)", type: "service", position: { x: COL(4), y: ROW(0) } },
    { id: "mdx-kibana", label: "kibana", type: "service", position: { x: COL(4), y: ROW(1) } },
  ];

  const nodes: TopologyNode[] = specs.map((s) => {
    const c = byName.get(s.id);
    return {
      id: s.id,
      type: s.type,
      label: s.label,
      health: dockerHealth(c),
      podPhase: c?.State,
      details: { image: c?.Image, status: c?.Status },
      position: s.position,
    };
  });

  nodes.push({
    id: "objectstore",
    type: "storage",
    label: "Object store (S3 / ARTESCA)",
    health: s3Health,
    details: { bucket: s3BucketForRecordings() || undefined, endpoint: s3Endpoint() || undefined },
    position: { x: COL(5), y: ROW(3) },
  });

  const edges: TopologyEdge[] = [
    { id: "stream-in", source: "mdx-nvstreamer-alerts", target: "sensor-ms-dev", protocol: "RTSP" },
    { id: "sensor-stream", source: "sensor-ms-dev", target: "streamprocessing-ms-dev", protocol: "frames" },
    { id: "stream-route", source: "streamprocessing-ms-dev", target: "sdr-streamprocessing", protocol: "events" },
    { id: "stream-ingress", source: "sdr-streamprocessing", target: "envoy-streamprocessing" },
    { id: "stream-vlm", source: "envoy-streamprocessing", target: "rtvi-vlm", protocol: "HTTP" },
    { id: "vlm-nim", source: "rtvi-vlm", target: "cosmos-reason2-8b", protocol: "OpenAI/HTTP" },
    { id: "vlm-kafka", source: "rtvi-vlm", target: "mdx-kafka", protocol: "mdx-vlm" },
    { id: "agent-vlm", source: "vss-agent", target: "rtvi-vlm", protocol: "HTTP" },
    { id: "agent-mcp", source: "vss-agent", target: "vss-va-mcp", protocol: "MCP" },
    { id: "agent-db", source: "vss-agent", target: "centralizedb-dev", protocol: "SQL" },
    { id: "ui-agent", source: "metropolis-vss-ui", target: "vss-agent", protocol: "HTTP" },
    { id: "console-agent", source: "nvidia-vss-console", target: "vss-agent", protocol: "HTTP" },
    { id: "console-jsonl", source: "rtvi-vlm", target: "nvidia-vss-console", protocol: "SSE→JSONL" },
    { id: "sensor-db", source: "sensor-ms-dev", target: "centralizedb-dev", protocol: "SQL" },
    { id: "sensor-redis", source: "sensor-ms-dev", target: "mdx-redis", protocol: "events" },
    { id: "kafka-api", source: "mdx-kafka", target: "vss-video-analytics-api-alerts", protocol: "consume" },
    { id: "es-logs", source: "mdx-logstash", target: "mdx-elastic", protocol: "Beats" },
    { id: "es-api", source: "vss-video-analytics-api-alerts", target: "mdx-elastic", protocol: "index" },
    { id: "kibana-es", source: "mdx-kibana", target: "mdx-elastic", protocol: "query" },
    { id: "stream-storage", source: "streamprocessing-ms-dev", target: "objectstore", protocol: "S3 PUT" },
    // vst-mcp-dev: MCP gateway — agent tool-routing (see architecture.md port table)
    { id: "agent-vst-mcp", source: "vss-agent", target: "vst-mcp-dev", protocol: "MCP" },
    { id: "vst-mcp-sensor", source: "vst-mcp-dev", target: "sensor-ms-dev", protocol: "HTTP" },
    // vst-ingress-dev: VST ingress — agent reaches sensor-ms through it
    { id: "agent-vst-ingress", source: "vss-agent", target: "vst-ingress-dev", protocol: "HTTP" },
    { id: "vst-ingress-sensor", source: "vst-ingress-dev", target: "sensor-ms-dev", protocol: "HTTP" },
    // phoenix: distributed tracing sink
    { id: "vlm-phoenix", source: "rtvi-vlm", target: "phoenix", protocol: "traces" },
    { id: "agent-phoenix", source: "vss-agent", target: "phoenix", protocol: "traces" },
  ];

  return { nodes, edges, warnings };
}

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (process.env.CONSOLE_RUNTIME === "docker") {
    const { nodes, edges, warnings } = await buildDockerTopology();
    return NextResponse.json({ nodes, edges, warnings });
  }

  const warnings: string[] = [];

  // ── Pod health map ──────────────────────────────────────────────────────────

  const healthMap = new Map<string, Health>();

  for (const ns of watchedNamespaces()) {
    try {
      const podItems = await listAllPodsInNs(coreV1(), ns);
      for (const pod of podItems) {
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

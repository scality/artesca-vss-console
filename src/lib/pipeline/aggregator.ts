import "server-only";

import { coreV1, runInPod, watchedNamespaces } from "@/lib/k8s";
import { CLUSTER } from "@/lib/cluster-refs";
import { promQuery } from "@/lib/helpers/prometheus";
import { getKafka } from "@/lib/kafka";
import { ListObjectsV2Command } from "@aws-sdk/client-s3";
import { makeS3Client } from "@/lib/s3";
import type {
  PipelineSnapshot,
  NodeRuntimeState,
  EdgeRuntimeState,
  PipelineHealth,
  PodState,
  GpuStateShort,
  S3State,
  CacheState,
  FeedState,
  NimState,
  KafkaTopicState,
  DbState,
  RedisState,
} from "@/lib/types/pipeline";

// ─── Constants ────────────────────────────────────────────────────────────────

// Hard-coded for the demo profile (sparseLoopDevice, 10×10 GiB).
// TODO: read from config after Phase 0 validation
const S3_CEILING_GIB = 100;

// Timeout for all individual external calls (ms)
const CALL_TIMEOUT_MS = 2_000;

// GPU index → primary node responsible
// GPU 0 → NIM, 1 → rtvi-vlm, 2 → rtvi-embed, 3 → sensor-ms + streamprocessing-ms
const GPU_INDEX_TO_NODE: Record<number, string> = {
  0: "nim-cosmos-reason2",
  1: "rtvi-vlm",
  2: "rtvi-embed",
  3: "sensor-ms",
};

// Kafka topics to inspect
const KAFKA_TOPICS = [
  CLUSTER.kafka.topics.visionLlm,
  CLUSTER.kafka.topics.incidents,
  CLUSTER.kafka.topics.visionLlmErrors,
  CLUSTER.kafka.topics.embedMessages,
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms)
    ),
  ]);
}

function podPhaseToHealth(
  phase?: string,
  ready?: boolean
): PipelineHealth {
  if (!phase) return "unknown";
  if (phase === "Running" && ready) return "ok";
  if (phase === "Running") return "warn";
  if (phase === "Succeeded") return "ok";
  if (phase === "Pending") return "warn";
  if (phase === "Failed") return "fail";
  return "unknown";
}

// ─── Pods ─────────────────────────────────────────────────────────────────────

interface PodSnapshot {
  nodeId: string;
  state: PodState;
}

// Map deployment prefix → node ID (mirrors topology route definitions)
const DEPLOY_TO_NODE: Record<string, string> = {
  "sensor-ms": "sensor-ms",
  "streamprocessing-ms": "streamprocessing-ms",
  "rtvi-vlm": "rtvi-vlm",
  "rtvi-embed": "rtvi-embed",
  "cosmos-reason2-8b": "nim-cosmos-reason2",
  "nim-cosmos-reason2": "nim-cosmos-reason2",
  "alert-worker": "alert-worker",
  "vss-agent": "agent",
  "agent": "agent",
  "demo-producer": "demo-data-producer",
  "demo-data-producer": "demo-data-producer",
  "redpanda": "kafka",
};

async function collectPods(warnings: string[]): Promise<PodSnapshot[]> {
  const results: PodSnapshot[] = [];
  const namespaces = watchedNamespaces();

  const settled = await Promise.allSettled(
    namespaces.map((ns) =>
      withTimeout(
        coreV1().listNamespacedPod({ namespace: ns }),
        CALL_TIMEOUT_MS
      ).then((list) => ({ ns, list }))
    )
  );

  for (const s of settled) {
    if (s.status === "rejected") {
      warnings.push(`Pod list failed: ${String(s.reason)}`);
      continue;
    }
    const { ns, list } = s.value;
    for (const pod of list.items) {
      const podName = pod.metadata?.name ?? "";
      const ready =
        pod.status?.conditions?.some(
          (c) => c.type === "Ready" && c.status === "True"
        ) ?? false;

      let matchedNodeId: string | undefined;
      for (const [prefix, nodeId] of Object.entries(DEPLOY_TO_NODE)) {
        if (podName.startsWith(prefix)) {
          matchedNodeId = nodeId;
          break;
        }
      }
      if (!matchedNodeId) continue;

      const startTime = pod.status?.startTime
        ? new Date(pod.status.startTime as unknown as string).getTime()
        : Date.now();
      const ageSecs = Math.round((Date.now() - startTime) / 1000);

      const restarts =
        pod.status?.containerStatuses?.reduce(
          (sum, cs) => sum + (cs.restartCount ?? 0),
          0
        ) ?? 0;

      results.push({
        nodeId: matchedNodeId,
        state: {
          namespace: ns,
          phase: (pod.status?.phase ?? "Unknown") as PodState["phase"],
          ready,
          restarts,
          ageSecs,
        },
      });
    }
  }

  return results;
}

// ─── GPUs ─────────────────────────────────────────────────────────────────────

interface GpuEntry {
  nodeId: string;
  gpu: GpuStateShort;
}

async function collectGpus(warnings: string[]): Promise<GpuEntry[]> {
  try {
    const [utilRes, fbUsedRes, fbTotalRes] = await Promise.all([
      withTimeout(promQuery("DCGM_FI_DEV_GPU_UTIL"), CALL_TIMEOUT_MS),
      withTimeout(promQuery("DCGM_FI_DEV_FB_USED"), CALL_TIMEOUT_MS),
      withTimeout(promQuery("DCGM_FI_DEV_FB_TOTAL"), CALL_TIMEOUT_MS),
    ]);

    for (const r of [utilRes, fbUsedRes, fbTotalRes]) {
      if (r.warning) warnings.push(r.warning);
    }

    const gpuIndexSet = new Set<string>();
    for (const r of [utilRes, fbUsedRes, fbTotalRes]) {
      for (const item of r.results) {
        const idx = item.metric["gpu"] ?? item.metric["GPU"] ?? "0";
        gpuIndexSet.add(idx);
      }
    }

    if (gpuIndexSet.size === 0) return [];

    const entries: GpuEntry[] = [];
    for (const gpuIdx of gpuIndexSet) {
      const getVal = (res: typeof utilRes) => {
        const found = res.results.find(
          (r) => (r.metric["gpu"] ?? r.metric["GPU"]) === gpuIdx
        );
        return found ? parseFloat(found.value[1]) : 0;
      };

      const fbUsed = getVal(fbUsedRes); // MiB
      const fbTotal = getVal(fbTotalRes); // MiB
      const idx = parseInt(gpuIdx, 10);
      const nodeId = GPU_INDEX_TO_NODE[idx] ?? "unknown";

      entries.push({
        nodeId,
        gpu: {
          index: idx,
          utilPct: getVal(utilRes),
          memUsedGiB: fbUsed / 1024,
          memTotalGiB: (fbTotal || 1) / 1024,
        },
      });
    }

    return entries;
  } catch (err) {
    warnings.push(`GPU metrics failed: ${String(err)}`);
    return [];
  }
}

// ─── S3 ───────────────────────────────────────────────────────────────────────

// Simple in-memory put-rate sample (mirrors storage/vst logic; no Redis dep here)
interface BucketSample {
  ts: number;
  count: number;
  bytes: number;
}
const _putRateSample = new Map<string, BucketSample>();

async function collectS3(warnings: string[]): Promise<S3State | null> {
  const bucket = CLUSTER.s3.bucket;
  const s3 = makeS3Client();
  const nowMs = Date.now();

  try {
    // Bounded scan (1 page = 1000 keys max) — fast, keeps under 2 s
    const resp = await withTimeout(
      s3.send(new ListObjectsV2Command({ Bucket: bucket, MaxKeys: 1000 })),
      CALL_TIMEOUT_MS
    );

    const objects = resp.Contents ?? [];
    const objectCount = objects.length;
    const bytesTotal = objects.reduce((s, o) => s + (o.Size ?? 0), 0);
    const truncated = !!resp.IsTruncated;

    // PUT rate from in-memory delta
    const prev = _putRateSample.get(bucket);
    let putRateMBps = 0;
    let putRateObjPerMin = 0;

    if (prev) {
      const deltaS = (nowMs - prev.ts) / 1000;
      if (deltaS > 0) {
        const deltaBytes = Math.max(0, bytesTotal - prev.bytes);
        const deltaObjs = Math.max(0, objectCount - prev.count);
        putRateMBps = deltaBytes / 1024 / 1024 / deltaS;
        putRateObjPerMin = (deltaObjs / deltaS) * 60;
      }
    }

    _putRateSample.set(bucket, { ts: nowMs, count: objectCount, bytes: bytesTotal });

    const ceilingBytes = S3_CEILING_GIB * 1024 * 1024 * 1024;
    const ceilingPct = (bytesTotal / ceilingBytes) * 100;

    return {
      bucket,
      objectCount,
      bytesTotal,
      putRateMBps,
      putRateObjPerMin,
      ceilingGiB: S3_CEILING_GIB,
      ceilingPct,
      bucketScanTruncated: truncated,
      bucketScanStaleSecs: 0,
    };
  } catch (err) {
    warnings.push(`S3 scan failed: ${String(err)}`);
    return null;
  }
}

// ─── Local cache (VST emptyDir) ───────────────────────────────────────────────

async function collectCache(warnings: string[]): Promise<CacheState | null> {
  try {
    const fillResult = await withTimeout(
      runInPod(
        CLUSTER.vst.namespace,
        "app=sensor-ms",
        [
          "sh",
          "-c",
          "df -P /home/vst/vst_release/vst_video 2>/dev/null | awk 'NR==2 {print $5}'",
        ],
        CALL_TIMEOUT_MS
      ),
      CALL_TIMEOUT_MS + 500
    );

    const raw = fillResult.stdout.trim().replace("%", "");
    const fillPct = parseFloat(raw);

    // Frame drops from Prometheus — best-effort, already bounded at 2 s
    type PromFallback = { results: Array<{ metric: Record<string, string>; value: [number, string] }>; warning?: string };
    const emptyPromResult: PromFallback = { results: [] };

    const [dropCountRes, dropRateRes] = await Promise.all([
      withTimeout(
        promQuery("max(recorder_frames_dropped_total)"),
        CALL_TIMEOUT_MS
      ).catch((): PromFallback => emptyPromResult),
      withTimeout(
        promQuery("sum(rate(recorder_frames_dropped_total[5m]))"),
        CALL_TIMEOUT_MS
      ).catch((): PromFallback => emptyPromResult),
    ]);

    const parsePromVal = (res: PromFallback) =>
      res.results[0]?.value?.[1] !== undefined
        ? parseFloat(res.results[0].value[1])
        : null;

    const rawCount = parsePromVal(dropCountRes);
    const rawRate = parsePromVal(dropRateRes);

    return {
      fillPct: isNaN(fillPct) ? null : fillPct,
      thresholdPct: 90,
      sizeGiB: 500, // emptyDir — see k8s/vst/30-sensor-ms.yaml
      frameDropCount: rawCount !== null && !isNaN(rawCount) ? rawCount : null,
      frameDropRatePerMin:
        rawRate !== null && !isNaN(rawRate) ? rawRate * 60 : null,
    };
  } catch (err) {
    warnings.push(`Cache stats unavailable: ${String(err)}`);
    return null;
  }
}

// ─── VST feed nodes ───────────────────────────────────────────────────────────

interface VstSensorRaw {
  sensor_id?: string;
  sensorId?: string;
  bitrate?: number;
  bitrate_mbps?: number;
  codec?: string;
  width?: number;
  height?: number;
  fps?: number;
  gop?: number;
  last_frame_ts?: number; // epoch ms
  registered?: boolean;
  [key: string]: unknown;
}

async function collectFeeds(
  warnings: string[]
): Promise<Array<{ nodeId: string; state: FeedState }>> {
  try {
    const resp = await withTimeout(
      fetch(CLUSTER.vst.sensorListUrl, {
        next: { revalidate: 0 },
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      }),
      CALL_TIMEOUT_MS + 200
    );

    if (!resp.ok) {
      warnings.push(`VST sensor list returned HTTP ${resp.status}`);
      return [];
    }

    const body = (await resp.json()) as
      | { sensors?: VstSensorRaw[] }
      | VstSensorRaw[];

    const sensors: VstSensorRaw[] = Array.isArray(body)
      ? body
      : (body as { sensors?: VstSensorRaw[] }).sensors ?? [];

    const nowMs = Date.now();

    return sensors.map((s) => {
      const sensorId = s.sensor_id ?? s.sensorId ?? "unknown";
      const lastFrameTs =
        typeof s.last_frame_ts === "number" ? s.last_frame_ts : null;
      const rawCodec = (s.codec ?? "").toLowerCase();
      const codec: FeedState["codec"] =
        rawCodec.includes("265") || rawCodec === "hevc"
          ? "h265"
          : rawCodec.includes("264")
          ? "h264"
          : "unknown";

      return {
        nodeId: `feed:${sensorId}`,
        state: {
          sensorId,
          bitrateMbps: s.bitrate_mbps ?? (s.bitrate ? s.bitrate / 1000 : null),
          codec,
          resolution:
            s.width && s.height ? { width: s.width, height: s.height } : null,
          fps: s.fps ?? null,
          gop: s.gop ?? null,
          vstRegistered: s.registered ?? true,
          lastFrameAgoMs:
            lastFrameTs !== null ? nowMs - lastFrameTs : null,
        } satisfies FeedState,
      };
    });
  } catch (err) {
    warnings.push(`VST feed list failed: ${String(err)}`);
    return [];
  }
}

// ─── Kafka ────────────────────────────────────────────────────────────────────

// Previous-tick offset totals for rate computation — module-level, survives across ticks.
const _kafkaOffsetSample = new Map<string, { ts: number; totalOffset: number }>();

async function collectKafka(
  warnings: string[]
): Promise<KafkaTopicState[]> {
  const { instance } = getKafka();
  if (!instance) {
    warnings.push("Kafka not configured — set KAFKA_BROKERS");
    return KAFKA_TOPICS.map((name) => ({ name, msgRatePerSec: null, lagMsgs: null }));
  }

  const admin = instance.admin();
  let connected = false;

  try {
    await withTimeout(admin.connect(), CALL_TIMEOUT_MS);
    connected = true;

    const offsetResults = await Promise.allSettled(
      KAFKA_TOPICS.map((topic) =>
        withTimeout(admin.fetchTopicOffsets(topic), CALL_TIMEOUT_MS)
      )
    );

    const nowMs = Date.now();
    return KAFKA_TOPICS.map((name, i) => {
      const settled = offsetResults[i];
      if (settled.status === "rejected") {
        return { name, msgRatePerSec: null, lagMsgs: null };
      }
      const partitions = settled.value;
      const totalOffset = partitions.reduce((sum, p) => sum + Number(p.offset), 0);

      // Rate from previous-tick sample. First tick → null.
      const prev = _kafkaOffsetSample.get(name);
      _kafkaOffsetSample.set(name, { ts: nowMs, totalOffset });
      if (!prev) return { name, msgRatePerSec: null, lagMsgs: null };

      const dtSec = (nowMs - prev.ts) / 1_000;
      if (dtSec <= 0) return { name, msgRatePerSec: null, lagMsgs: null };

      const delta = totalOffset - prev.totalOffset;
      // Guard against broker restart (offset reset / retention truncation)
      const msgRatePerSec = delta >= 0 ? delta / dtSec : null;
      return { name, msgRatePerSec, lagMsgs: null };
    });
  } catch (err) {
    warnings.push(`Kafka admin failed: ${String(err)}`);
    return KAFKA_TOPICS.map((name) => ({ name, msgRatePerSec: null, lagMsgs: null }));
  } finally {
    if (connected) await admin.disconnect().catch(() => undefined);
  }
}

// ─── NIM ─────────────────────────────────────────────────────────────────────

async function collectNim(warnings: string[]): Promise<NimState | null> {
  // Model name from the RTVI runtime-env ConfigMap (best-effort)
  const modelEnvKey = CLUSTER.rtvi.modelKey;
  const modelFromEnv = process.env[modelEnvKey] ?? "cosmos-reason2-8b";

  try {
    // NIM health: GET /v1/health/ready — 200 = ready (warmupPct=100), else 503
    const nimBase =
      process.env.NIM_ENDPOINT ??
      "http://cosmos-reason2-8b.rtvi.svc.cluster.local:8000";

    const [healthResp, tokensRes, latP50Res, latP95Res] = await Promise.allSettled([
      withTimeout(
        fetch(`${nimBase}/v1/health/ready`, {
          signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
        }),
        CALL_TIMEOUT_MS
      ),
      withTimeout(
        promQuery("nim_tokens_per_second"),
        CALL_TIMEOUT_MS
      ),
      withTimeout(
        promQuery(
          'histogram_quantile(0.50, sum(rate(nim_request_latency_seconds_bucket[5m])) by (le))'
        ),
        CALL_TIMEOUT_MS
      ),
      withTimeout(
        promQuery(
          'histogram_quantile(0.95, sum(rate(nim_request_latency_seconds_bucket[5m])) by (le))'
        ),
        CALL_TIMEOUT_MS
      ),
    ]);

    const warmupPct =
      healthResp.status === "fulfilled" && healthResp.value.ok ? 100 : 0;

    const parsePromSingle = (
      r: PromiseSettledResult<{ results: Array<{ value: [number, string] }> }>
    ): number | null => {
      if (r.status === "rejected") return null;
      const raw = r.value.results[0]?.value?.[1];
      if (raw === undefined) return null;
      const n = parseFloat(raw);
      return isNaN(n) ? null : n;
    };

    const tokensPerSec = parsePromSingle(tokensRes);
    const p50Secs = parsePromSingle(latP50Res);
    const p95Secs = parsePromSingle(latP95Res);

    for (const r of [tokensRes, latP50Res, latP95Res]) {
      if (r.status === "fulfilled" && r.value.warning) {
        warnings.push(r.value.warning);
      }
    }

    return {
      model: modelFromEnv,
      warmupPct,
      tokensPerSec,
      inferenceLatencyP50Ms: p50Secs !== null ? p50Secs * 1000 : null,
      inferenceLatencyP95Ms: p95Secs !== null ? p95Secs * 1000 : null,
      queueDepth: null, // no Prometheus metric for queue depth at time of writing
    };
  } catch (err) {
    warnings.push(`NIM metrics failed: ${String(err)}`);
    return null;
  }
}

// ─── Postgres ─────────────────────────────────────────────────────────────────

async function collectPostgres(warnings: string[]): Promise<DbState | null> {
  try {
    const result = await withTimeout(
      runInPod(
        CLUSTER.vst.namespace,
        "app=postgres", // label used by k8s/vst postgres Deployment
        ["pg_isready", "-q"],
        CALL_TIMEOUT_MS
      ),
      CALL_TIMEOUT_MS + 500
    );
    const up = result.code === 0;

    // Connection count — best-effort
    let connections: number | null = null;
    let sizeMiB: number | null = null;

    if (up) {
      try {
        const connResult = await withTimeout(
          runInPod(
            CLUSTER.vst.namespace,
            "app=postgres",
            [
              "psql",
              "-U",
              process.env.POSTGRES_USER ?? "vst",
              "-tAc",
              "SELECT count(*) FROM pg_stat_activity;",
            ],
            CALL_TIMEOUT_MS
          ),
          CALL_TIMEOUT_MS + 500
        );
        connections = parseInt(connResult.stdout.trim(), 10) || null;
      } catch {
        // non-fatal
      }

      try {
        const sizeResult = await withTimeout(
          runInPod(
            CLUSTER.vst.namespace,
            "app=postgres",
            [
              "psql",
              "-U",
              process.env.POSTGRES_USER ?? "vst",
              "-tAc",
              "SELECT pg_database_size(current_database()) / 1024 / 1024;",
            ],
            CALL_TIMEOUT_MS
          ),
          CALL_TIMEOUT_MS + 500
        );
        sizeMiB = parseFloat(sizeResult.stdout.trim()) || null;
      } catch {
        // non-fatal
      }
    }

    return { up, connections, sizeMiB };
  } catch (err) {
    warnings.push(`Postgres probe failed: ${String(err)}`);
    return { up: false, connections: null, sizeMiB: null };
  }
}

// ─── Redis ────────────────────────────────────────────────────────────────────

async function collectRedis(
  namespace: string,
  labelSelector: string,
  warnings: string[],
  warnPrefix: string
): Promise<RedisState | null> {
  try {
    const result = await withTimeout(
      runInPod(
        namespace,
        labelSelector,
        ["redis-cli", "ping"],
        CALL_TIMEOUT_MS
      ),
      CALL_TIMEOUT_MS + 500
    );

    const up = result.stdout.trim().toUpperCase() === "PONG";

    let connectedClients: number | null = null;
    let memUsedMiB: number | null = null;

    if (up) {
      try {
        const infoResult = await withTimeout(
          runInPod(
            namespace,
            labelSelector,
            ["redis-cli", "info", "all"],
            CALL_TIMEOUT_MS
          ),
          CALL_TIMEOUT_MS + 500
        );

        for (const line of infoResult.stdout.split("\n")) {
          const [k, v] = line.split(":").map((s) => s.trim());
          if (k === "connected_clients" && v) {
            connectedClients = parseInt(v, 10) || null;
          }
          if (k === "used_memory" && v) {
            memUsedMiB = parseInt(v, 10) / 1024 / 1024 || null;
          }
        }
      } catch {
        // non-fatal
      }
    }

    return { up, connectedClients, memUsedMiB };
  } catch (err) {
    warnings.push(`${warnPrefix} Redis probe failed: ${String(err)}`);
    return { up: false, connectedClients: null, memUsedMiB: null };
  }
}

// ─── Edge computation ─────────────────────────────────────────────────────────

function buildEdges(
  nodeMap: Record<string, NodeRuntimeState>,
  feedNodeIds: string[]
): Record<string, EdgeRuntimeState> {
  const edges: Record<string, EdgeRuntimeState> = {};

  const edge = (
    src: string,
    dst: string,
    label: string,
    throughput: EdgeRuntimeState["throughput"],
    health: EdgeRuntimeState["health"] = "unknown"
  ) => {
    const id = `edge:${src}->${dst}`;
    edges[id] = { throughput, health, label };
  };

  // camera-sim → mediamtx: sum of feed bitrates
  const totalFeedMbps = feedNodeIds
    .map((id) => nodeMap[id]?.feed?.bitrateMbps ?? 0)
    .reduce((a, b) => a + b, 0);

  const feedHealth: EdgeRuntimeState["health"] =
    feedNodeIds.length > 0 && totalFeedMbps > 0
      ? "flowing"
      : feedNodeIds.length > 0
      ? "idle"
      : "unknown";

  edge(
    "camera-sim",
    "mediamtx",
    totalFeedMbps > 0 ? `RTSP ${totalFeedMbps.toFixed(1)} Mbps` : "RTSP",
    totalFeedMbps > 0 ? { value: totalFeedMbps, unit: "Mbps" } : null,
    feedHealth
  );

  // mediamtx → sensor-ms
  edge(
    "mediamtx",
    "sensor-ms",
    totalFeedMbps > 0 ? `RTSP ${totalFeedMbps.toFixed(1)} Mbps` : "RTSP",
    totalFeedMbps > 0 ? { value: totalFeedMbps, unit: "Mbps" } : null,
    feedHealth
  );

  // sensor-ms → streamprocessing-ms (gRPC)
  edge("sensor-ms", "streamprocessing-ms", "gRPC", null, "unknown");

  // sensor-ms → vst-local-cache (write side)
  const cacheFill = nodeMap["vst-local-cache"]?.cache?.fillPct;
  const cacheHealth: EdgeRuntimeState["health"] =
    cacheFill !== null && cacheFill !== undefined
      ? cacheFill > 90
        ? "error"
        : cacheFill > 0
        ? "flowing"
        : "idle"
      : "unknown";
  edge("sensor-ms", "vst-local-cache", "write", null, cacheHealth);

  // vst-local-cache → artesca-s3 (PUT)
  const s3State = nodeMap["artesca-s3"]?.s3;
  const s3PutMbps = s3State?.putRateMBps ?? 0;
  const s3Health: EdgeRuntimeState["health"] =
    s3State != null
      ? s3PutMbps > 0
        ? "flowing"
        : "idle"
      : "unknown";
  edge(
    "vst-local-cache",
    "artesca-s3",
    s3PutMbps > 0 ? `PUT ${s3PutMbps.toFixed(2)} MB/s` : "S3 PUT",
    s3PutMbps > 0 ? { value: s3PutMbps, unit: "MB/s" } : null,
    s3Health
  );

  // sensor-ms → vst-postgres (metadata)
  const pgUp = nodeMap["vst-postgres"]?.db?.up;
  edge(
    "sensor-ms",
    "vst-postgres",
    "metadata",
    null,
    pgUp === true ? "flowing" : pgUp === false ? "error" : "unknown"
  );

  // sensor-ms → vst-redis (vst.event)
  const vstRedisUp = nodeMap["vst-redis"]?.redis?.up;
  edge(
    "sensor-ms",
    "vst-redis",
    "vst.event",
    null,
    vstRedisUp === true ? "flowing" : vstRedisUp === false ? "error" : "unknown"
  );

  // streamprocessing-ms → rtvi-vlm (HTTP)
  edge("streamprocessing-ms", "rtvi-vlm", "HTTP", null, "unknown");

  // rtvi-vlm → nim-cosmos-reason2 (HTTP inference)
  edge("rtvi-vlm", "nim-cosmos-reason2", "HTTP", null, "unknown");

  // nim-cosmos-reason2 → rtvi-vlm (inference response)
  const nimTps = nodeMap["nim-cosmos-reason2"]?.nim?.tokensPerSec;
  edge(
    "nim-cosmos-reason2",
    "rtvi-vlm",
    nimTps != null ? `${nimTps.toFixed(0)} tok/s` : "inference",
    nimTps != null ? { value: nimTps, unit: "tok/s" } : null,
    nimTps != null && nimTps > 0 ? "flowing" : "unknown"
  );

  // rtvi-vlm → kafka (Kafka publish)
  edge("rtvi-vlm", "kafka", "Kafka", null, "unknown");

  // kafka → alert-worker (consume)
  edge("kafka", "alert-worker", "Kafka", null, "unknown");

  // alert-worker → vst-redis (alerts reuses the VST Redis for cooldown state)
  const alertRedisUp = nodeMap["vst-redis"]?.redis?.up;
  edge(
    "alert-worker",
    "vst-redis",
    "Redis",
    null,
    alertRedisUp === true ? "flowing" : alertRedisUp === false ? "error" : "unknown"
  );

  // demo-data-producer → kafka
  edge("demo-data-producer", "kafka", "Kafka", null, "unknown");

  // console → artesca-s3 (clip playback, dormant/dashed)
  edge("console", "artesca-s3", "S3 GET", null, "idle");

  return edges;
}

// ─── Main aggregator ──────────────────────────────────────────────────────────

export async function collectSnapshot(): Promise<PipelineSnapshot> {
  const warnings: string[] = [];
  const nodeMap: Record<string, NodeRuntimeState> = {};

  // Run all data sources in parallel — Promise.allSettled so no single failure blocks
  const [
    podSnapshots,
    gpuEntries,
    s3State,
    cacheState,
    feeds,
    kafkaTopics,
    nimState,
    pgState,
    vstRedisState,
  ] = await Promise.all([
    collectPods(warnings),
    collectGpus(warnings),
    collectS3(warnings),
    collectCache(warnings),
    collectFeeds(warnings),
    collectKafka(warnings),
    collectNim(warnings),
    collectPostgres(warnings),
    // Single Redis — alerts reuses the VST Redis for cooldown state
    // (k8s/alerts/README.md § "Known gaps"), so there is no separate Redis
    // in the alerts namespace to probe.
    collectRedis(CLUSTER.vst.namespace, "app=redis", warnings, "VST"),
  ]);

  // ── Merge pods: worst-health pod wins per node ────────────────────────────

  const podHealthMap = new Map<string, { health: PipelineHealth; state: PodState }>();

  for (const { nodeId, state } of podSnapshots) {
    const h = podPhaseToHealth(state.phase, state.ready);
    const existing = podHealthMap.get(nodeId);
    if (
      !existing ||
      h === "fail" ||
      (h === "warn" && existing.health === "ok") ||
      (h === "ok" && existing.health === "unknown")
    ) {
      podHealthMap.set(nodeId, { health: h, state });
    }
  }

  for (const [nodeId, { health, state }] of podHealthMap) {
    nodeMap[nodeId] = { health, pod: state };
  }

  // ── Merge GPUs ────────────────────────────────────────────────────────────

  for (const { nodeId, gpu } of gpuEntries) {
    if (nodeMap[nodeId]) {
      nodeMap[nodeId].gpu = gpu;
    } else {
      nodeMap[nodeId] = { health: "unknown", gpu };
    }
  }

  // ── S3 node ───────────────────────────────────────────────────────────────

  if (s3State) {
    const s3Health: PipelineHealth =
      s3State.ceilingPct > 95
        ? "fail"
        : s3State.ceilingPct > 80
        ? "warn"
        : "ok";
    nodeMap["artesca-s3"] = { health: s3Health, s3: s3State };
  } else {
    nodeMap["artesca-s3"] = { health: "unknown" };
  }

  // ── Cache node ────────────────────────────────────────────────────────────

  if (cacheState) {
    const cacheHealth: PipelineHealth =
      cacheState.fillPct !== null && cacheState.fillPct > 90
        ? "fail"
        : cacheState.fillPct !== null && cacheState.fillPct > 70
        ? "warn"
        : "ok";
    nodeMap["vst-local-cache"] = { health: cacheHealth, cache: cacheState };
  } else {
    nodeMap["vst-local-cache"] = { health: "unknown" };
  }

  // ── Feed nodes ────────────────────────────────────────────────────────────

  const feedNodeIds: string[] = [];
  for (const { nodeId, state } of feeds) {
    feedNodeIds.push(nodeId);
    const feedHealth: PipelineHealth =
      state.bitrateMbps !== null && state.bitrateMbps > 0 ? "ok" : "warn";
    nodeMap[nodeId] = { health: feedHealth, feed: state };
  }

  // ── Kafka node ────────────────────────────────────────────────────────────

  nodeMap["kafka"] = {
    health: kafkaTopics.length > 0 ? "ok" : "unknown",
    kafka: { topics: kafkaTopics },
  };

  // ── NIM node ──────────────────────────────────────────────────────────────

  if (nimState) {
    const nimHealth: PipelineHealth =
      nimState.warmupPct === 100
        ? "ok"
        : nimState.warmupPct > 0
        ? "warn"
        : "unknown";
    if (nodeMap["nim-cosmos-reason2"]) {
      nodeMap["nim-cosmos-reason2"].nim = nimState;
      if (nodeMap["nim-cosmos-reason2"].health === "unknown") {
        nodeMap["nim-cosmos-reason2"].health = nimHealth;
      }
    } else {
      nodeMap["nim-cosmos-reason2"] = { health: nimHealth, nim: nimState };
    }
  }

  // ── Postgres node ─────────────────────────────────────────────────────────

  if (pgState) {
    nodeMap["vst-postgres"] = {
      health: pgState.up ? "ok" : "fail",
      db: pgState,
    };
  } else {
    nodeMap["vst-postgres"] = { health: "unknown" };
  }

  // ── Redis nodes ───────────────────────────────────────────────────────────

  const vstRedisHealth: PipelineHealth =
    vstRedisState?.up === true
      ? "ok"
      : vstRedisState?.up === false
      ? "fail"
      : "unknown";
  nodeMap["vst-redis"] = {
    health: vstRedisHealth,
    redis: vstRedisState ?? undefined,
  };

  // External nodes have no K8s pod but are part of the topology
  for (const externalId of ["camera-sim", "mediamtx"]) {
    if (!nodeMap[externalId]) {
      nodeMap[externalId] = { health: "unknown" };
    }
  }

  // ── Edges ─────────────────────────────────────────────────────────────────

  const edges = buildEdges(nodeMap, feedNodeIds);

  return {
    takenAt: new Date().toISOString(),
    nodes: nodeMap,
    edges,
    warnings,
  };
}

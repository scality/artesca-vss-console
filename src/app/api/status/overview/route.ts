import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { coreV1, watchedNamespaces } from "@/lib/k8s";
import { getKafka } from "@/lib/kafka";
import { s3Stats } from "@/lib/aws";
import { s3Bucket } from "@/lib/s3";
import { promQuery } from "@/lib/helpers/prometheus";
import { mediamtxListPaths } from "@/lib/helpers/mediamtx";
import type { OverviewSnapshot, GpuState } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const warnings: string[] = [];
  const takenAt = new Date().toISOString();

  // Docker-runtime branch: return an empty-but-valid OverviewSnapshot so
  // the home page renders without warnings instead of bombing with k8s
  // API errors. The docker compose stack is its own world (no kubectl,
  // no Prometheus, no Kafka admin via the k8s service); the operator
  // navigates to /platform-health (deployer) + /incidents (console)
  // instead. Set CONSOLE_RUNTIME=docker on the container env to opt in.
  if (process.env.CONSOLE_RUNTIME === "docker") {
    const snap: OverviewSnapshot = {
      takenAt,
      namespaces: {},
      nim: { ready: false, warmupPct: 0, queueDepth: 0 },
      gpus: [],
      kafka: {},
      s3: { bucket: "", objectCount: 0, bytesTotal: 0, growth24h: 0 },
      cameraSim: { instanceState: "unreachable", pathsReady: 0, pathsTotal: 0 },
    };
    return NextResponse.json(snap);
  }

  // ── Pod counts per namespace ────────────────────────────────────────────────
  const namespaces: OverviewSnapshot["namespaces"] = {};
  const nsListResults = await Promise.allSettled(
    watchedNamespaces().map(async (ns) => {
      const podList = await coreV1().listNamespacedPod({ namespace: ns });
      return { ns, pods: podList.items };
    })
  );

  for (const result of nsListResults) {
    if (result.status === "rejected") {
      warnings.push(`K8s pod list failed: ${String(result.reason)}`);
      continue;
    }
    const { ns, pods } = result.value;
    let total = 0, ready = 0, failed = 0;
    for (const pod of pods) {
      total++;
      const phase = pod.status?.phase;
      if (phase === "Failed" || phase === "Unknown") {
        failed++;
      } else if (
        pod.status?.conditions?.find(
          (c) => c.type === "Ready" && c.status === "True"
        )
      ) {
        ready++;
      }
    }
    namespaces[ns] = { total, ready, failed };
  }

  // ── NIM readiness (rtvi namespace) ─────────────────────────────────────────
  let nim: OverviewSnapshot["nim"] = { ready: false, warmupPct: 0, queueDepth: 0 };
  try {
    const rtviPodList = await coreV1().listNamespacedPod({ namespace: "rtvi" });
    const nimPods = rtviPodList.items.filter((p) =>
      p.metadata?.name?.includes("nim")
    );
    const anyReady = nimPods.some((p) =>
      p.status?.conditions?.find(
        (c) => c.type === "Ready" && c.status === "True"
      )
    );
    nim = { ready: anyReady, warmupPct: anyReady ? 100 : 0, queueDepth: 0 };
  } catch (err) {
    warnings.push(`NIM status failed: ${String(err)}`);
  }

  // ── GPU metrics from Prometheus ─────────────────────────────────────────────
  const gpus: GpuState[] = [];
  const gpuQueries = [
    "DCGM_FI_DEV_GPU_UTIL",
    "DCGM_FI_DEV_FB_USED",
    "DCGM_FI_DEV_FB_TOTAL",
    "DCGM_FI_DEV_GPU_TEMP",
    "DCGM_FI_DEV_POWER_USAGE",
  ] as const;

  const gpuResults = await Promise.all(gpuQueries.map((q) => promQuery(q)));

  // Collect warnings from GPU queries
  for (let i = 0; i < gpuResults.length; i++) {
    if (gpuResults[i].warning) {
      warnings.push(gpuResults[i].warning!);
    }
  }

  const [utilRes, fbUsedRes, fbTotalRes, tempRes, powerRes] = gpuResults;

  // Build GPU index set from all results combined
  const gpuIndexMap = new Map<
    string,
    { index: string; gpu: string; name?: string }
  >();

  for (const r of [utilRes, fbUsedRes, fbTotalRes, tempRes, powerRes]) {
    for (const item of r.results) {
      const gpuIdx = item.metric["gpu"] ?? item.metric["GPU"] ?? "0";
      if (!gpuIndexMap.has(gpuIdx)) {
        gpuIndexMap.set(gpuIdx, { index: gpuIdx, gpu: gpuIdx, name: item.metric["modelName"] });
      }
    }
  }

  for (const [gpuIdx, meta] of gpuIndexMap) {
    const getVal = (res: (typeof gpuResults)[number]) => {
      const found = res.results.find(
        (r) => (r.metric["gpu"] ?? r.metric["GPU"]) === gpuIdx
      );
      return found ? parseFloat(found.value[1]) : 0;
    };

    const fbUsed = getVal(fbUsedRes);
    const fbTotal = getVal(fbTotalRes);

    gpus.push({
      index: parseInt(meta.index, 10),
      name: meta.name ?? `GPU ${gpuIdx}`,
      memoryUsedMiB: fbUsed,
      memoryTotalMiB: fbTotal || 1,
      utilGpu: getVal(utilRes),
      utilMem: fbTotal > 0 ? (fbUsed / fbTotal) * 100 : 0,
      tempC: getVal(tempRes),
      powerW: getVal(powerRes),
      processes: [],
    });
  }

  // ── Kafka consumer lag ──────────────────────────────────────────────────────
  const kafka: OverviewSnapshot["kafka"] = {};
  const topicsEnv = process.env.KAFKA_TOPICS ?? "vision-llm-events,alerts";
  const topics = topicsEnv.split(",").map((t) => t.trim()).filter(Boolean);

  const { instance: kafkaInstance } = getKafka();
  if (kafkaInstance) {
    try {
      const admin = kafkaInstance.admin();
      await admin.connect();
      try {
        const offsetData = await admin.fetchTopicOffsets(topics[0] ?? "vision-llm-events");
        // Simple approach: sum all partition offsets as proxy for lag
        for (const topic of topics) {
          let lag = 0;
          try {
            const offsets = await admin.fetchTopicOffsets(topic);
            lag = offsets.reduce((sum, p) => sum + parseInt(p.high, 10) - parseInt(p.low, 10), 0);
          } catch {
            // ignore per-topic failure
          }
          kafka[topic] = { topic, consumerLagMsgs: lag };
          void offsetData; // silence unused warning
        }
      } finally {
        await admin.disconnect();
      }
    } catch (err) {
      warnings.push(`Kafka admin failed: ${String(err)}`);
      for (const topic of topics) {
        kafka[topic] = { topic, consumerLagMsgs: 0 };
      }
    }
  } else {
    warnings.push("Kafka not configured — KAFKA_BROKERS not set");
    for (const topic of topics) {
      kafka[topic] = { topic, consumerLagMsgs: 0 };
    }
  }

  // ── S3 stats ────────────────────────────────────────────────────────────────
  const bucket = s3Bucket();
  let s3: OverviewSnapshot["s3"] = {
    bucket,
    objectCount: 0,
    bytesTotal: 0,
    growth24h: 0,
  };
  try {
    const stats = await s3Stats(bucket);
    s3 = { ...stats, growth24h: 0 };
  } catch (err) {
    warnings.push(`S3 stats failed: ${String(err)}`);
  }

  // ── Camera-sim state via mediamtx ──────────────────────────────────────────
  let cameraSim: OverviewSnapshot["cameraSim"] = {
    instanceState: "unreachable",
    pathsReady: 0,
    pathsTotal: 0,
  };
  try {
    const { paths, warning } = await mediamtxListPaths();
    if (warning) warnings.push(warning);
    const pathsReady = paths.filter((p) => p.ready).length;
    cameraSim = {
      instanceState: paths.length > 0 || !warning ? "running" : "unreachable",
      pathsReady,
      pathsTotal: paths.length,
    };
  } catch (err) {
    warnings.push(`Camera-sim ping failed: ${String(err)}`);
  }

  const snapshot: OverviewSnapshot = {
    takenAt,
    namespaces,
    nim,
    gpus,
    kafka,
    s3,
    cameraSim,
  };

  return NextResponse.json({ ...snapshot, warnings });
}

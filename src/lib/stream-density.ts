import "server-only";
import { promQuery, deviceValue, gpuIndices } from "@/lib/helpers/prometheus";

/** One physical GPU's live load, named by its DCGM index. */
export interface GpuDensity {
  /** DCGM `gpu` label — the card this row is about. */
  index: number;
  /** DCGM `modelName`, or `GPU <index>` when the exporter omitted it. */
  name: string;
  utilPct: number;
  memUsedMiB: number;
  /** 0 when DCGM exposed neither FB_TOTAL nor FB_USED+FB_FREE for this index —
   *  callers must guard the percentage math rather than divide by it. */
  memTotalMiB: number;
}

export interface StreamDensitySnapshot {
  /** VLM requests/sec across all streams (rate of the VLM latency-histogram count). */
  reqPerSec: number | null;
  /** Fraction 0–1 of VLM requests slower than 1 s. NVIDIA's HPA trigger, which
   *  reads "behind real time" only when a chunk is itself about a second long;
   *  at a 30 s chunk every request is over 1 s while the VLM idles two thirds
   *  of the time. Displayed, not judged. */
  pctOver1s: number | null;
  /** P95 latency as a fraction of the chunk duration — the real-time budget a
   *  chunk's analysis consumes. 0.29 at P95 8.75 s / 30 s chunk. */
  chunkBudgetUsed: number | null;
  /** P95 VLM request latency, ms. */
  latencyP95Ms: number | null;
  /** VLM output throughput, tokens/sec. */
  tokensPerSec: number | null;
  /** Live streams the VLM itself reports (`active_live_streams`), against which
   *  `estimatedActiveStreams` is a model. A gap between the two is the signal
   *  that the VLM is not keeping up with what the cameras produce. */
  activeStreams: number | null;
  /** Every GPU DCGM reports, ascending by index. */
  gpus: GpuDensity[];
  /** The busiest card by utilisation — the headline figure. Null when DCGM
   *  exposed no GPU series at all. */
  gpu: GpuDensity | null;
  /** Chunk window (s) used to translate req/s into an implied stream count. */
  chunkDurationSecs: number;
  /** Implied active streams = round(reqPerSec × chunkDurationSecs). */
  estimatedActiveStreams: number | null;
  verdict: "ok" | "warn" | "saturated" | "unknown";
  warnings: string[];
}

const DEFAULT_CHUNK_S = Number(process.env.VLM_CHUNK_DURATION ?? "30");
// Real time holds while a chunk is analysed well inside its own duration. Past
// 80 % of the budget the next chunk queues behind the last; past 50 % a burst
// (a scene change lengthening reasoning) does the same.
const BUDGET_SATURATED = 0.8;
const BUDGET_WARN = 0.5;

function parseSingle(r: { results: Array<{ value: [number, string] }> }): number | null {
  const raw = r.results[0]?.value?.[1];
  if (raw === undefined) return null;
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : null;
}

export async function collectStreamDensity(
  chunkDurationSecs: number = DEFAULT_CHUNK_S,
): Promise<StreamDensitySnapshot> {
  const warnings: string[] = [];

  // The VLM serves its own metrics on `/v1/metrics`, port 8000 — `/metrics`
  // 404s. The series are `vlm_latency_seconds` and friends, NOT `nim_*`; the
  // scrape that puts them in Prometheus is the rtvi-vlm ServiceMonitor, which
  // only works while it carries `metalk8s.scality.com/monitor: ""`.
  // `vlm_latency_seconds` has an `le="1.0"` bucket, so the fraction over one
  // second comes straight off the histogram.
  const [reqRate, over1s, p95, tokens, streams, gpuUtil, gpuUsed, gpuTotal, gpuFree] =
    await Promise.all([
      promQuery("sum(rate(vlm_latency_seconds_count[5m]))"),
      promQuery(
        '1 - (sum(rate(vlm_latency_seconds_bucket{le="1.0"}[5m])) / sum(rate(vlm_latency_seconds_count[5m])))',
      ),
      promQuery("histogram_quantile(0.95, sum(rate(vlm_latency_seconds_bucket[5m])) by (le))"),
      promQuery("sum(rate(vlm_output_tokens_per_chunk_tokens_sum[5m]))"),
      promQuery("sum(active_live_streams)"),
      promQuery("DCGM_FI_DEV_GPU_UTIL"),
      promQuery("DCGM_FI_DEV_FB_USED"),
      promQuery("DCGM_FI_DEV_FB_TOTAL"),
      // Some DCGM builds emit FB_FREE but not FB_TOTAL — derive the total from
      // used + free in that case, as collectGpuAllocation does.
      promQuery("DCGM_FI_DEV_FB_FREE"),
    ]);

  for (const r of [reqRate, over1s, p95, tokens, streams, gpuUtil, gpuUsed, gpuTotal, gpuFree]) {
    if (r.warning) warnings.push(r.warning);
  }

  const reqPerSec = parseSingle(reqRate);
  const pctOver1s = parseSingle(over1s);
  const p95Secs = parseSingle(p95);
  const tokensPerSec = parseSingle(tokens);
  const activeStreams = parseSingle(streams);

  // Per GPU index, never results[0]. On a two-card node the first sample back
  // is GPU 0, which here is the idle card while the VLM saturates GPU 1.
  const { indices, nameByGpu } = gpuIndices([gpuUtil, gpuUsed, gpuTotal, gpuFree]);
  const gpus: GpuDensity[] = indices.map((idx) => {
    const memUsedMiB = deviceValue(gpuUsed.results, idx);
    const memTotalMiB =
      deviceValue(gpuTotal.results, idx) || memUsedMiB + deviceValue(gpuFree.results, idx) || 0;
    return {
      index: parseInt(idx, 10) || 0,
      name: nameByGpu.get(idx) ?? `GPU ${idx}`,
      utilPct: deviceValue(gpuUtil.results, idx),
      memUsedMiB,
      memTotalMiB,
    };
  });

  // The headline is the busiest card: it is the one that runs out first, and
  // it is what "is there headroom" means on a node where the workloads are not
  // evenly placed. Ties break on the lower index so the value is stable.
  const gpu =
    gpus.reduce<GpuDensity | null>(
      (best, g) => (best === null || g.utilPct > best.utilPct ? g : best),
      null,
    ) ?? null;

  const estimatedActiveStreams =
    reqPerSec !== null ? Math.round(reqPerSec * chunkDurationSecs) : null;

  const chunkBudgetUsed =
    p95Secs !== null && chunkDurationSecs > 0 ? p95Secs / chunkDurationSecs : null;
  // Streams the VLM holds but is not producing one request per chunk for: the
  // direct sign that chunks are being dropped or queued.
  const shortfall =
    activeStreams !== null && estimatedActiveStreams !== null
      ? activeStreams - estimatedActiveStreams
      : null;

  let verdict: StreamDensitySnapshot["verdict"] = "unknown";
  if (chunkBudgetUsed !== null) {
    if (chunkBudgetUsed >= BUDGET_SATURATED || (shortfall !== null && shortfall >= 2)) verdict = "saturated";
    else if (chunkBudgetUsed >= BUDGET_WARN || shortfall === 1) verdict = "warn";
    else verdict = "ok";
  }

  return {
    reqPerSec,
    pctOver1s,
    chunkBudgetUsed,
    latencyP95Ms: p95Secs !== null ? p95Secs * 1000 : null,
    tokensPerSec,
    activeStreams,
    gpus,
    gpu,
    chunkDurationSecs,
    estimatedActiveStreams,
    verdict,
    warnings,
  };
}

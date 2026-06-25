import "server-only";
import { promQuery } from "@/lib/helpers/prometheus";

export interface StreamDensitySnapshot {
  /** VLM requests/sec across all streams (rate of the NIM latency-histogram count). */
  reqPerSec: number | null;
  /** Fraction 0–1 of VLM requests slower than 1s — NVIDIA's scale signal. */
  pctOver1s: number | null;
  /** P95 VLM request latency, ms. */
  latencyP95Ms: number | null;
  /** VLM output throughput, tokens/sec. */
  tokensPerSec: number | null;
  /** First GPU: utilisation % and VRAM used/total MiB. */
  gpu: { utilPct: number; memUsedMiB: number; memTotalMiB: number } | null;
  /** Chunk window (s) used to translate req/s into an implied stream count. */
  chunkDurationSecs: number;
  /** Implied active streams = round(reqPerSec × chunkDurationSecs). */
  estimatedActiveStreams: number | null;
  verdict: "ok" | "warn" | "saturated" | "unknown";
  warnings: string[];
}

const DEFAULT_CHUNK_S = Number(process.env.VLM_CHUNK_DURATION ?? "30");
const SATURATION_THRESHOLD = 0.4; // NVIDIA HPA trigger: scale at >= 40% over 1s

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

  const [reqRate, over1s, p95, tokens, gpuUtil, gpuUsed, gpuTotal] = await Promise.all([
    promQuery("sum(rate(nim_request_latency_seconds_count[1m]))"),
    promQuery(
      '1 - (sum(rate(nim_request_latency_seconds_bucket{le="1.0"}[5m])) / sum(rate(nim_request_latency_seconds_count[5m])))',
    ),
    promQuery('histogram_quantile(0.95, sum(rate(nim_request_latency_seconds_bucket[5m])) by (le))'),
    promQuery("nim_tokens_per_second"),
    promQuery("DCGM_FI_DEV_GPU_UTIL"),
    promQuery("DCGM_FI_DEV_FB_USED"),
    promQuery("DCGM_FI_DEV_FB_TOTAL"),
  ]);

  for (const r of [reqRate, over1s, p95, tokens, gpuUtil, gpuUsed, gpuTotal]) {
    if (r.warning) warnings.push(r.warning);
  }

  const reqPerSec = parseSingle(reqRate);
  const pctOver1s = parseSingle(over1s);
  const p95Secs = parseSingle(p95);
  const tokensPerSec = parseSingle(tokens);
  const utilPct = parseSingle(gpuUtil);
  const memUsedMiB = parseSingle(gpuUsed);
  const memTotalMiB = parseSingle(gpuTotal);

  const gpu =
    utilPct !== null && memUsedMiB !== null && memTotalMiB !== null
      ? { utilPct, memUsedMiB, memTotalMiB }
      : null;

  const estimatedActiveStreams =
    reqPerSec !== null ? Math.round(reqPerSec * chunkDurationSecs) : null;

  let verdict: StreamDensitySnapshot["verdict"] = "unknown";
  if (pctOver1s !== null) {
    if (pctOver1s >= SATURATION_THRESHOLD) verdict = "saturated";
    else if (pctOver1s >= SATURATION_THRESHOLD / 2) verdict = "warn";
    else verdict = "ok";
  }

  return {
    reqPerSec,
    pctOver1s,
    latencyP95Ms: p95Secs !== null ? p95Secs * 1000 : null,
    tokensPerSec,
    gpu,
    chunkDurationSecs,
    estimatedActiveStreams,
    verdict,
    warnings,
  };
}

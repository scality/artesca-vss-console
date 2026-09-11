import "server-only";
import { CLUSTER } from "../cluster-refs";
import { createLogger } from "@/lib/logger";

const log = createLogger("prometheus");

// ARTESCA's kube-prometheus-stack Prometheus.  Service "prometheus-operated"
// in namespace "artesca-monitoring" (confirmed on live cluster 2026-04-22).
// Override via PROMETHEUS_URL env var if the service name or namespace differs.
const PROMETHEUS_URL = CLUSTER.prometheus.url;

export interface PromResult {
  metric: Record<string, string>;
  value: [number, string]; // [timestamp, value]
}

export interface PromQueryResponse {
  status: "success" | "error";
  data: {
    resultType: "vector" | "matrix" | "scalar" | "string";
    result: PromResult[];
  };
  error?: string;
}

/**
 * Run an instant PromQL query against the in-cluster Prometheus.
 * Returns an empty result set (not a throw) if Prometheus is unreachable.
 */
export async function promQuery(
  q: string
): Promise<{ results: PromResult[]; warning?: string }> {
  const url = `${PROMETHEUS_URL}/api/v1/query?query=${encodeURIComponent(q)}`;

  try {
    const resp = await fetch(url, {
      next: { revalidate: 0 },
      signal: AbortSignal.timeout(5_000),
    });

    if (!resp.ok) {
      log.warn(`HTTP ${resp.status} for query`, { query: q });
      return { results: [], warning: `Prometheus returned HTTP ${resp.status}` };
    }

    const json = (await resp.json()) as PromQueryResponse;

    if (json.status !== "success") {
      return {
        results: [],
        warning: `Prometheus error: ${json.error ?? "unknown"}`,
      };
    }

    return { results: json.data.result };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn("unreachable", { err });
    return { results: [], warning: `Prometheus unreachable: ${msg}` };
  }
}

/** DCGM's GPU index for a series. The exporter emits `gpu`; some builds emit
 *  `GPU`. Defaults to "0" so a single-card exporter with neither still keys. */
export function gpuIndexOf(metric: Record<string, string>): string {
  return metric["gpu"] ?? metric["GPU"] ?? "0";
}

/** Device-level value for one GPU index. Util, temp, power and the framebuffer
 *  totals are per-device, so the right sample is the one whose `gpu` label
 *  matches — NOT `results[0]`, which on a multi-card node is whichever index
 *  the exporter happened to list first (GPU 0 here, the idle card). Returns 0
 *  when no series carries that index. */
export function deviceValue(results: PromResult[], gpuIdx: string): number {
  const found = results.find((r) => gpuIndexOf(r.metric) === gpuIdx);
  return found ? parseFloat(found.value[1]) || 0 : 0;
}

/** Every GPU index any of these result sets mentions, plus each index's
 *  `modelName` where DCGM supplied one. */
export function gpuIndices(
  resultSets: Array<{ results: PromResult[] }>,
): { indices: string[]; nameByGpu: Map<string, string> } {
  const seen = new Set<string>();
  const nameByGpu = new Map<string, string>();
  for (const r of resultSets) {
    for (const item of r.results) {
      const g = gpuIndexOf(item.metric);
      seen.add(g);
      if (item.metric["modelName"] && !nameByGpu.has(g)) {
        nameByGpu.set(g, item.metric["modelName"]);
      }
    }
  }
  const indices = [...seen].sort((a, b) => (parseInt(a, 10) || 0) - (parseInt(b, 10) || 0));
  return { indices, nameByGpu };
}

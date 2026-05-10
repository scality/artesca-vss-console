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

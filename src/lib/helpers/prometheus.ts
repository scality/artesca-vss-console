import "server-only";
import { CLUSTER } from "../cluster-refs";

// ARTESCA's kube-prometheus-stack Prometheus.  The exact Service name is not
// in this repo's k8s/ manifests (ARTESCA installs it).  The default follows
// the kube-prometheus-stack convention.  Override via PROMETHEUS_URL if
// ARTESCA uses a different name or namespace.  Flag: ASSUMED — confirm at deploy.
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
      console.warn(`[prometheus] HTTP ${resp.status} for query: ${q}`);
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
    console.warn(`[prometheus] unreachable: ${msg}`);
    return { results: [], warning: `Prometheus unreachable: ${msg}` };
  }
}

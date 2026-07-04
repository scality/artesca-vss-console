import "server-only";

import { CLUSTER } from "@/lib/cluster-refs";

/**
 * agent-health.ts — live reachability probe for vss-agent, backing the
 * /capabilities page's status chip.
 *
 * Split from agent-capabilities.ts (pure static data, no I/O) to match the
 * codebase's existing separation between catalog/schema modules and
 * collector modules that perform network calls (cf. overview-collector.ts,
 * lib/diagnostics/connectivity.ts, gpu-allocation.ts).
 */

const AGENT_HEALTH_TIMEOUT_MS = 4_000;

export interface AgentReachability {
  reachable: boolean;
  warnings: string[];
}

/**
 * Probes vss-agent's /health endpoint. Never throws — a failed probe
 * degrades to { reachable: false, warnings: [...] } so a broken backend
 * doesn't take down the Capabilities page (same "always resolve" contract
 * as collectOverviewSnapshot / collectConnectivity).
 */
export async function collectAgentReachability(): Promise<AgentReachability> {
  const url = `${CLUSTER.agent.url}/health`;
  try {
    const resp = await fetch(url, {
      cache: "no-store",
      signal: AbortSignal.timeout(AGENT_HEALTH_TIMEOUT_MS),
    });
    if (!resp.ok) {
      return {
        reachable: false,
        warnings: [`vss-agent /health returned HTTP ${resp.status}`],
      };
    }
    return { reachable: true, warnings: [] };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { reachable: false, warnings: [`vss-agent unreachable: ${msg}`] };
  }
}

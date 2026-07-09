import "server-only";

/**
 * hero-collector.ts — the kiosk "story hero" extras.
 *
 * The overview snapshot already carries cameras / GPU / storage / NIM. The
 * kiosk hero additionally leads with the product's headline signal — how many
 * incidents the video AI has detected — and a peek at the newest ones. Those
 * live behind two backends the overview collector doesn't touch:
 *
 *   - the caption archive `/stats` (Qdrant scroll) → all-time + last-24h totals
 *   - the realtime alert-bridge backlog → the newest few incidents to show
 *
 * Always fail-soft: a down backend contributes null/[] + a warning rather than
 * throwing, so the hero degrades to whatever is reachable.
 */
import { CLUSTER } from "@/lib/cluster-refs";
import { fromAlertBridge } from "@/lib/helpers/incident-wire";
import { IncidentSchema } from "@/lib/schemas";
import type { Incident } from "@/lib/types";

export interface HeroExtras {
  /** All-time incidents in the caption archive (Qdrant /stats total). null = unavailable. */
  archiveTotal: number | null;
  /** Incidents detected in the last 24h (/stats?since_hours=24 total). null = unavailable. */
  last24h: number | null;
  /** Newest incidents for the peek list (alert-bridge realtime backlog, newest first). */
  recent: Incident[];
  warnings: string[];
}

async function fetchStatsTotal(sinceHours?: number): Promise<number | null> {
  const qs = sinceHours ? `?since_hours=${sinceHours}` : "";
  try {
    const resp = await fetch(`${CLUSTER.search.url}/stats${qs}`, {
      signal: AbortSignal.timeout(8_000),
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as { total?: unknown };
    return typeof data?.total === "number" ? data.total : null;
  } catch {
    return null;
  }
}

async function fetchRecentIncidents(
  limit: number,
): Promise<{ incidents: Incident[]; warning?: string }> {
  try {
    const resp = await fetch(
      `${CLUSTER.alertBridge.url}/api/v1/realtime/incidents?limit=${encodeURIComponent(String(limit))}`,
      { signal: AbortSignal.timeout(5_000), next: { revalidate: 0 } },
    );
    if (!resp.ok) {
      return { incidents: [], warning: `alert-bridge HTTP ${resp.status}` };
    }
    const data = await resp.json();
    const list: unknown[] = Array.isArray(data)
      ? data
      : Array.isArray(data?.incidents)
        ? (data.incidents as unknown[])
        : [];
    const incidents: Incident[] = [];
    for (const raw of list) {
      const parsed = IncidentSchema.safeParse(fromAlertBridge(raw));
      // fromAlertBridge always sets `raw`; the schema types it optional.
      if (parsed.success) incidents.push(parsed.data as Incident);
    }
    return { incidents };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { incidents: [], warning: `alert-bridge unreachable: ${msg}` };
  }
}

/** Always-resolves collector for the kiosk hero extras. */
export async function collectHeroExtras(): Promise<HeroExtras> {
  const warnings: string[] = [];
  const [archiveTotal, last24h, recentResult] = await Promise.all([
    fetchStatsTotal(),
    fetchStatsTotal(24),
    fetchRecentIncidents(6),
  ]);
  if (recentResult.warning) warnings.push(recentResult.warning);
  if (archiveTotal === null) warnings.push("incident archive stats unavailable");
  return { archiveTotal, last24h, recent: recentResult.incidents, warnings };
}

import "server-only";

/**
 * artesca-capacity.ts — the one storage number that predicts an outage.
 *
 * Every other fill figure in this console is S3 logical object bytes over an
 * operator-typed capacity. That pair read "60.1% used" on pyramid-showroom while
 * ARTESCA was write-protected at 95.01% and had been refusing every VST upload
 * with 503 for weeks. Logical bytes exclude erasure-coding overhead, noncurrent
 * versions and incomplete multipart uploads, so they undercount physical fill by
 * a wide and unpredictable margin.
 *
 * This reads hyperdrive's own gauges from hdproxyd instead.
 *
 * Two semantics that are easy to get wrong, both from ARTESCA's docs:
 *
 *  - Cluster fill is the LEAST occupied storage group, each group measured by
 *    its most occupied node. When that crosses the critical limit there is no
 *    group left to place a write in, and hdproxyd answers 507.
 *  - `writeProtectionEnabled` means the guard is ARMED, not that writes are
 *    blocked. ARTESCA 4.3 auto-enables it at install, so a healthy cluster sits
 *    at 1 and serves writes normally. Refusal requires armed AND fill >= critical.
 *    Rendering "write protection enabled" as an alarm on its own is wrong and
 *    would fire on every healthy 4.3 cluster.
 */
import { CLUSTER } from "@/lib/cluster-refs";

export interface ArtescaCapacity {
  /** Least-occupied storage group fill, the figure the guard compares. */
  fillPercent: number;
  /** Guard armed. NOT the same as "writes are blocked" — see above. */
  writeProtectionArmed: boolean;
  /** Fill at or above which writes are refused (typically 95). */
  criticalPercent: number;
  /** Fill at which the early warning is raised (typically 80). */
  earlyPercent: number;
  /** True only when the guard is armed AND fill has reached the critical limit. */
  writesRefused: boolean;
  /** Above the early-warning line but not yet refusing. */
  warning: boolean;
  checkedAt: string;
}

/** Parse a Prometheus text-exposition gauge, ignoring labels. */
export function parseGauge(body: string, name: string): number | undefined {
  for (const line of body.split("\n")) {
    if (line.startsWith("#")) continue;
    if (!line.startsWith(name)) continue;
    const rest = line.slice(name.length);
    // Either "name value" or 'name{labels} value'.
    if (rest.length && rest[0] !== " " && rest[0] !== "{") continue;
    const value = Number(rest.slice(rest.lastIndexOf(" ") + 1).trim());
    if (Number.isFinite(value)) return value;
  }
  return undefined;
}

/**
 * Read hyperdrive capacity. Returns null when hdproxyd cannot be reached, which
 * must render as "unknown" and never as healthy — an unreachable guard is
 * exactly the state in which a cluster silently fills.
 */
export async function readArtescaCapacity(): Promise<ArtescaCapacity | null> {
  const url = `${CLUSTER.artesca.hdProxyUrl}/metrics`;
  let body: string;
  try {
    const resp = await fetch(url, {
      signal: AbortSignal.timeout(8_000),
      cache: "no-store",
    });
    if (!resp.ok) return null;
    body = await resp.text();
  } catch {
    return null;
  }

  const fillPercent = parseGauge(
    body,
    "hdcontroller_most_available_storage_group_fill_percent",
  );
  if (fillPercent === undefined) return null;

  const armedRaw = parseGauge(body, "hdcontroller_write_protection_enabled");
  // Thresholds are published by the controller; fall back to ARTESCA's documented
  // defaults rather than inventing a limit that would misclassify the cluster.
  const criticalPercent =
    parseGauge(body, 'hdcontroller_storage_limit_percent{level="critical"}') ?? 95;
  const earlyPercent =
    parseGauge(body, 'hdcontroller_storage_limit_percent{level="early"}') ?? 80;

  const writeProtectionArmed = armedRaw === 1;

  return {
    fillPercent,
    writeProtectionArmed,
    criticalPercent,
    earlyPercent,
    writesRefused: writeProtectionArmed && fillPercent >= criticalPercent,
    warning: fillPercent >= earlyPercent && fillPercent < criticalPercent,
    checkedAt: new Date().toISOString(),
  };
}

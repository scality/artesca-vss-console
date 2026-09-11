import "server-only";

/**
 * storage-substrate.ts — the "ARTESCA is the AI's on-prem memory" collector.
 *
 * Aggregates per-bucket object counts + bytes + 24h-written + the latest objects
 * landing, across the three VSS buckets (recordings / incident clips / agent
 * corpus). Backs the /storage page (live) via /api/storage/substrate.
 *
 * Listing the recordings bucket (tens of thousands of objects) is a multi-call
 * pass, so stats are cached per-bucket with a short TTL — rapid polls stay cheap
 * while the numbers still visibly grow between refreshes.
 *
 * Always fail-soft: a broken/absent bucket contributes zeros + a warning rather
 * than throwing, so the page degrades gracefully.
 */
import { CLUSTER } from "@/lib/cluster-refs";
import {
  s3SubstrateStats,
  s3IncompleteMultipartUploads,
  type S3RecentObject,
  type S3MultipartUploadsStats,
} from "@/lib/aws";
import {
  GetBucketLifecycleConfigurationCommand,
  GetObjectLockConfigurationCommand,
} from "@aws-sdk/client-s3";
import { makeS3Client } from "@/lib/s3";
import { readArtescaCapacity, type ArtescaCapacity } from "@/lib/helpers/artesca-capacity";
import { readArtescaReclamation, type ArtescaReclamation } from "@/lib/helpers/artesca-reclamation";
import {
  s3BucketForRecordings,
  s3BucketForAlertClips,
  s3Endpoint,
  s3Region,
} from "@/lib/s3";

// Stale-while-revalidate cache. Listing the recordings bucket is ~65 sequential
// S3 round-trips (64k+ objects), so a blocking cache stalls first paint and one
// poll every TTL. Instead: serve whatever is cached INSTANTLY and refresh in the
// background; only a genuine cold start waits (briefly, bounded) for first data.
type BucketStats = Awaited<ReturnType<typeof s3SubstrateStats>>;
const FRESH_MS = 15_000; // younger than this → serve as-is; older → serve + background-refresh
const COLD_START_WAIT_MS = 2_500; // cold cache: wait at most this long for first data
const FAILED_BACKOFF_MS = 60_000; // an unlistable bucket is retried at most this often
const cache = new Map<string, { ts: number; stats: BucketStats }>();
const inflight = new Map<string, Promise<void>>();
const failed = new Map<string, number>(); // bucket → ts of last scan failure

/** Fire-and-forget full scan; dedups concurrent refreshes per bucket. */
function refreshBucket(bucket: string): Promise<void> {
  const existing = inflight.get(bucket);
  if (existing) return existing;
  const p = (async () => {
    try {
      const stats = await s3SubstrateStats(bucket, 8);
      cache.set(bucket, { ts: Date.now(), stats });
      failed.delete(bucket);
    } catch {
      // Not provisioned / no access — record the failure so we back off instead of
      // rescanning (and reporting "refreshing") on every poll.
      failed.set(bucket, Date.now());
    } finally {
      inflight.delete(bucket);
    }
  })();
  inflight.set(bucket, p);
  return p;
}

/** Non-blocking read: cached value (possibly stale) + whether a refresh is due/running. */
function statsSWR(bucket: string): { stats: BucketStats | null; refreshing: boolean } {
  const c = cache.get(bucket);
  if (c) {
    if (Date.now() - c.ts >= FRESH_MS) {
      void refreshBucket(bucket);
      return { stats: c.stats, refreshing: true };
    }
    return { stats: c.stats, refreshing: false };
  }
  // No cached value. If the bucket recently failed to list, treat it as
  // (known) unavailable — not "still loading" — so it doesn't pin the page to
  // fast-polling. Retry only after the backoff window.
  const f = failed.get(bucket);
  if (f && Date.now() - f < FAILED_BACKOFF_MS) {
    return { stats: null, refreshing: false };
  }
  void refreshBucket(bucket);
  return { stats: null, refreshing: true };
}

/**
 * Non-blocking bucket stats for callers outside the /storage page — the overview
 * collector, which renders the kiosk display and must never block on a bucket
 * walk. Returns whatever is cached (possibly stale, possibly null on a cold
 * cache) and kicks a background refresh when one is due.
 *
 * Sharing this module's cache is the point: the recordings bucket is scanned
 * once and both surfaces read the same result, instead of each paying its own
 * ~197 sequential round-trips.
 */
export function bucketStatsCached(bucket: string): {
  stats: BucketStats | null;
  refreshing: boolean;
} {
  return statsSWR(bucket);
}

/**
 * Bucket retention, read from the bucket itself rather than assumed.
 *
 * This is on the page because an absent lifecycle rule is otherwise invisible
 * until the cluster stops accepting writes. On pyramid-showroom the recordings
 * bucket reached 394,815 objects and 6.99 TiB carrying no rule at all, ARTESCA
 * crossed hyperdrive's 95% write-protection guard, and every VST upload began
 * failing 503 with nothing naming the cause.
 *
 * `expiresDays: null` with `configured: false` means NOTHING is ever reclaimed
 * from this bucket — render it as a warning, not as "unlimited retention".
 *
 * `abortIncompleteMultipartDays` is the companion rule that reclaims stale
 * multipart uploads rather than completed objects — on 2026-09-10 the
 * recordings bucket on pyramid-showroom carried 5,664 incomplete multipart
 * uploads with no rule to clear them, aborted by hand. `null` means no such
 * rule is enabled, and — like `expiresDays: null` — must render as a warning,
 * never as "nothing to worry about".
 */
export interface BucketRetention {
  configured: boolean;
  expiresDays: number | null;
  objectLock: boolean;
  abortIncompleteMultipartDays: number | null;
}

// Retention changes on operator action, not on traffic, so it is cached far
// longer than the object stats and refreshed lazily.
const RETENTION_TTL_MS = 300_000;
const retentionCache = new Map<string, { ts: number; value: BucketRetention }>();

export async function readRetention(bucket: string): Promise<BucketRetention> {
  const hit = retentionCache.get(bucket);
  if (hit && Date.now() - hit.ts < RETENTION_TTL_MS) return hit.value;

  const s3 = makeS3Client();
  let expiresDays: number | null = null;
  let configured = false;
  let abortIncompleteMultipartDays: number | null = null;
  try {
    const lc = await s3.send(new GetBucketLifecycleConfigurationCommand({ Bucket: bucket }));
    const days = (lc.Rules ?? [])
      .filter((r) => r.Status === "Enabled" && r.Expiration?.Days != null)
      .map((r) => r.Expiration!.Days as number);
    if (days.length > 0) {
      // Shortest enabled expiry is the one that actually governs a given object.
      expiresDays = Math.min(...days);
      configured = true;
    }
    const abortDays = (lc.Rules ?? [])
      .filter((r) => r.Status === "Enabled" && r.AbortIncompleteMultipartUpload?.DaysAfterInitiation != null)
      .map((r) => r.AbortIncompleteMultipartUpload!.DaysAfterInitiation as number);
    if (abortDays.length > 0) {
      // Same shortest-wins reasoning as expiry: the rule that fires first is
      // the one that actually governs a given stale upload.
      abortIncompleteMultipartDays = Math.min(...abortDays);
    }
  } catch {
    // NoSuchLifecycleConfiguration and access errors alike mean "we cannot show
    // a rule". Both must read as not-configured rather than as unlimited.
  }

  let objectLock = false;
  try {
    const ol = await s3.send(new GetObjectLockConfigurationCommand({ Bucket: bucket }));
    objectLock = ol.ObjectLockConfiguration?.ObjectLockEnabled === "Enabled";
  } catch {
    /* no object lock on this bucket */
  }

  const value: BucketRetention = { configured, expiresDays, objectLock, abortIncompleteMultipartDays };
  retentionCache.set(bucket, { ts: Date.now(), value });
  return value;
}

// Multipart-upload counts change on operator/client behavior, not on the object
// churn the bucket-stats cache tracks, and a full ListMultipartUploads walk
// costs the same order of round-trips as the object listing it does not
// substitute for — so it gets its own cache, on the same cadence as retention.
const MULTIPART_TTL_MS = 300_000;
const multipartCache = new Map<string, { ts: number; value: S3MultipartUploadsStats }>();

/**
 * Incomplete multipart uploads on a bucket, for regression detection against
 * the 2026-09-10 pyramid-showroom incident (5,664 stale uploads, aborted by
 * hand). Fail-soft: a listing error yields `null`, which the caller must treat
 * as "unknown", never as zero.
 */
export async function readMultipartUploads(bucket: string): Promise<S3MultipartUploadsStats | null> {
  const hit = multipartCache.get(bucket);
  if (hit && Date.now() - hit.ts < MULTIPART_TTL_MS) return hit.value;

  try {
    const value = await s3IncompleteMultipartUploads(bucket);
    multipartCache.set(bucket, { ts: Date.now(), value });
    return value;
  } catch {
    return null;
  }
}

export interface BucketSubstrate {
  key: string;
  label: string;
  bucket: string;
  objectCount: number;
  bytesTotal: number;
  bytesLast24h: number;
  truncated?: boolean;
  /** false when the bucket couldn't be listed (not provisioned / no access) — hidden in the UI. */
  available: boolean;
  /** Lifecycle expiry + Object Lock, read from the bucket. */
  retention?: BucketRetention;
  /** Incomplete multipart uploads, read from the bucket. Absent when the listing failed. */
  multipartUploads?: S3MultipartUploadsStats;
}

export interface RecentObject extends S3RecentObject {
  bucket: string;
  bucketLabel: string;
}

export interface StorageSubstrate {
  /**
   * ARTESCA's own capacity, from hyperdrive. null = hdproxyd unreachable,
   * which renders as unknown and never as healthy. Distinct from the bucket
   * byte totals below, which are S3 logical bytes and undercount physical fill.
   */
  artesca?: ArtescaCapacity | null;
  /** Whether deletes are returning space; null when Prometheus is unreachable. */
  reclamation?: ArtescaReclamation | null;
  configured: boolean;
  endpoint: string;
  region: string;
  capacityBytes: number;
  buckets: BucketSubstrate[];
  recent: RecentObject[];
  totals: { objectCount: number; bytesTotal: number; bytesLast24h: number };
  warnings: string[];
  /** true while a background bucket scan is in flight (numbers may still be filling in). */
  refreshing: boolean;
  ts: string;
}

export async function collectStorageSubstrate(): Promise<StorageSubstrate> {
  const endpoint = s3Endpoint() ?? "";
  const region = s3Region();
  const capacityBytes = CLUSTER.s3.capacityBytes;
  const configured = Boolean(
    endpoint && (process.env.OBJECTSTORE_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID),
  );

  const evidenceBucket = process.env.OBJECTSTORE_EVIDENCE_BUCKET ?? "nvidia-vss-evidence";
  const defs = [
    { key: "recordings", label: "Recordings", bucket: s3BucketForRecordings() },
    { key: "evidence", label: "Immutable evidence", bucket: evidenceBucket },
    { key: "alertClips", label: "Incident clips", bucket: s3BucketForAlertClips() },
    { key: "agentCorpus", label: "Agent corpus", bucket: CLUSTER.s3.buckets.agentCorpus },
  ];
  const warnings: string[] = [];

  if (!configured) {
    return {
      configured: false,
      endpoint,
      region,
      capacityBytes,
      buckets: defs.map((d) => ({ ...d, objectCount: 0, bytesTotal: 0, bytesLast24h: 0, available: false })),
      recent: [],
      totals: { objectCount: 0, bytesTotal: 0, bytesLast24h: 0 },
      warnings: ["S3 not configured (set OBJECTSTORE_ENDPOINT + OBJECTSTORE_ACCESS_KEY_ID)"],
      refreshing: false,
      ts: new Date().toISOString(),
    };
  }

  // Cold start (nothing cached yet): give the just-kicked background scans a brief,
  // bounded window to land so the first paint can show real numbers when the buckets
  // are small/fast — but never block on the big recordings scan.
  if (defs.every((d) => !cache.has(d.bucket))) {
    defs.forEach((d) => void refreshBucket(d.bucket));
    await Promise.race([
      Promise.allSettled(defs.map((d) => inflight.get(d.bucket) ?? Promise.resolve())),
      new Promise((r) => setTimeout(r, COLD_START_WAIT_MS)),
    ]);
  }

  // Non-blocking reads: cached-or-null + a background refresh when stale.
  const results = defs.map((d) => {
    const { stats, refreshing } = statsSWR(d.bucket);
    return { d, s: stats, refreshing };
  });
  const refreshing = results.some((r) => r.refreshing);

  // Retention is a cheap, long-cached pair of HEAD-ish calls per bucket, so it
  // is resolved for every bucket even when the object scan is still warming.
  const retentions = new Map<string, BucketRetention>();
  await Promise.all(
    defs.map(async (d) => {
      try {
        retentions.set(d.bucket, await readRetention(d.bucket));
      } catch {
        /* fail-soft: the card just omits retention */
      }
    }),
  );

  // Incomplete multipart uploads, same cadence and same fail-soft treatment as
  // retention — see readMultipartUploads for why this is a regression check,
  // not routine housekeeping.
  const multipartUploads = new Map<string, S3MultipartUploadsStats>();
  await Promise.all(
    defs.map(async (d) => {
      const stats = await readMultipartUploads(d.bucket);
      if (stats) multipartUploads.set(d.bucket, stats);
    }),
  );

  // An unretained recordings bucket is the one storage condition that takes the
  // whole stack down on a timer, so it is surfaced as a warning and not left for
  // the operator to notice on a card.
  // ARTESCA cluster fill — the figure that actually predicts a write refusal.
  let artesca: ArtescaCapacity | null = null;
  try {
    artesca = await readArtescaCapacity();
  } catch {
    /* fail-soft: renders as unknown */
  }
  // Whether deletes are returning space — the question cluster fill alone
  // cannot answer while a relocation pass is pending.
  let reclamation: ArtescaReclamation | null = null;
  try {
    reclamation = await readArtescaReclamation();
  } catch {
    /* fail-soft: renders as unknown */
  }
  if (reclamation?.verdict.state === "stuck") {
    warnings.push(`ARTESCA reclamation looks stuck: ${reclamation.verdict.reason}.`);
  }
  if (artesca?.writesRefused) {
    warnings.push(
      `ARTESCA is refusing writes: cluster fill ${artesca.fillPercent.toFixed(2)}% has reached the ${artesca.criticalPercent}% guard. Free space or expand capacity — deletes take effect only after a relocation pass.`,
    );
  } else if (artesca?.warning) {
    warnings.push(
      `ARTESCA cluster fill is ${artesca.fillPercent.toFixed(2)}%, above the ${artesca.earlyPercent}% early-warning line and heading for the ${artesca.criticalPercent}% write guard.`,
    );
  }

  const recDef = defs.find((d) => d.key === "recordings");
  const recRet = recDef ? retentions.get(recDef.bucket) : undefined;
  if (recRet && !recRet.configured) {
    warnings.push(
      `${recDef!.bucket}: no lifecycle expiry — recordings are never reclaimed and will fill ARTESCA until writes are refused`,
    );
  }
  if (recRet && recRet.abortIncompleteMultipartDays === null) {
    warnings.push(
      `${recDef!.bucket}: no AbortIncompleteMultipartUpload lifecycle rule — stale multipart uploads accumulate silently and are never reclaimed`,
    );
  }

  const buckets: BucketSubstrate[] = results
    .map(({ d, s }) => ({
      key: d.key,
      label: d.label,
      bucket: d.bucket,
      retention: retentions.get(d.bucket),
      multipartUploads: multipartUploads.get(d.bucket),
      objectCount: s?.objectCount ?? 0,
      bytesTotal: s?.bytesTotal ?? 0,
      bytesLast24h: s?.bytesLast24h ?? 0,
      available: s !== null,
      ...(s?.truncated ? { truncated: true } : {}),
    }))
    // Lead with the buckets that actually hold data; empty ones sink to the end.
    .sort((a, b) => b.bytesTotal - a.bytesTotal || b.objectCount - a.objectCount);

  const recent: RecentObject[] = results
    .flatMap(({ d, s }) =>
      (s?.recent ?? []).map((r) => ({ ...r, bucket: d.bucket, bucketLabel: d.label })),
    )
    .filter((r) => r.lastModified)
    .sort((a, b) => b.lastModified.localeCompare(a.lastModified))
    .slice(0, 12);

  const totals = buckets.reduce(
    (acc, b) => ({
      objectCount: acc.objectCount + b.objectCount,
      bytesTotal: acc.bytesTotal + b.bytesTotal,
      bytesLast24h: acc.bytesLast24h + b.bytesLast24h,
    }),
    { objectCount: 0, bytesTotal: 0, bytesLast24h: 0 },
  );

  return { artesca, reclamation, configured: true, endpoint, region, capacityBytes, buckets, recent, totals, warnings, refreshing, ts: new Date().toISOString() };
}

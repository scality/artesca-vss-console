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
import { s3SubstrateStats, type S3RecentObject } from "@/lib/aws";
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
}

export interface RecentObject extends S3RecentObject {
  bucket: string;
  bucketLabel: string;
}

export interface StorageSubstrate {
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

  const buckets: BucketSubstrate[] = results
    .map(({ d, s }) => ({
      key: d.key,
      label: d.label,
      bucket: d.bucket,
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

  return { configured: true, endpoint, region, capacityBytes, buckets, recent, totals, warnings, refreshing, ts: new Date().toISOString() };
}

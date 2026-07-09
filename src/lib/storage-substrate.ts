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
  describeS3Error,
} from "@/lib/s3";

const CACHE_TTL_MS = 30_000;
const cache = new Map<string, { ts: number; stats: Awaited<ReturnType<typeof s3SubstrateStats>> }>();

async function cachedStats(bucket: string) {
  const c = cache.get(bucket);
  if (c && Date.now() - c.ts < CACHE_TTL_MS) return c.stats;
  const stats = await s3SubstrateStats(bucket, 8);
  cache.set(bucket, { ts: Date.now(), stats });
  return stats;
}

export interface BucketSubstrate {
  key: string;
  label: string;
  bucket: string;
  objectCount: number;
  bytesTotal: number;
  bytesLast24h: number;
  truncated?: boolean;
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
      buckets: defs.map((d) => ({ ...d, objectCount: 0, bytesTotal: 0, bytesLast24h: 0 })),
      recent: [],
      totals: { objectCount: 0, bytesTotal: 0, bytesLast24h: 0 },
      warnings: ["S3 not configured (set OBJECTSTORE_ENDPOINT + OBJECTSTORE_ACCESS_KEY_ID)"],
      ts: new Date().toISOString(),
    };
  }

  const results = await Promise.all(
    defs.map(async (d) => {
      try {
        return { d, s: await cachedStats(d.bucket) };
      } catch (e) {
        warnings.push(`${d.label} (${d.bucket}): ${describeS3Error(e)}`);
        return { d, s: null };
      }
    }),
  );

  const buckets: BucketSubstrate[] = results
    .map(({ d, s }) => ({
      key: d.key,
      label: d.label,
      bucket: d.bucket,
      objectCount: s?.objectCount ?? 0,
      bytesTotal: s?.bytesTotal ?? 0,
      bytesLast24h: s?.bytesLast24h ?? 0,
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

  return { configured: true, endpoint, region, capacityBytes, buckets, recent, totals, warnings, ts: new Date().toISOString() };
}

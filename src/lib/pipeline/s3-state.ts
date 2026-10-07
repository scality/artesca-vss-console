import type { S3State } from "@/lib/types/pipeline";

/** Totals as the shared bucket cache reports them — the whole bucket, not a page. */
export interface BucketTotals {
  objectCount: number;
  bytesTotal: number;
  truncated?: boolean;
}

/** The previous totals a PUT rate is measured against. */
export interface BucketSample {
  ts: number;
  count: number;
  bytes: number;
  putRateMBps: number;
  putRateObjPerMin: number;
}

export interface S3StateInput {
  bucket: string;
  endpoint: string | null;
  totals: BucketTotals;
  /** Operator-configured cluster capacity; 0 or less means unknown. */
  capacityBytes: number;
  prev: BucketSample | undefined;
  nowMs: number;
  /** When the totals were scanned (epoch ms). Omitted = scanned at `nowMs`. */
  scannedAt?: number | null;
}

/**
 * Pure: the next PUT-rate sample from the previous one and a new full-bucket
 * total.
 *
 * The rate is a delta between two *different* totals. A cached total is served
 * unchanged until its next refresh, and a zero delta over that interval would
 * read as "writes stopped"; the previous rate is held instead until the total
 * moves. Shared by the topology node and /api/storage/vst so the two cannot
 * disagree about what a refresh interval means.
 */
export function advancePutRateSample(
  prev: BucketSample | undefined,
  totals: BucketTotals,
  nowMs: number,
): BucketSample {
  const { objectCount, bytesTotal } = totals;
  let putRateMBps = prev?.putRateMBps ?? 0;
  let putRateObjPerMin = prev?.putRateObjPerMin ?? 0;
  if (prev && prev.bytes === bytesTotal && prev.count === objectCount) return prev;
  if (prev) {
    const deltaS = (nowMs - prev.ts) / 1000;
    if (deltaS > 0) {
      putRateMBps = Math.max(0, bytesTotal - prev.bytes) / 1024 / 1024 / deltaS;
      putRateObjPerMin = (Math.max(0, objectCount - prev.count) / deltaS) * 60;
    }
  }
  return { ts: nowMs, count: objectCount, bytes: bytesTotal, putRateMBps, putRateObjPerMin };
}

/**
 * Pure: the S3 topology node's state from a full-bucket total and the previous
 * sample.
 *
 * Fill is against the configured capacity, never a fixed figure: on
 * pyramid-showroom the recordings bucket held 6.99 TiB against a 100 GiB
 * constant, so the gauge had no meaning. With no capacity configured the
 * percentage is null and the renderer says so.
 *
 * The PUT rate comes from advancePutRateSample, which holds the previous rate
 * while the cache serves the same total.
 */
export function computeS3State(input: S3StateInput): { state: S3State; sample: BucketSample } {
  const { bucket, endpoint, totals, capacityBytes, prev, nowMs, scannedAt } = input;
  const { objectCount, bytesTotal } = totals;
  const sample = advancePutRateSample(prev, totals, nowMs);
  const { putRateMBps, putRateObjPerMin } = sample;

  const capacity = capacityBytes > 0 ? capacityBytes : null;
  return {
    state: {
      bucket,
      endpoint,
      objectCount,
      bytesTotal,
      putRateMBps,
      putRateObjPerMin,
      capacityBytes: capacity,
      capacityPct: capacity === null ? null : (bytesTotal / capacity) * 100,
      bucketScanTruncated: totals.truncated === true,
      bucketScanStaleSecs:
        scannedAt == null ? 0 : Math.max(0, Math.round((nowMs - scannedAt) / 1000)),
    },
    sample,
  };
}

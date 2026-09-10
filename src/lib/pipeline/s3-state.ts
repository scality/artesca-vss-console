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
 * The PUT rate is a delta between two *different* totals. The cache serves the
 * same total until its next refresh, and a zero delta over that interval would
 * read as "writes stopped"; the previous rate is held instead until the total
 * moves.
 */
export function computeS3State(input: S3StateInput): { state: S3State; sample: BucketSample } {
  const { bucket, endpoint, totals, capacityBytes, prev, nowMs } = input;
  const { objectCount, bytesTotal } = totals;

  let putRateMBps = prev?.putRateMBps ?? 0;
  let putRateObjPerMin = prev?.putRateObjPerMin ?? 0;
  const totalsMoved = !prev || prev.bytes !== bytesTotal || prev.count !== objectCount;
  let sample: BucketSample = prev ?? { ts: nowMs, count: objectCount, bytes: bytesTotal, putRateMBps, putRateObjPerMin };
  if (totalsMoved) {
    if (prev) {
      const deltaS = (nowMs - prev.ts) / 1000;
      if (deltaS > 0) {
        putRateMBps = Math.max(0, bytesTotal - prev.bytes) / 1024 / 1024 / deltaS;
        putRateObjPerMin = (Math.max(0, objectCount - prev.count) / deltaS) * 60;
      }
    }
    sample = { ts: nowMs, count: objectCount, bytes: bytesTotal, putRateMBps, putRateObjPerMin };
  }

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
      bucketScanStaleSecs: 0,
    },
    sample,
  };
}

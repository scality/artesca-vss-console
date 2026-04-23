import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import {
  S3Client,
  ListObjectsV2Command,
  type _Object as S3Object,
} from "@aws-sdk/client-s3";
import { runInPod } from "@/lib/k8s";
import { CLUSTER } from "@/lib/cluster-refs";
import { getRedis } from "@/lib/redis";

export const dynamic = "force-dynamic";

// ─── S3 client (reuses env vars already used by aws.ts) ──────────────────────

function makeS3Client(): S3Client {
  return new S3Client({
    region: process.env.AWS_REGION ?? "us-east-1",
    endpoint: CLUSTER.s3.endpoint || undefined,
    forcePathStyle: !!CLUSTER.s3.endpoint,
    // Credentials come from env vars (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY)
    // injected by k8s/console secrets at runtime. SDK picks them up automatically.
  });
}

// ─── In-memory PUT rate cache (fallback when Redis is unavailable) ────────────

interface BucketSample {
  ts: number;
  count: number;
  bytes: number;
}

const putRateCacheFallback = new Map<string, BucketSample>();

// ─── Redis helpers ────────────────────────────────────────────────────────────

const REDIS_SAMPLE_TTL_S = 120;
const REDIS_TOTALS_TTL_S = 60;
const TOTALS_SCAN_CAP = 5_000;

function putRateSampleKey(bucket: string): string {
  return `console:storage:vst:last-sample:${bucket}`;
}

function bucketTotalsKey(bucket: string): string {
  return `console:storage:vst:bucket-totals:${bucket}`;
}

interface CachedTotals {
  objectCount: number;
  bytesTotal: number;
  cachedAt: number;     // epoch ms
  truncated: boolean;   // true if the scan was capped at TOTALS_SCAN_CAP
}

async function readPutRateSample(bucket: string): Promise<BucketSample | null> {
  const { client } = getRedis();
  if (!client) return null;
  try {
    const raw = await client.get(putRateSampleKey(bucket));
    if (!raw) return null;
    return JSON.parse(raw) as BucketSample;
  } catch {
    return null;
  }
}

async function writePutRateSample(bucket: string, sample: BucketSample): Promise<void> {
  const { client } = getRedis();
  if (!client) return;
  try {
    await client.set(putRateSampleKey(bucket), JSON.stringify(sample), "EX", REDIS_SAMPLE_TTL_S);
  } catch {
    // best-effort
  }
}

async function readCachedTotals(bucket: string): Promise<CachedTotals | null> {
  const { client } = getRedis();
  if (!client) return null;
  try {
    const raw = await client.get(bucketTotalsKey(bucket));
    if (!raw) return null;
    return JSON.parse(raw) as CachedTotals;
  } catch {
    return null;
  }
}

async function writeCachedTotals(bucket: string, totals: CachedTotals): Promise<void> {
  const { client } = getRedis();
  if (!client) return;
  try {
    await client.set(bucketTotalsKey(bucket), JSON.stringify(totals), "EX", REDIS_TOTALS_TTL_S);
  } catch {
    // best-effort
  }
}

// ─── Full paginating bucket scan ──────────────────────────────────────────────
// Counts all objects and sums their sizes. Capped at TOTALS_SCAN_CAP on the
// very first call (no cached value exists) to bound latency. Writes result to
// Redis so subsequent calls serve the cache.

async function scanBucketTotals(
  s3: S3Client,
  bucket: string,
  cap: number
): Promise<{ objectCount: number; bytesTotal: number; truncated: boolean }> {
  let objectCount = 0;
  let bytesTotal = 0;
  let continuationToken: string | undefined;

  do {
    const resp = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        MaxKeys: 1000,
        ContinuationToken: continuationToken,
      })
    );
    for (const obj of resp.Contents ?? []) {
      objectCount++;
      bytesTotal += obj.Size ?? 0;
    }
    continuationToken = resp.NextContinuationToken;
  } while (continuationToken && objectCount < cap);

  const truncated = !!(continuationToken && objectCount >= cap);
  return { objectCount, bytesTotal, truncated };
}

// ─── Response contract type ───────────────────────────────────────────────────

interface SegmentBucket {
  bucketMinKB: number;
  bucketMaxKB: number;
  count: number;
}

interface RecentObject {
  key: string;
  sensorId: string;
  ts: string;
  sizeBytes: number;
  ageSecs: number;
}

interface StorageAlert {
  severity: "info" | "warn" | "crit";
  message: string;
}

interface VstStorageResponse {
  putRateObjectsPerSec: number;
  putRateBytesPerSec: number;
  objectCount: number;
  bytesTotal: number;
  bucketScanTruncated: boolean;
  bucketScanStaleSecs: number;
  localCacheFillPercent: number | null;
  segmentSizeKBHistogram: SegmentBucket[];
  segmentDurationSecsP50: number | null;
  segmentDurationSecsP95: number | null;
  frameDropCount: number | null;
  frameDropRatePerMin: number | null;
  recentObjects: RecentObject[];
  alerts: StorageAlert[];
}

// ─── Histogram buckets (KB) ───────────────────────────────────────────────────

const SIZE_BUCKETS: Array<[number, number]> = [
  [0, 512],
  [512, 1024],
  [1024, 4096],
  [4096, 16384],
  [16384, Infinity],
];

function buildSizeHistogram(objects: S3Object[]): SegmentBucket[] {
  const counts = new Array<number>(SIZE_BUCKETS.length).fill(0);
  for (const obj of objects) {
    const sizeKB = (obj.Size ?? 0) / 1024;
    for (let i = 0; i < SIZE_BUCKETS.length; i++) {
      const [min, max] = SIZE_BUCKETS[i];
      if (sizeKB >= min && sizeKB < max) {
        counts[i]++;
        break;
      }
    }
  }
  return SIZE_BUCKETS.map(([min, max], i) => ({
    bucketMinKB: min,
    bucketMaxKB: max === Infinity ? Infinity : max,
    count: counts[i],
  }));
}

// ─── Segment duration P50 / P95 ───────────────────────────────────────────────

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.floor((p / 100) * (sorted.length - 1));
  return sorted[idx];
}

function parseSensorId(key: string): string {
  // Typical VST key format: "<sensor_id>/YYYY/MM/DD/HH/..." or "<sensor_id>-<ts>.mp4"
  // Best-effort: take everything before the first "/" or before the first "-".
  const slashIdx = key.indexOf("/");
  if (slashIdx > 0) return key.slice(0, slashIdx);
  const dashIdx = key.indexOf("-");
  if (dashIdx > 0) return key.slice(0, dashIdx);
  return "";
}

function computeSegmentDurations(
  objects: S3Object[]
): { p50: number | null; p95: number | null } {
  // Group by sensorId
  const groups = new Map<string, Array<{ ts: Date; sizeBytes: number }>>();
  for (const obj of objects) {
    const sensorId = parseSensorId(obj.Key ?? "");
    if (!sensorId || !obj.LastModified) continue;
    if (!groups.has(sensorId)) groups.set(sensorId, []);
    groups.get(sensorId)!.push({ ts: obj.LastModified, sizeBytes: obj.Size ?? 0 });
  }

  const allDeltas: number[] = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const sorted = [...group].sort((a, b) => a.ts.getTime() - b.ts.getTime());
    for (let i = 1; i < sorted.length; i++) {
      const deltaSecs = (sorted[i].ts.getTime() - sorted[i - 1].ts.getTime()) / 1000;
      allDeltas.push(deltaSecs);
    }
  }

  if (allDeltas.length === 0) return { p50: null, p95: null };
  allDeltas.sort((a, b) => a - b);
  return {
    p50: percentile(allDeltas, 50),
    p95: percentile(allDeltas, 95),
  };
}

// ─── Local cache fill via pod exec ────────────────────────────────────────────

async function fetchLocalCacheFill(
  alerts: StorageAlert[]
): Promise<number | null> {
  try {
    const result = await runInPod(
      CLUSTER.vst.namespace,
      "app=sensor-ms",
      [
        "sh",
        "-c",
        "df -P /home/vst/vst_release/vst_video 2>/dev/null | awk 'NR==2 {print $5}'",
      ],
      8_000
    );
    const raw = result.stdout.trim().replace("%", "");
    const pct = parseFloat(raw);
    if (isNaN(pct)) {
      throw new Error(`Unexpected df output: "${result.stdout.trim()}"`);
    }
    if (pct > 90) {
      alerts.push({
        severity: "crit",
        message: `Local cache at ${pct}%, recordings may drop`,
      });
    }
    return pct;
  } catch (err) {
    console.warn("[storage/vst] localCacheFillPercent unavailable:", String(err));
    alerts.push({
      severity: "warn",
      message: "Local cache fill unavailable — could not exec into sensor-ms pod",
    });
    return null;
  }
}

// ─── Prometheus frame drop count + rate ──────────────────────────────────────

interface FrameDropStats {
  count: number | null;
  ratePerMin: number | null;
}

async function fetchFrameDropStats(
  alerts: StorageAlert[]
): Promise<FrameDropStats> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4_000);

  try {
    const baseUrl = CLUSTER.prometheus.url;

    // Run both queries in parallel
    const [countResp, rateResp] = await Promise.all([
      fetch(
        `${baseUrl}/api/v1/query?query=${encodeURIComponent("max(recorder_frames_dropped_total)")}`,
        { signal: controller.signal }
      ),
      fetch(
        `${baseUrl}/api/v1/query?query=${encodeURIComponent("sum(rate(recorder_frames_dropped_total[5m]))")}`,
        { signal: controller.signal }
      ),
    ]);

    clearTimeout(timer);

    // Parse count
    let count: number | null = null;
    if (countResp.ok) {
      const body = (await countResp.json()) as {
        data?: { result?: Array<{ value?: [number, string] }> };
      };
      const raw = body.data?.result?.[0]?.value?.[1];
      if (raw !== undefined) {
        const n = parseFloat(raw);
        if (!isNaN(n)) count = n;
      }
    }

    // Parse rate (per-second from Prometheus, convert to per-minute)
    let ratePerMin: number | null = null;
    if (rateResp.ok) {
      const body = (await rateResp.json()) as {
        data?: { result?: Array<{ value?: [number, string] }> };
      };
      const raw = body.data?.result?.[0]?.value?.[1];
      if (raw !== undefined) {
        const n = parseFloat(raw);
        if (!isNaN(n)) ratePerMin = n * 60;
      }
    }

    if (count === null && ratePerMin === null) {
      alerts.push({
        severity: "warn",
        message: "Frame drop metrics unavailable — Prometheus scrape failed",
      });
    }

    return { count, ratePerMin };
  } catch (err) {
    clearTimeout(timer);
    console.warn("[storage/vst] frameDropStats unavailable:", String(err));
    alerts.push({
      severity: "warn",
      message: "Frame drop count unavailable — Prometheus scrape failed",
    });
    return { count: null, ratePerMin: null };
  }
}

// ─── GET ──────────────────────────────────────────────────────────────────────

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const bucket = CLUSTER.s3.bucket;
  const s3 = makeS3Client();
  const alerts: StorageAlert[] = [];
  const nowMs = Date.now();

  // ── Stats pass: first page (up to 500) for histogram + recent objects ─────
  // This is the "sample window" — fast, bounded, feeds per-object analysis.
  let sampleObjects: S3Object[] = [];

  try {
    const resp = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        MaxKeys: 500,
      })
    );
    sampleObjects = resp.Contents ?? [];
  } catch (err: unknown) {
    const awsErr = err as { name?: string; message?: string; $metadata?: { httpStatusCode?: number } };
    return NextResponse.json(
      { error: awsErr.message ?? String(err), code: awsErr.name },
      { status: awsErr.$metadata?.httpStatusCode ?? 502 }
    );
  }

  // Sort sample by LastModified desc for recentObjects
  sampleObjects.sort((a, b) => {
    const ta = a.LastModified?.getTime() ?? 0;
    const tb = b.LastModified?.getTime() ?? 0;
    return tb - ta;
  });

  // ── Totals pass: paginating scan, Redis-cached ────────────────────────────
  // Read cached totals. If fresh (< REDIS_TOTALS_TTL_S), serve them.
  // If stale or missing, either block (first ever call) or revalidate in bg.
  let objectCount = 0;
  let bytesTotal = 0;
  let bucketScanTruncated = false;
  let bucketScanStaleSecs = 0;

  const cached = await readCachedTotals(bucket);

  if (cached) {
    // Stale-while-revalidate: serve the cache, kick off a background refresh.
    objectCount = cached.objectCount;
    bytesTotal = cached.bytesTotal;
    bucketScanTruncated = cached.truncated;
    bucketScanStaleSecs = Math.round((nowMs - cached.cachedAt) / 1000);

    // Background refresh (do not await — caller gets the stale value)
    scanBucketTotals(s3, bucket, Infinity)
      .then((result) => {
        const totals: CachedTotals = {
          objectCount: result.objectCount,
          bytesTotal: result.bytesTotal,
          cachedAt: Date.now(),
          truncated: result.truncated,
        };
        return writeCachedTotals(bucket, totals);
      })
      .catch((err) => {
        console.warn("[storage/vst] background totals scan failed:", String(err));
      });
  } else {
    // First call — block on a capped scan to bound latency.
    try {
      const result = await scanBucketTotals(s3, bucket, TOTALS_SCAN_CAP);
      objectCount = result.objectCount;
      bytesTotal = result.bytesTotal;
      bucketScanTruncated = result.truncated;
      bucketScanStaleSecs = 0;

      // Persist for next call (TTL = REDIS_TOTALS_TTL_S)
      await writeCachedTotals(bucket, {
        objectCount,
        bytesTotal,
        cachedAt: nowMs,
        truncated: bucketScanTruncated,
      });
    } catch (err: unknown) {
      // Non-fatal — fall back to sample count from the stats pass
      console.warn("[storage/vst] totals scan failed, using sample count:", String(err));
      objectCount = sampleObjects.length;
      bytesTotal = sampleObjects.reduce((s, o) => s + (o.Size ?? 0), 0);
      bucketScanTruncated = true;
      bucketScanStaleSecs = 0;
    }
  }

  // ── PUT rate (Redis-backed, in-memory fallback) ───────────────────────────
  let putRateObjectsPerSec = 0;
  let putRateBytesPerSec = 0;

  // Try Redis first
  let prevSample = await readPutRateSample(bucket);

  // Fall back to in-memory map if Redis missed
  if (!prevSample) {
    prevSample = putRateCacheFallback.get(bucket) ?? null;
  }

  if (prevSample) {
    const deltaS = (nowMs - prevSample.ts) / 1000;
    if (deltaS > 0) {
      const deltaObjects = Math.max(0, objectCount - prevSample.count);
      const deltaBytes = Math.max(0, bytesTotal - prevSample.bytes);
      putRateObjectsPerSec = deltaObjects / deltaS;
      putRateBytesPerSec = deltaBytes / deltaS;
    }
  }

  const currentSample: BucketSample = { ts: nowMs, count: objectCount, bytes: bytesTotal };

  // Write to Redis (best-effort) and update in-memory fallback
  await writePutRateSample(bucket, currentSample);
  putRateCacheFallback.set(bucket, currentSample);

  // ── Segment size histogram (last 200 objects from sample) ─────────────────
  const sampleForHistogram = sampleObjects.slice(0, 200);
  const segmentSizeKBHistogram = buildSizeHistogram(sampleForHistogram);

  // ── Segment duration P50 / P95 ────────────────────────────────────────────
  const { p50: segmentDurationSecsP50, p95: segmentDurationSecsP95 } =
    computeSegmentDurations(sampleForHistogram);

  // ── Recent objects (last 20) ──────────────────────────────────────────────
  const nowSec = nowMs / 1000;
  const recentObjects: RecentObject[] = sampleObjects.slice(0, 20).map((obj) => {
    const key = obj.Key ?? "";
    const ts = obj.LastModified?.toISOString() ?? "";
    const ageSecs = obj.LastModified ? nowSec - obj.LastModified.getTime() / 1000 : 0;
    return {
      key,
      sensorId: parseSensorId(key),
      ts,
      sizeBytes: obj.Size ?? 0,
      ageSecs: Math.round(ageSecs),
    };
  });

  // ── Additional alerts ─────────────────────────────────────────────────────

  if (objectCount === 0) {
    alerts.push({
      severity: "info",
      message: "No recordings in vss-video yet",
    });
  }

  if (
    segmentDurationSecsP50 !== null &&
    (segmentDurationSecsP50 < 2 || segmentDurationSecsP50 > 50)
  ) {
    alerts.push({
      severity: "warn",
      message: `Unusual segment duration: P50 is ${segmentDurationSecsP50.toFixed(1)}s (expected ~10s)`,
    });
  }

  // ── Fan-out: local cache fill + frame drop stats ──────────────────────────
  const [localCacheFillPercent, frameDropStats] = await Promise.all([
    fetchLocalCacheFill(alerts),
    fetchFrameDropStats(alerts),
  ]);

  const response: VstStorageResponse = {
    putRateObjectsPerSec,
    putRateBytesPerSec,
    objectCount,
    bytesTotal,
    bucketScanTruncated,
    bucketScanStaleSecs,
    localCacheFillPercent,
    segmentSizeKBHistogram,
    segmentDurationSecsP50,
    segmentDurationSecsP95,
    frameDropCount: frameDropStats.count,
    frameDropRatePerMin: frameDropStats.ratePerMin,
    recentObjects,
    alerts,
  };

  return NextResponse.json(response);
}

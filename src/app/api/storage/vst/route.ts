import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import {
  S3Client,
  ListObjectsV2Command,
  type _Object as S3Object,
} from "@aws-sdk/client-s3";
import { runInPod } from "@/lib/k8s";
import { CLUSTER } from "@/lib/cluster-refs";

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

// ─── In-memory PUT rate cache ─────────────────────────────────────────────────

interface BucketSample {
  ts: number;
  count: number;
  bytes: number;
}

const putRateCache = new Map<string, BucketSample>();

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
  localCacheFillPercent: number | null;
  segmentSizeKBHistogram: SegmentBucket[];
  segmentDurationSecsP50: number | null;
  segmentDurationSecsP95: number | null;
  frameDropCount: number | null;
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

interface SensorGroup {
  sensorId: string;
  objects: Array<{ ts: Date; sizeBytes: number }>;
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

// ─── Prometheus frame drop count ─────────────────────────────────────────────

async function fetchFrameDropCount(
  alerts: StorageAlert[]
): Promise<number | null> {
  try {
    const url = new URL("/api/v1/query", CLUSTER.prometheus.url);
    url.searchParams.set("query", "max(recorder_frames_dropped_total)");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4_000);
    const resp = await fetch(url.toString(), { signal: controller.signal });
    clearTimeout(timer);

    if (!resp.ok) {
      throw new Error(`Prometheus returned ${resp.status}`);
    }

    const body = (await resp.json()) as {
      data?: {
        result?: Array<{ value?: [number, string] }>;
      };
    };

    const result = body.data?.result?.[0];
    if (!result?.value?.[1]) return null;
    const count = parseFloat(result.value[1]);
    return isNaN(count) ? null : count;
  } catch (err) {
    console.warn("[storage/vst] frameDropCount unavailable:", String(err));
    alerts.push({
      severity: "warn",
      message: "Frame drop count unavailable — Prometheus scrape failed",
    });
    return null;
  }
}

// ─── GET ──────────────────────────────────────────────────────────────────────

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const bucket = CLUSTER.s3.bucket;
  const s3 = makeS3Client();
  const alerts: StorageAlert[] = [];

  // ── List up to 500 objects sorted by LastModified desc ───────────────────
  // S3 ListObjectsV2 doesn't support server-side sort; we fetch up to 500 and
  // sort client-side. "sorted by LastModified desc" for stats means we look at
  // the most recent 500, which suffices for histograms + segment duration.
  let allObjects: S3Object[] = [];
  let objectCount = 0;
  let bytesTotal = 0;
  let continuationToken: string | undefined;

  try {
    // Collect up to 500 for stats. Keep a running total for accurate counts.
    do {
      const resp = await s3.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          MaxKeys: 500,
          ContinuationToken: continuationToken,
        })
      );

      for (const obj of resp.Contents ?? []) {
        objectCount++;
        bytesTotal += obj.Size ?? 0;
        // Accumulate first page (up to 500) for per-object analysis
        if (allObjects.length < 500) {
          allObjects.push(obj);
        }
      }
      continuationToken = resp.NextContinuationToken;

      // After 500 objects collected for analysis, keep counting but stop storing
      // (continue loop only for count/bytes totals).
    } while (continuationToken);
  } catch (err: unknown) {
    const awsErr = err as { name?: string; message?: string; $metadata?: { httpStatusCode?: number } };
    return NextResponse.json(
      { error: awsErr.message ?? String(err), code: awsErr.name },
      { status: awsErr.$metadata?.httpStatusCode ?? 502 }
    );
  }

  // Sort the collected objects by LastModified desc.
  allObjects.sort((a, b) => {
    const ta = a.LastModified?.getTime() ?? 0;
    const tb = b.LastModified?.getTime() ?? 0;
    return tb - ta;
  });

  // ── PUT rate (in-memory delta against previous sample) ────────────────────
  const nowMs = Date.now();
  const prev = putRateCache.get(bucket);
  let putRateObjectsPerSec = 0;
  let putRateBytesPerSec = 0;

  if (prev) {
    const deltaS = (nowMs - prev.ts) / 1000;
    if (deltaS > 0) {
      const deltaObjects = Math.max(0, objectCount - prev.count);
      const deltaBytes = Math.max(0, bytesTotal - prev.bytes);
      putRateObjectsPerSec = deltaObjects / deltaS;
      putRateBytesPerSec = deltaBytes / deltaS;
    }
  }
  putRateCache.set(bucket, { ts: nowMs, count: objectCount, bytes: bytesTotal });

  // ── Segment size histogram (last 200 objects) ─────────────────────────────
  const sampleForHistogram = allObjects.slice(0, 200);
  const segmentSizeKBHistogram = buildSizeHistogram(sampleForHistogram);

  // ── Segment duration P50 / P95 ────────────────────────────────────────────
  const { p50: segmentDurationSecsP50, p95: segmentDurationSecsP95 } =
    computeSegmentDurations(sampleForHistogram);

  // ── Recent objects (last 20) ──────────────────────────────────────────────
  const nowSec = nowMs / 1000;
  const recentObjects: RecentObject[] = allObjects.slice(0, 20).map((obj) => {
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

  // No recordings after >5 min uptime
  if (objectCount === 0) {
    alerts.push({
      severity: "info",
      message: "No recordings in vss-video yet",
    });
  }

  // Unusual segment duration (expected ~10 s, warn if P50 outside 2–50 s)
  if (
    segmentDurationSecsP50 !== null &&
    (segmentDurationSecsP50 < 2 || segmentDurationSecsP50 > 50)
  ) {
    alerts.push({
      severity: "warn",
      message: `Unusual segment duration: P50 is ${segmentDurationSecsP50.toFixed(1)}s (expected ~10s)`,
    });
  }

  // ── Fan-out: local cache fill + frame drop count ──────────────────────────
  const [localCacheFillPercent, frameDropCount] = await Promise.all([
    fetchLocalCacheFill(alerts),
    fetchFrameDropCount(alerts),
  ]);

  const response: VstStorageResponse = {
    putRateObjectsPerSec,
    putRateBytesPerSec,
    objectCount,
    bytesTotal,
    localCacheFillPercent,
    segmentSizeKBHistogram,
    segmentDurationSecsP50,
    segmentDurationSecsP95,
    frameDropCount,
    recentObjects,
    alerts,
  };

  return NextResponse.json(response);
}

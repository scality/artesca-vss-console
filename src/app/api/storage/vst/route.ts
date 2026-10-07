import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { createLogger } from "@/lib/logger";

const log = createLogger("api/storage/vst");
import {
  ListObjectsV2Command,
  type _Object as S3Object,
} from "@aws-sdk/client-s3";
import { runInPod } from "@/lib/k8s";
import { CLUSTER } from "@/lib/cluster-refs";
import { getRedis } from "@/lib/redis";
import { makeS3Client } from "@/lib/s3";
import { vstListSensors } from "@/lib/helpers/vst";
import { sampleNewestBySensor } from "@/lib/storage/vst-sample";
import { bucketStatsSettled } from "@/lib/storage-substrate";
import { advancePutRateSample, type BucketSample } from "@/lib/pipeline/s3-state";
import { bucketTotalsState, type BucketTotalsState } from "@/lib/storage/bucket-scan";

export const dynamic = "force-dynamic";

// ─── PUT rate sample (Redis, in-memory fallback) ──────────────────────────────
// The rate is measured between two different full-bucket totals — see
// advancePutRateSample, which the topology node uses too.

const putRateCacheFallback = new Map<string, BucketSample>();

const REDIS_SAMPLE_TTL_S = 120;

function putRateSampleKey(bucket: string): string {
  return `console:storage:vst:last-sample:${bucket}`;
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
  /** What objectCount/bytesTotal mean: exact, a floor, or not known yet. They
   *  come from the shared full-bucket scan (storage-substrate), which pages the
   *  whole bucket up to BUCKET_SCAN_OBJECT_CAP. `pending` and `unavailable`
   *  carry zeros that must not be rendered as a count. */
  bucketTotalsState: BucketTotalsState;
  /** `bucketTotalsState === "truncated"`, kept for older clients. */
  bucketScanTruncated: boolean;
  bucketScanStaleSecs: number;
  /** How recentObjects, the histogram and the duration percentiles were sampled.
   *  `per-sensor` walks each live sensor's newest recorded hours. `first-page` is
   *  the fallback when VST lists no sensors or none has written: a single
   *  bucket-wide page, which is the lexicographically first 500 keys and therefore
   *  says nothing about what is recent. They are reported apart because they are
   *  not equally trustworthy, and the old behaviour was the second one unlabelled. */
  sampleMode: "per-sensor" | "first-page";
  /** Sensors the per-sensor sample walked. 0 on the fallback path. */
  sampleSensorCount: number;
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
  const parsePercent = (raw: string): number => {
    const pct = parseFloat(raw.trim().replace("%", ""));
    if (isNaN(pct)) throw new Error(`Unexpected df output: "${raw.trim()}"`);
    return pct;
  };


  // Helm: sensor pod label is app.kubernetes.io/name=vss-vios-sensor.
  // Legacy: app=sensor-ms.
  const sensorLabel = CLUSTER.legacy
    ? "app=sensor-ms"
    : "app.kubernetes.io/name=vss-vios-sensor";
  try {
    const result = await runInPod(
      CLUSTER.vst.namespace,
      sensorLabel,
      [
        "sh",
        "-c",
        "df -P /home/vst/vst_release/vst_video 2>/dev/null | awk 'NR==2 {print $5}'",
      ],
      8_000
    );
    const pct = parsePercent(result.stdout);
    if (pct > 90) {
      alerts.push({
        severity: "crit",
        message: `Local cache at ${pct}%, recordings may drop`,
      });
    }
    return pct;
  } catch (err) {
    log.warn("localCacheFillPercent unavailable", { err: String(err) });
    alerts.push({
      severity: "warn",
      message: `Local cache fill unavailable — could not exec into ${CLUSTER.vst.sensorDeployment} pod`,
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
      // Both queries succeeded (200) but returned no series, vs an actual
      // Prometheus failure (non-200). The VSS 3.2 recorder exposes no
      // Prometheus /metrics endpoint, so recorder_frames_dropped_total is
      // simply not collected — that's info, not an alarming scrape failure.
      const reachable = countResp.ok && rateResp.ok;
      alerts.push(
        reachable
          ? {
              severity: "info",
              message:
                "Frame-drop metric not collected — the VSS recorder exposes no Prometheus metric in this build",
            }
          : {
              severity: "warn",
              message: `Frame-drop metrics unavailable — Prometheus returned HTTP ${
                !countResp.ok ? countResp.status : rateResp.status
              }`,
            },
      );
    }

    return { count, ratePerMin };
  } catch (err) {
    clearTimeout(timer);
    log.warn("frameDropStats unavailable", { err: String(err) });
    alerts.push({
      severity: "warn",
      message: "Frame-drop metrics unavailable — Prometheus unreachable",
    });
    return { count: null, ratePerMin: null };
  }
}

// ─── GET ──────────────────────────────────────────────────────────────────────

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const bucket = CLUSTER.s3.buckets.recordings;
  const s3 = makeS3Client();
  const alerts: StorageAlert[] = [];
  const nowMs = Date.now();

  // ── Stats pass: the newest recorded hours, per sensor ─────────────────────
  // This is the "sample window" — it feeds recentObjects, the size histogram and
  // the segment-duration percentiles, so it has to be recent and it has to belong
  // to sensors that exist. See sampleNewestBySensor for what the single
  // bucket-wide first-page read did instead.
  let sampleObjects: S3Object[] = [];
  let sampleMode: "per-sensor" | "first-page" = "per-sensor";

  // Sensors as VST knows them, minus its tombstones — `status` is vstListSensors'
  // normalisation of VST's `state`, and "removed" means already deleted. Sampling a
  // tombstone's prefix is how the old window ended up describing a camera that had
  // not recorded in eight days. vstListSensors never throws: it reports a warning
  // and an empty list, which falls through to the first-page path below.
  const { sensors: vstSensors } = await vstListSensors();
  const sensorIds = vstSensors
    .filter((s) => s.status !== "removed")
    .map((s) => s.sensor_uuid ?? s.sensor_id)
    .filter((id): id is string => Boolean(id));

  try {
    if (sensorIds.length > 0) {
      sampleObjects = await sampleNewestBySensor(s3, bucket, sensorIds);
    }
    // No sensors, or none of them has written anything: fall back to the
    // bucket-wide first page. It is a poor sample — see sampleNewestBySensor — but
    // an empty panel would be worse, and `sampleMode` says which one you are
    // looking at rather than leaving the two indistinguishable.
    if (sampleObjects.length === 0) {
      sampleMode = "first-page";
      const resp = await s3.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          MaxKeys: 500,
        })
      );
      sampleObjects = resp.Contents ?? [];
    }
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

  // ── Totals pass: the shared full-bucket scan ─────────────────────────────
  // One paginated walk of the whole bucket, cached and refreshed in the
  // background by storage-substrate, and read by the overview and the topology
  // node too. This route used to run its own walk that stopped at 5,000 objects
  // on a cold cache — 1.7% of a 300k-object bucket — and reported that as the
  // total. A cold cache now answers "pending" and the panel says "counting".
  const totals = await bucketStatsSettled(bucket);
  const totalsState = bucketTotalsState(totals.stats, totals.refreshing);
  const objectCount = totals.stats?.objectCount ?? 0;
  const bytesTotal = totals.stats?.bytesTotal ?? 0;
  const bucketScanStaleSecs =
    totals.scannedAt === null ? 0 : Math.max(0, Math.round((nowMs - totals.scannedAt) / 1000));

  // ── PUT rate (Redis-backed, in-memory fallback) ───────────────────────────
  // Only from a real total: a pending/unavailable zero followed by the first
  // real total would read as the whole bucket written in one poll interval.
  let putRateObjectsPerSec = 0;
  let putRateBytesPerSec = 0;
  if (totals.stats) {
    const prevSample =
      (await readPutRateSample(bucket)) ?? putRateCacheFallback.get(bucket);
    const sample = advancePutRateSample(
      prevSample ?? undefined,
      { objectCount, bytesTotal },
      nowMs,
    );
    putRateBytesPerSec = (sample.putRateMBps ?? 0) * 1024 * 1024;
    putRateObjectsPerSec = (sample.putRateObjPerMin ?? 0) / 60;
    await writePutRateSample(bucket, sample);
    putRateCacheFallback.set(bucket, sample);
  }

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

  if (totalsState === "complete" && objectCount === 0) {
    alerts.push({
      severity: "info",
      message: `No recordings in ${bucket} yet`,
    });
  } else if (totalsState === "pending") {
    alerts.push({
      severity: "info",
      message: `Counting objects in ${bucket} — the first full scan of the bucket is still running`,
    });
  } else if (totalsState === "unavailable") {
    alerts.push({
      severity: "warn",
      message: `Object count unavailable — listing ${bucket} failed; retrying in the background`,
    });
  }

  // Recording-cadence sanity check. The S3-object inter-arrival reflects the
  // recorder's flush cadence, which differs by mode: ~10s for event-clip
  // recording (event_record_length_secs) vs ~60s for always_recording
  // (continuous). The console can't read the recorder mode here, so the bounds
  // are wide + env-overridable — warn only on a clearly stalled (minutes-long
  // gaps) or thrashing (sub-second) cadence, not on a normal ~60s continuous
  // segment.
  const segMinSecs = Number(process.env.VST_SEGMENT_MIN_SECS) || 1;
  const segMaxSecs = Number(process.env.VST_SEGMENT_MAX_SECS) || 180;
  if (
    segmentDurationSecsP50 !== null &&
    (segmentDurationSecsP50 < segMinSecs || segmentDurationSecsP50 > segMaxSecs)
  ) {
    alerts.push({
      severity: "warn",
      message: `Unusual segment cadence: P50 is ${segmentDurationSecsP50.toFixed(1)}s (normal is ~10s event-clip / ~60s continuous; outside ${segMinSecs}–${segMaxSecs}s suggests stalled or thrashing recording)`,
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
    bucketTotalsState: totalsState,
    bucketScanTruncated: totalsState === "truncated",
    bucketScanStaleSecs,
    sampleMode,
    sampleSensorCount: sampleMode === "per-sensor" ? sensorIds.length : 0,
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

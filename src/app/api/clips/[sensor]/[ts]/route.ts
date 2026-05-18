// GET /api/clips/[sensor]/[ts]
// Streams an HLS playlist for a 10-second clip centered on `ts` (ISO 8601).
// Decision C: transcode MP4→HLS with ffmpeg, cache on local PVC.
//
// Resolution order:
//   1. Server-side cache (/data/clip-cache/<sensor>-<ts>/index.m3u8) — hit → serve.
//   2. S3 bucket `nvidia-vss-alert-clips`: key derived by s3KeyForAlertClip().
//      Materialized by the alert clip materializer (k8s/nvidia-vss/alerts/22-).
//   3. VST clip endpoint (VST_MS_URL) — live fallback when the materializer
//      hasn't run or the clip rolled off.
//
// Response headers:
//   X-Cache: hit | miss
//   X-Cache-Age: <seconds>  (only on hit)
//   X-Source: cache | s3 | vst

import { type NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { CLUSTER } from "@/lib/cluster-refs";
import {
  cacheDir,
  cachePath,
  isCacheFresh,
  ensureCacheDir,
  evictLru,
  roundTs,
  CLIP_CACHE_TTL_MS,
} from "@/lib/streams/clip-cache";
import { transcodeToHls, extractThumbnail } from "@/lib/streams/ffmpeg";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { makeS3Client, s3BucketForAlertClips, s3KeyForAlertClip } from "@/lib/s3";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

interface RouteParams {
  params: Promise<{ sensor: string; ts: string }>;
}

async function fetchFromS3(
  sensor: string,
  tsRounded: Date
): Promise<Buffer | null> {
  // The materializer writes alert clips to nvidia-vss-alert-clips at the
  // canonical key. Key derivation is byte-identical to the Python materializer.
  const bucket = s3BucketForAlertClips();
  const key = s3KeyForAlertClip(sensor, tsRounded.toISOString());

  const client = makeS3Client();

  try {
    const resp = await client.send(
      new GetObjectCommand({ Bucket: bucket, Key: key })
    );
    if (!resp.Body) return null;
    // Collect stream into buffer.
    const chunks: Buffer[] = [];
    for await (const chunk of resp.Body as AsyncIterable<Buffer>) {
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  } catch {
    return null;
  }
}

async function fetchFromVst(
  sensor: string,
  ts: string
): Promise<Buffer | null> {
  const vstBase = process.env.VST_MS_URL ?? CLUSTER.vst.msUrl;
  const start = new Date(new Date(ts).getTime() - 5_000).toISOString();
  const end = new Date(new Date(ts).getTime() + 5_000).toISOString();
  const url = `${vstBase}/api/v1/live/sensor/${encodeURIComponent(sensor)}/clip?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`;

  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!resp.ok) return null;
    const ab = await resp.arrayBuffer();
    return Buffer.from(ab);
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest, { params }: RouteParams) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { sensor, ts } = await params;

  const playlistPath = cachePath(sensor, ts, "index.m3u8");

  // --- Cache hit ---
  if (isCacheFresh(playlistPath, CLIP_CACHE_TTL_MS)) {
    const stat = fs.statSync(playlistPath);
    const ageSeconds = Math.round((Date.now() - stat.mtimeMs) / 1_000);
    const content = fs.readFileSync(playlistPath, "utf8");
    return new NextResponse(content, {
      status: 200,
      headers: {
        "Content-Type": "application/vnd.apple.mpegurl",
        "X-Cache": "hit",
        "X-Cache-Age": String(ageSeconds),
        "X-Source": "cache",
        "Cache-Control": "no-store",
      },
    });
  }

  // --- Cache miss — resolve source ---
  const tsRounded = roundTs(ts);
  let mp4Buffer: Buffer | null = null;
  let source: "s3" | "vst" = "vst";

  mp4Buffer = await fetchFromS3(sensor, tsRounded);
  if (mp4Buffer) {
    source = "s3";
  }

  if (!mp4Buffer) {
    mp4Buffer = await fetchFromVst(sensor, ts);
  }

  if (!mp4Buffer) {
    return NextResponse.json(
      { error: "Clip not found in S3 or VST" },
      { status: 404 }
    );
  }

  // Write MP4 to a temp file for ffmpeg.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clip-"));
  const tmpMp4 = path.join(tmpDir, "clip.mp4");
  fs.writeFileSync(tmpMp4, mp4Buffer);

  const outDir = ensureCacheDir(sensor, ts);

  try {
    // Transcode MP4 → HLS.
    await transcodeToHls(tmpMp4, outDir);

    // Extract thumbnail alongside HLS.
    const thumbPath = cachePath(sensor, ts, "thumb.jpg");
    await extractThumbnail(tmpMp4, thumbPath);
  } finally {
    // Clean up temp MP4.
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  // LRU eviction in background (don't block response).
  setImmediate(evictLru);

  if (!fs.existsSync(playlistPath)) {
    return NextResponse.json(
      { error: "Transcoding produced no output" },
      { status: 500 }
    );
  }

  const content = fs.readFileSync(playlistPath, "utf8");
  return new NextResponse(content, {
    status: 200,
    headers: {
      "Content-Type": "application/vnd.apple.mpegurl",
      "X-Cache": "miss",
      "X-Source": source,
      "Cache-Control": "no-store",
    },
  });
}

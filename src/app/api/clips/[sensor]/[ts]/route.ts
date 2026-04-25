// GET /api/clips/[sensor]/[ts]
// Streams an HLS playlist for a 10-second clip centered on `ts` (ISO 8601).
// Decision C: transcode MP4→HLS with ffmpeg, cache on local PVC.
//
// Resolution order:
//   1. Server-side cache (/data/clip-cache/<sensor>-<ts>/index.m3u8) — hit → serve.
//   2. S3 bucket `vss-video`: key `<sensor>/<ts-rounded>.mp4`.
//   3. VST clip endpoint: http://sensor-ms.vst.svc.cluster.local:5010/...
//
// Response headers:
//   X-Cache: hit | miss
//   X-Cache-Age: <seconds>  (only on hit)

import { type NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
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
import { makeS3Client, s3Bucket } from "@/lib/s3";
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
  const bucket = s3Bucket();
  const key = `${sensor}/${tsRounded.toISOString().replace(/[:.]/g, "-")}.mp4`;

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
  const vstBase =
    process.env.VST_MS_URL ??
    "http://sensor-ms.vst.svc.cluster.local:5010";
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
        "Cache-Control": "no-store",
      },
    });
  }

  // --- Cache miss — resolve source ---
  const tsRounded = roundTs(ts);
  let mp4Buffer: Buffer | null = null;

  mp4Buffer = await fetchFromS3(sensor, tsRounded);

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
      "Cache-Control": "no-store",
    },
  });
}

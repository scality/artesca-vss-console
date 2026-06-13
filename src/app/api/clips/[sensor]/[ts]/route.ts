// GET /api/clips/[sensor]/[ts]
// Streams an HLS playlist for a 10-second clip centered on `ts` (ISO 8601).
// Decision C: transcode MP4→HLS with ffmpeg, cache on local PVC.
//
// Resolution order:
//   1. Server-side cache (/data/clip-cache/<sensor>-<ts>/index.m3u8) — hit → serve.
//   2. Alert-clips bucket (alert-clip manifest at the canonical S3 key). If the
//      manifest exists, the materializer has confirmed the clip in VST; fetch the
//      video bytes from manifest.vst_clip_url, transcode to HLS, cache, serve.
//   3. VST clip endpoint (VST_MS_URL) — live fallback when the materializer has
//      not yet run or the manifest has rolled off.
//
// Response headers:
//   X-Cache:     hit | miss
//   X-Cache-Age: <seconds>  (only on hit)
//   X-Source:    cache | s3-confirmed | vst-live

import { type NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { resolveStreamId, buildVstClipUrl } from "@/lib/streams/vst-clip";
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
import type { AlertClipManifest } from "@/lib/types";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

interface RouteParams {
  params: Promise<{ sensor: string; ts: string }>;
}

/**
 * Fetches the alert-clip manifest from the alert-clips S3 bucket.
 * Returns the parsed manifest when the materializer has confirmed this clip,
 * or null when no manifest exists (clip not yet materialized or rolled off).
 */
async function fetchManifestFromS3(
  sensor: string,
  tsRounded: Date
): Promise<AlertClipManifest | null> {
  const bucket = s3BucketForAlertClips();
  const key = s3KeyForAlertClip(sensor, tsRounded.toISOString());
  const client = makeS3Client();

  try {
    const resp = await client.send(
      new GetObjectCommand({ Bucket: bucket, Key: key })
    );
    if (!resp.Body) return null;

    const chunks: Buffer[] = [];
    for await (const chunk of resp.Body as AsyncIterable<Buffer>) {
      chunks.push(chunk);
    }
    const text = Buffer.concat(chunks).toString("utf8");
    return JSON.parse(text) as AlertClipManifest;
  } catch {
    return null;
  }
}

/**
 * Fetches raw MP4 bytes from a VST clip URL.
 * Used for both the s3-confirmed path (manifest.vst_clip_url) and the
 * vst-live fallback (URL constructed inline from sensor + ts).
 */
async function fetchMp4FromUrl(url: string): Promise<Buffer | null> {
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
  let source: "s3-confirmed" | "vst-live" = "vst-live";

  // Branch 1: manifest exists → the materializer confirmed the clip in VST.
  // Fetch bytes directly from the VST URL recorded in the manifest.
  const manifest = await fetchManifestFromS3(sensor, tsRounded);
  if (manifest) {
    mp4Buffer = await fetchMp4FromUrl(manifest.vst_clip_url);
    if (mp4Buffer) {
      source = "s3-confirmed";
    }
  }

  // Branch 2: no manifest (or VST unreachable via manifest URL) → fetch the
  // recorded clip from VST storage. Resolve the sensor name to its stream id,
  // then download the ±5s MP4 from /storage/file/{streamId}.
  if (!mp4Buffer) {
    const streamId = await resolveStreamId(sensor);
    if (streamId) {
      mp4Buffer = await fetchMp4FromUrl(buildVstClipUrl(streamId, ts));
    }
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

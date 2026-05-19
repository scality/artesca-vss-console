// POST /api/clips/preload
// Body: { sensor: string; ts: string }[]
// Warms the HLS clip cache in the background for the given sensor+ts pairs.
// Respects the ffmpeg pool (max 2 concurrent) to avoid CPU overload.
// Returns immediately with { queued: number }.
//
// Warming strategy:
//   1. Check PVC cache — already warm, skip.
//   2. Fetch alert-clip manifest from S3. If present, use manifest.vst_clip_url
//      to fetch video bytes (the materializer has confirmed the clip in VST).
//   3. If no manifest, fetch from VST live using a computed clip window.

import { type NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { CLUSTER } from "@/lib/cluster-refs";
import {
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
import { z } from "zod";

const PreloadBodySchema = z.array(
  z.object({
    sensor: z.string().min(1),
    ts: z.string().datetime(),
  })
);

/**
 * Fetches the alert-clip manifest from the alert-clips S3 bucket.
 * Returns null when no manifest exists.
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
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as AlertClipManifest;
  } catch {
    return null;
  }
}

async function fetchMp4FromUrl(url: string): Promise<Buffer | null> {
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!resp.ok) return null;
    return Buffer.from(await resp.arrayBuffer());
  } catch {
    return null;
  }
}

function buildVstLiveUrl(sensor: string, ts: string): string {
  const vstBase = process.env.VST_MS_URL ?? CLUSTER.vst.msUrl;
  const start = new Date(new Date(ts).getTime() - 5_000).toISOString();
  const end = new Date(new Date(ts).getTime() + 5_000).toISOString();
  return `${vstBase}/api/v1/live/sensor/${encodeURIComponent(sensor)}/clip?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`;
}

async function warmClip(sensor: string, ts: string): Promise<void> {
  const playlistPath = cachePath(sensor, ts, "index.m3u8");
  if (isCacheFresh(playlistPath, CLIP_CACHE_TTL_MS)) return;

  const tsRounded = roundTs(ts);

  // Manifest-first: use the VST URL the materializer recorded.
  let mp4Buffer: Buffer | null = null;
  const manifest = await fetchManifestFromS3(sensor, tsRounded);
  if (manifest) {
    mp4Buffer = await fetchMp4FromUrl(manifest.vst_clip_url);
  }

  // Fallback: construct a fresh clip window and fetch from VST live.
  if (!mp4Buffer) {
    mp4Buffer = await fetchMp4FromUrl(buildVstLiveUrl(sensor, ts));
  }

  if (!mp4Buffer) return;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clip-pre-"));
  const tmpMp4 = path.join(tmpDir, "clip.mp4");
  fs.writeFileSync(tmpMp4, mp4Buffer);
  const outDir = ensureCacheDir(sensor, ts);

  try {
    await transcodeToHls(tmpMp4, outDir);
    const thumbPath = cachePath(sensor, ts, "thumb.jpg");
    await extractThumbnail(tmpMp4, thumbPath);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = PreloadBodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const items = parsed.data;
  // Fire-and-forget background warming.
  // The ffmpeg pool (MAX_CONCURRENT=2) naturally throttles concurrency.
  void (async () => {
    for (const { sensor, ts } of items) {
      try {
        await warmClip(sensor, ts);
      } catch {
        // Best-effort — ignore individual failures.
      }
    }
    evictLru();
  })();

  return NextResponse.json({ queued: items.length });
}

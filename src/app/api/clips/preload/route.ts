// POST /api/clips/preload
// Body: { sensor: string; ts: string }[]
// Warms the HLS clip cache in the background for the given sensor+ts pairs.
// Respects the ffmpeg pool (max 2 concurrent) to avoid CPU overload.
// Returns immediately with { queued: number }.

import { type NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import {
  cachePath,
  isCacheFresh,
  ensureCacheDir,
  evictLru,
  roundTs,
  CLIP_CACHE_TTL_MS,
} from "@/lib/streams/clip-cache";
import { transcodeToHls, extractThumbnail } from "@/lib/streams/ffmpeg";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
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

async function fetchFromS3(
  sensor: string,
  tsRounded: Date
): Promise<Buffer | null> {
  const bucket = process.env.VSS_VIDEO_BUCKET ?? "vss-video";
  const key = `${sensor}/${tsRounded.toISOString().replace(/[:.]/g, "-")}.mp4`;
  const client = new S3Client({
    region: process.env.AWS_REGION ?? "us-west-2",
    endpoint: process.env.S3_ENDPOINT,
    forcePathStyle: !!process.env.S3_ENDPOINT,
  });
  try {
    const resp = await client.send(
      new GetObjectCommand({ Bucket: bucket, Key: key })
    );
    if (!resp.Body) return null;
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
    return Buffer.from(await resp.arrayBuffer());
  } catch {
    return null;
  }
}

async function warmClip(sensor: string, ts: string): Promise<void> {
  const playlistPath = cachePath(sensor, ts, "index.m3u8");
  if (isCacheFresh(playlistPath, CLIP_CACHE_TTL_MS)) return;

  const tsRounded = roundTs(ts);
  let mp4Buffer = await fetchFromS3(sensor, tsRounded);
  if (!mp4Buffer) mp4Buffer = await fetchFromVst(sensor, ts);
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

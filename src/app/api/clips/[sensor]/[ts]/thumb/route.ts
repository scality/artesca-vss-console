// GET /api/clips/[sensor]/[ts]/thumb
//
// Serves a 320×180 JPEG thumbnail for a clip. Self-sufficient: the thumbnail
// is produced without requiring the HLS playlist to have been fetched first.
//
// Resolution order:
//   1. Fresh thumb.jpg in the clip cache  → serve immediately (X-Cache: hit).
//   2. HLS seg000.ts in cache             → extract frame 0 via ffmpeg.
//   3. Download the ±5 s MP4 from VST     → extract frame 0, cache thumb.jpg.
//
// Fail-soft: any error in step 3 (stream not found, VST unreachable, ffmpeg
// failure) returns a 1×1 transparent PNG with status 200 so a missing or
// expired clip never produces a broken-image icon in the grid.
//
// The ffmpeg concurrency pool (MAX_CONCURRENT=2 in ffmpeg.ts) bounds the number
// of simultaneous extractions. Cards use loading="lazy" so off-screen cards
// don't trigger a fetch until they scroll into view.

import { type NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import {
  cachePath,
  isCacheFresh,
  ensureCacheDir,
  CLIP_CACHE_TTL_MS,
} from "@/lib/streams/clip-cache";
import { extractThumbnail } from "@/lib/streams/ffmpeg";
import { resolveStreamId, buildVstClipUrl } from "@/lib/streams/vst-clip";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/** 1×1 fully-transparent PNG returned on any hard failure. */
const PLACEHOLDER_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

function placeholder(): NextResponse {
  return new NextResponse(new Uint8Array(PLACEHOLDER_PNG), {
    status: 200,
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "no-store",
      "X-Thumb": "placeholder",
    },
  });
}

function serveJpeg(data: Buffer, cacheStatus: "hit" | "miss", source?: string): NextResponse {
  return new NextResponse(new Uint8Array(data), {
    status: 200,
    headers: {
      "Content-Type": "image/jpeg",
      "Content-Length": String(data.length),
      "Cache-Control": "public, max-age=86400, immutable",
      "X-Cache": cacheStatus,
      ...(source ? { "X-Source": source } : {}),
    },
  });
}

interface RouteParams {
  params: Promise<{ sensor: string; ts: string }>;
}

export async function GET(_req: NextRequest, { params }: RouteParams) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { sensor, ts } = await params;
  const thumbPath = cachePath(sensor, ts, "thumb.jpg");

  // 1. Serve from cache when available and fresh.
  if (isCacheFresh(thumbPath, CLIP_CACHE_TTL_MS)) {
    const data = fs.readFileSync(thumbPath);
    return serveJpeg(data, "hit");
  }

  // 2. If HLS segments exist in cache, extract thumbnail from the first segment.
  const seg0 = cachePath(sensor, ts, "seg000.ts");
  if (fs.existsSync(seg0)) {
    try {
      ensureCacheDir(sensor, ts);
      await extractThumbnail(seg0, thumbPath);
      if (fs.existsSync(thumbPath)) {
        const data = fs.readFileSync(thumbPath);
        return serveJpeg(data, "miss", "hls-segment");
      }
    } catch {
      // Fall through to the VST download path.
    }
  }

  // 3. Download the clip from VST and extract frame 0. This is the
  //    self-sufficient path that makes the thumb route independent of the
  //    HLS playlist route. Any failure returns the transparent placeholder.
  try {
    const streamId = await resolveStreamId(sensor);
    if (!streamId) return placeholder();

    const mp4Url = buildVstClipUrl(streamId, ts);
    const resp = await fetch(mp4Url, { signal: AbortSignal.timeout(30_000) });
    if (!resp.ok) return placeholder();

    const mp4Buffer = Buffer.from(await resp.arrayBuffer());

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "thumb-"));
    const tmpMp4 = path.join(tmpDir, "clip.mp4");
    fs.writeFileSync(tmpMp4, mp4Buffer);

    ensureCacheDir(sensor, ts);
    try {
      await extractThumbnail(tmpMp4, thumbPath, 0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    if (!fs.existsSync(thumbPath)) return placeholder();

    const data = fs.readFileSync(thumbPath);
    return serveJpeg(data, "miss", "vst-live");
  } catch {
    return placeholder();
  }
}

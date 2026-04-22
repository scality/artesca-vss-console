// GET /api/clips/[sensor]/[ts]/thumb
// Serves a 320x180 JPEG thumbnail for a clip.
// Thumbnail is produced by the same ffmpeg pass as the HLS transcode.
// If the HLS cache exists but no thumbnail, triggers a standalone ffmpeg extraction.

import { type NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import {
  cachePath,
  isCacheFresh,
  ensureCacheDir,
  CLIP_CACHE_TTL_MS,
} from "@/lib/streams/clip-cache";
import { extractThumbnail } from "@/lib/streams/ffmpeg";
import * as fs from "fs";

interface RouteParams {
  params: Promise<{ sensor: string; ts: string }>;
}

export async function GET(req: NextRequest, { params }: RouteParams) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { sensor, ts } = await params;

  const thumbPath = cachePath(sensor, ts, "thumb.jpg");

  // Serve from cache when available and fresh.
  if (isCacheFresh(thumbPath, CLIP_CACHE_TTL_MS)) {
    const data = fs.readFileSync(thumbPath);
    return new NextResponse(data, {
      status: 200,
      headers: {
        "Content-Type": "image/jpeg",
        "Content-Length": String(data.length),
        "Cache-Control": "public, max-age=86400, immutable",
        "X-Cache": "hit",
      },
    });
  }

  // If there are HLS segments in cache, we can extract the thumb from the first segment.
  const seg0 = cachePath(sensor, ts, "seg000.ts");
  if (!fs.existsSync(seg0)) {
    return NextResponse.json(
      {
        error:
          "Clip not in cache — request the playlist at /api/clips/[sensor]/[ts] first",
      },
      { status: 404 }
    );
  }

  ensureCacheDir(sensor, ts);
  await extractThumbnail(seg0, thumbPath);

  if (!fs.existsSync(thumbPath)) {
    return NextResponse.json(
      { error: "Thumbnail extraction failed" },
      { status: 500 }
    );
  }

  const data = fs.readFileSync(thumbPath);
  return new NextResponse(data, {
    status: 200,
    headers: {
      "Content-Type": "image/jpeg",
      "Content-Length": String(data.length),
      "Cache-Control": "public, max-age=86400, immutable",
      "X-Cache": "miss",
    },
  });
}

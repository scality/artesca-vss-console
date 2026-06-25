// GET /api/clips/[sensor]/[ts]/[segment]
// Serves the HLS playlist (index.m3u8 — what the browser player loads) and the
// .ts segments from the clip cache. The player requests the playlist at this
// path (.../[ts]/index.m3u8) so its relative segment URLs resolve to
// .../[ts]/segNNN.ts, which this same route serves.
// MIME: application/vnd.apple.mpegurl (playlist) | video/mp2t (segment)

import { type NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { cachePath, isCacheFresh } from "@/lib/streams/clip-cache";
import { serveClipPlaylist } from "@/lib/streams/serve-clip";
import * as fs from "fs";

interface RouteParams {
  params: Promise<{ sensor: string; ts: string; segment: string }>;
}

export async function GET(_req: NextRequest, { params }: RouteParams) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { sensor, ts, segment } = await params;

  // The player loads the playlist from this path so relative seg URLs resolve.
  if (segment === "index.m3u8") {
    return serveClipPlaylist(sensor, ts);
  }

  // Only serve .ts segment files.
  if (!segment.endsWith(".ts")) {
    return NextResponse.json({ error: "Not a segment file" }, { status: 400 });
  }

  const segPath = cachePath(sensor, ts, segment);

  if (!fs.existsSync(segPath) || !isCacheFresh(segPath)) {
    return NextResponse.json(
      { error: "Segment not found or expired" },
      { status: 404 }
    );
  }

  const data = fs.readFileSync(segPath);
  return new NextResponse(data, {
    status: 200,
    headers: {
      "Content-Type": "video/mp2t",
      "Content-Length": String(data.length),
      "Cache-Control": "public, max-age=86400, immutable",
    },
  });
}

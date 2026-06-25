// GET /api/clips/[sensor]/[ts]
// Returns the HLS playlist for a ~10s clip centered on `ts` (ISO 8601).
// Shared logic (cache → alert-clips manifest → VST live, transcode to HLS)
// lives in @/lib/streams/serve-clip; the browser player loads the playlist via
// the sibling [ts]/index.m3u8 path so its relative segment URLs resolve.
//
// Response headers: X-Cache (hit|miss), X-Cache-Age (on hit), X-Source.

import { type NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { serveClipPlaylist } from "@/lib/streams/serve-clip";

interface RouteParams {
  params: Promise<{ sensor: string; ts: string }>;
}

export async function GET(_req: NextRequest, { params }: RouteParams) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { sensor, ts } = await params;
  return serveClipPlaylist(sensor, ts);
}

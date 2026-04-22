// GET /api/clips/[sensor]/[ts]/[segment]
// Serves an HLS .ts segment from the clip cache.
// MIME: video/mp2t

import { type NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { cachePath, isCacheFresh } from "@/lib/streams/clip-cache";
import * as fs from "fs";

interface RouteParams {
  params: Promise<{ sensor: string; ts: string; segment: string }>;
}

export async function GET(req: NextRequest, { params }: RouteParams) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { sensor, ts, segment } = await params;

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

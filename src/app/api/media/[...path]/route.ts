// GET /api/media/[...path]
//
// Same-origin proxy for VSS chat media (snapshot .jpg / clip .mp4). The
// vss-agent stamps snapshot/clip URLs with host CLUSTER.agent.mediaHost (e.g.
// "vss-agent:8000") — a ClusterIP no browser can reach. The bytes are actually
// served by VST's webroot at CLUSTER.vst.mediaOrigin (the console can reach it
// in-cluster). /api/chat/route.ts rewrites the agent's media-host prefix to
// this route's base path before a reply reaches the browser, so a click just
// works from any browser hitting the console — no laptop tunnel needed.
//
// Only forwards paths under /vst/ (the one webroot this proxy exists for) —
// not a general-purpose open proxy.
import { type NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { CLUSTER } from "@/lib/cluster-refs";

interface RouteParams {
  params: Promise<{ path: string[] }>;
}

// This proxy exists only for VST snapshot (.jpg) / clip (.mp4) bytes. Derive
// the response Content-Type from the path extension against a fixed media
// allowlist — never pass the upstream Content-Type through, so a MIME-confused
// object can't be served as text/html (stored XSS on the console origin).
const MEDIA_CONTENT_TYPES: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  mp4: "video/mp4",
  webm: "video/webm",
  ts: "video/mp2t",
  m3u8: "application/vnd.apple.mpegurl",
};

export async function GET(_req: NextRequest, { params }: RouteParams) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { path } = await params;
  const upstreamPath = "/" + path.map(encodeURIComponent).join("/");
  if (!upstreamPath.startsWith("/vst/")) {
    return NextResponse.json({ error: "Not a VST media path" }, { status: 400 });
  }

  const filename = path[path.length - 1] ?? "";
  const ext = filename.includes(".") ? filename.split(".").pop()!.toLowerCase() : "";
  const contentType = MEDIA_CONTENT_TYPES[ext];
  if (!contentType) {
    return NextResponse.json({ error: "Unsupported media type" }, { status: 415 });
  }

  try {
    // No overall AbortSignal.timeout here: a clip can legitimately be large
    // (VST's "full available recording" fallback has been observed at
    // 300+ MB) and streaming it can take longer than a fixed budget allows.
    // fetch() still fails fast on connection errors.
    const resp = await fetch(`${CLUSTER.vst.mediaOrigin}${upstreamPath}`);
    if (!resp.ok || !resp.body) {
      return NextResponse.json(
        { error: `upstream HTTP ${resp.status}` },
        { status: resp.status === 404 ? 404 : 502 },
      );
    }
    // Stream the body straight through instead of buffering it into memory —
    // buffering a several-hundred-MB clip fallback would spike pod memory and
    // stall time-to-first-byte for the browser's <video> player.
    const headers: Record<string, string> = {
      "Content-Type": contentType,
      // Belt-and-suspenders against MIME confusion: never sniff, never let the
      // served bytes execute script, force inline (not a same-origin document).
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Content-Disposition": `inline; filename="${filename.replace(/[^\w.\-]/g, "_")}"`,
      // Snapshot/clip filenames embed a timestamp + random suffix (unique per
      // generation), so a given path is safe to cache indefinitely.
      "Cache-Control": "public, max-age=86400, immutable",
    };
    const contentLength = resp.headers.get("content-length");
    if (contentLength) headers["Content-Length"] = contentLength;
    return new NextResponse(resp.body, { status: 200, headers });
  } catch (e) {
    return NextResponse.json(
      { error: `media upstream unreachable: ${(e as Error).message}` },
      { status: 503 },
    );
  }
}

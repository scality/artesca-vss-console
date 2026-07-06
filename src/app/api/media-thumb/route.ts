// GET /api/media-thumb?src=<clip media path or /api/media/... url>
//
// The upstream VST still-image endpoint (vst_snapshot / .../picture/url) is
// broken cluster-wide ("Failed to start source producer") and stays bypassed
// by design — the agent prompt is intentionally configured to emit CLIPS, not
// snapshots. This route produces a still JPEG from a RECORDED CLIP FRAME
// instead, via the same ffmpeg extraction /api/clips/[sensor]/[ts]/thumb
// already uses (extractThumbnail in @/lib/streams/ffmpeg) — never the broken
// decoder path.
//
// `src` is effectively LLM/VLM output (a chat clip URL rewritten by
// /api/chat's rewriteMediaUrls, or occasionally a bare VST path) — it is NOT
// trusted as an arbitrary fetch target. parseMediaSrc + resolveVstMediaPath
// (shared with /api/media/[...path] via @/lib/media-guard) pin it to the
// fixed VST media origin under /vst/storage/ before anything is fetched.
//
// Fail-soft by design: a broken/expired/malformed clip URL must never break
// the chat render. Any runtime failure (fetch, timeout, ffmpeg) serves a 1x1
// transparent PNG with 200 rather than surfacing an error to an <img> or a
// <video poster>. Only a missing `src` (a caller bug, not a runtime
// condition) returns 400, and an input that fails the media-origin guard or
// carries an unsupported extension returns 404 — both safe for the chat page
// to treat as "no snapshot available".
import { type NextRequest, NextResponse } from "next/server";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { randomUUID, createHash } from "crypto";
import { auth } from "@/lib/auth";
import {
  parseMediaSrc,
  resolveVstMediaPath,
  extensionOf,
  isVideoExtension,
  isImageExtension,
} from "@/lib/media-guard";
import { extractThumbnail } from "@/lib/streams/ffmpeg";
import { isCacheFresh, CLIP_CACHE_TTL_MS } from "@/lib/streams/clip-cache";
import { createLogger } from "@/lib/logger";

const log = createLogger("media-thumb");

const DATA_DIR = process.env.CONSOLE_DATA_DIR ?? "/data";
const CACHE_ROOT = path.join(DATA_DIR, "media-thumb-cache");

/** Refuse to buffer a pathologically large clip into memory — a chat clip is
 *  a short agent-generated temp file (seconds long), never hundreds of MB
 *  like the incident-window "full available recording" fallback can be. */
const MAX_SOURCE_BYTES = 150 * 1024 * 1024;

/** 1x1 fully-transparent PNG, served on any runtime failure so a broken clip
 *  URL degrades to an invisible still instead of a broken-image icon. */
const PLACEHOLDER_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

function placeholder(): NextResponse {
  return new NextResponse(new Uint8Array(PLACEHOLDER_PNG), {
    status: 200,
    headers: {
      "Content-Type": "image/png",
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": "inline",
      // Never cache a failure result — the clip may finish uploading or the
      // transient error may clear by the next request.
      "Cache-Control": "no-store",
      "X-Media-Thumb": "placeholder",
    },
  });
}

function serveJpeg(data: Buffer, cacheStatus: "hit" | "miss"): NextResponse {
  return new NextResponse(new Uint8Array(data), {
    status: 200,
    headers: {
      "Content-Type": "image/jpeg",
      "Content-Length": String(data.length),
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": "inline",
      // Cache key is a hash of the exact src, so a given entry never changes.
      "Cache-Control": "public, max-age=86400, immutable",
      "X-Cache": cacheStatus,
    },
  });
}

function cacheKeyFor(src: string): string {
  return createHash("sha256").update(src).digest("hex").slice(0, 40);
}

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const src = req.nextUrl.searchParams.get("src");
  if (!src) {
    return NextResponse.json({ error: "Missing src" }, { status: 400 });
  }

  const segments = parseMediaSrc(src);
  const resolved = segments ? resolveVstMediaPath(segments) : null;
  if (!resolved || !segments) {
    return NextResponse.json({ error: "src is not a VST media path" }, { status: 404 });
  }

  const filename = segments[segments.length - 1] ?? "";
  const ext = extensionOf(filename);
  if (!isVideoExtension(ext) && !isImageExtension(ext)) {
    return NextResponse.json({ error: "Unsupported media type" }, { status: 404 });
  }

  const cacheFile = path.join(CACHE_ROOT, `${cacheKeyFor(src)}.jpg`);
  if (isCacheFresh(cacheFile, CLIP_CACHE_TTL_MS)) {
    try {
      return serveJpeg(fs.readFileSync(cacheFile), "hit");
    } catch {
      // Fall through and regenerate — cache file vanished between stat+read.
    }
  }

  fs.mkdirSync(CACHE_ROOT, { recursive: true });

  // Already a still image (e.g. a legitimate snapshot .jpg slipped through
  // the same code path) — proxy it straight into the JPEG cache, no ffmpeg.
  if (isImageExtension(ext)) {
    try {
      const resp = await fetch(resolved, { signal: AbortSignal.timeout(20_000) });
      if (!resp.ok || !resp.body) throw new Error(`upstream HTTP ${resp.status}`);
      const bytes = Buffer.from(await resp.arrayBuffer());
      fs.writeFileSync(cacheFile, bytes);
      return serveJpeg(bytes, "miss");
    } catch (e) {
      log.warn("image passthrough failed", { src, err: (e as Error).message });
      return placeholder();
    }
  }

  // Video clip — fetch to a scratch temp file, then extract frame 0 via the
  // same ffmpeg helper the incident-clip thumbnail route uses.
  const tmpFile = path.join(os.tmpdir(), `media-thumb-${randomUUID()}.${ext}`);
  try {
    const resp = await fetch(resolved, { signal: AbortSignal.timeout(30_000) });
    if (!resp.ok || !resp.body) throw new Error(`upstream HTTP ${resp.status}`);

    const contentLength = Number(resp.headers.get("content-length") ?? "0");
    if (contentLength > MAX_SOURCE_BYTES) {
      throw new Error(`source too large (${contentLength} bytes)`);
    }
    const bytes = Buffer.from(await resp.arrayBuffer());
    if (bytes.byteLength > MAX_SOURCE_BYTES) {
      throw new Error(`source too large (${bytes.byteLength} bytes)`);
    }
    fs.writeFileSync(tmpFile, bytes);

    await extractThumbnail(tmpFile, cacheFile, 0);
    if (!fs.existsSync(cacheFile)) {
      throw new Error("ffmpeg produced no output");
    }
    return serveJpeg(fs.readFileSync(cacheFile), "miss");
  } catch (e) {
    log.warn("clip-frame extraction failed", { src, err: (e as Error).message });
    return placeholder();
  } finally {
    fs.rm(tmpFile, { force: true }, () => {});
  }
}

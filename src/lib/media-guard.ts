// src/lib/media-guard.ts
//
// Shared path-validation for VST media (snapshot .jpg / clip .mp4) fetched
// through the console. Both /api/media/[...path] (streams a clip/snapshot
// straight to the browser) and /api/media-thumb (extracts a still JPEG from a
// recorded clip via ffmpeg) resolve an upstream URL through the SAME guard so
// the VST-media-origin + /vst/storage/ pin can't drift between call sites.
//
// This is a security boundary, not a convenience helper: the input is
// LLM/VLM output (attacker-influenceable via camera feeds), so it must never
// be treated as a general-purpose URL fetcher.
import "server-only";
import { CLUSTER } from "@/lib/cluster-refs";

/** Content-Type allowlist keyed off the file extension — never trust an
 *  upstream Content-Type header (a MIME-confused object could otherwise be
 *  served as text/html, i.e. stored XSS on the console origin). */
export const MEDIA_CONTENT_TYPES: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mkv: "video/x-matroska",
  ts: "video/mp2t",
  m3u8: "application/vnd.apple.mpegurl",
};

const VIDEO_EXTENSIONS = new Set(["mp4", "webm", "mov", "mkv", "ts"]);
const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp", "gif"]);

export function extensionOf(filename: string): string {
  return filename.includes(".") ? filename.split(".").pop()!.toLowerCase() : "";
}

export function isVideoExtension(ext: string): boolean {
  return VIDEO_EXTENSIONS.has(ext);
}

export function isImageExtension(ext: string): boolean {
  return IMAGE_EXTENSIONS.has(ext);
}

/**
 * Validate a catch-all path array (as Next.js delivers it — URL-decoded, one
 * entry per "/"-separated segment) and resolve it against the FIXED VST media
 * origin, re-verifying origin + prefix AFTER normalization so a "/vst/../x"
 * style bypass that slips past the segment check can't still land outside the
 * /vst/storage/ webroot.
 *
 * Returns the resolved upstream URL, or null when the path is invalid or
 * escapes the allowed origin/prefix.
 */
export function resolveVstMediaPath(segments: string[]): URL | null {
  if (
    segments.length === 0 ||
    segments.some(
      (seg) =>
        seg === ".." ||
        seg === "." ||
        seg === "" ||
        seg.includes("/") ||
        seg.includes("\\") ||
        seg.includes("\0"),
    )
  ) {
    return null;
  }

  const upstreamPath = "/" + segments.map(encodeURIComponent).join("/");
  const mediaOrigin = CLUSTER.vst.mediaOrigin;
  let resolved: URL;
  try {
    resolved = new URL(upstreamPath, mediaOrigin);
  } catch {
    return null;
  }
  if (
    resolved.origin !== new URL(mediaOrigin).origin ||
    !resolved.pathname.startsWith("/vst/storage/")
  ) {
    return null;
  }
  return resolved;
}

/**
 * Parse a "src" value referencing VST media into path segments suitable for
 * resolveVstMediaPath(). Accepts:
 *  - the console's own same-origin proxy path ("/api/media/vst/storage/...")
 *  - a bare upstream-relative path ("/vst/storage/..." or "vst/storage/...")
 *  - a full URL, but ONLY when its scheme+origin matches the fixed VST media
 *    origin (never follows an arbitrary external host).
 * Returns null for anything else (protocol-relative URLs, foreign hosts,
 * empty input) — the caller should treat null as "reject", not "best effort".
 */
export function parseMediaSrc(rawSrc: string): string[] | null {
  let s = rawSrc.trim();
  if (!s) return null;
  if (s.startsWith("//")) return null; // protocol-relative — ambiguous origin

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    let url: URL;
    let mediaOrigin: URL;
    try {
      url = new URL(s);
      mediaOrigin = new URL(CLUSTER.vst.mediaOrigin);
    } catch {
      return null;
    }
    if (url.protocol !== mediaOrigin.protocol || url.origin !== mediaOrigin.origin) {
      return null;
    }
    s = url.pathname;
  }

  if (s.startsWith("/api/media/")) {
    s = s.slice("/api/media".length);
  }

  s = s.split("?")[0]!.split("#")[0]!;
  const segments = s.split("/").filter((seg) => seg.length > 0);
  return segments.length > 0 ? segments : null;
}

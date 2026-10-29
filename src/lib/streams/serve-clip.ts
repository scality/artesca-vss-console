// Shared HLS clip-playlist serving used by both clip routes:
//   GET /api/clips/[sensor]/[ts]            (direct / debug)
//   GET /api/clips/[sensor]/[ts]/index.m3u8 (what the browser player loads —
//                                            the player needs the playlist at
//                                            a path under .../[ts]/ so its
//                                            relative seg URLs resolve to
//                                            .../[ts]/segNNN.ts)
//
// Resolution order:
//   1. Server-side cache (/data/clip-cache/<sensor>-<ts>/index.m3u8) — hit → serve.
//   2. Alert-clips bucket manifest → fetch video bytes from manifest.vst_clip_url.
//   3. VST clip endpoint (live) — exact ts, then a recent-window fallback for
//      camera-clock skew (incident NTP outside VST's node-clock timeline).
// On a cache miss the MP4 is transcoded to HLS with ffmpeg and cached; the
// sibling [segment] route then serves the .ts files from the same cache dir.

import { NextResponse } from "next/server";
import { resolveStreamId, buildVstClipUrl, clipWindow } from "@/lib/streams/vst-clip";
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

/**
 * Fetches the alert-clip manifest from the alert-clips S3 bucket.
 * Returns the parsed manifest when the materializer has confirmed this clip,
 * or null when no manifest exists (clip not yet materialized or rolled off).
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
    const text = Buffer.concat(chunks).toString("utf8");
    return JSON.parse(text) as AlertClipManifest;
  } catch {
    return null;
  }
}

/** Fetches raw MP4 bytes from a VST clip URL (s3-confirmed or vst-live).
 *  On failure, pushes a human-readable reason onto `diag` so the 404 the
 *  caller returns can explain *why* playback is unavailable. */
async function fetchMp4FromUrl(
  url: string,
  diag?: string[]
): Promise<Buffer | null> {
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!resp.ok) {
      // VST encodes its reason in the JSON body (e.g. VMSNoDataError —
      // "No valid stream found for given timestamps"); surface it verbatim.
      let body = "";
      try {
        body = (await resp.text()).slice(0, 300).replace(/\s+/g, " ").trim();
      } catch {
        /* body unreadable */
      }
      diag?.push(`HTTP ${resp.status}${body ? ` — ${body}` : ""}`);
      return null;
    }
    const ab = await resp.arrayBuffer();
    return Buffer.from(ab);
  } catch (e) {
    diag?.push(`fetch failed: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/** Resolves, transcodes, caches, and returns the HLS playlist for a clip.
 *  `end` (the incident's chunk end, optional) widens the window, see clipWindow. */
export async function serveClipPlaylist(
  sensor: string,
  ts: string,
  end?: string | null
): Promise<NextResponse> {
  const win = clipWindow(ts, end);
  const span = win.key !== ts;
  const playlistPath = cachePath(sensor, win.key, "index.m3u8");
  // The player resolves segment URIs against the playlist URL, which drops its
  // query; carry `end` so the [segment] route reads the same cache entry.
  const playlist = (): string => {
    const content = fs.readFileSync(playlistPath, "utf8");
    return span
      ? content.replace(/^seg\d+\.ts$/gm, `$&?end=${encodeURIComponent(end ?? "")}`)
      : content;
  };

  // --- Cache hit ---
  if (isCacheFresh(playlistPath, CLIP_CACHE_TTL_MS)) {
    const stat = fs.statSync(playlistPath);
    const ageSeconds = Math.round((Date.now() - stat.mtimeMs) / 1_000);
    return new NextResponse(playlist(), {
      status: 200,
      headers: {
        "Content-Type": "application/vnd.apple.mpegurl",
        "X-Cache": "hit",
        "X-Cache-Age": String(ageSeconds),
        "X-Source": "cache",
        "Cache-Control": "no-store",
      },
    });
  }

  // --- Cache miss — resolve source ---
  const tsRounded = roundTs(ts);
  let mp4Buffer: Buffer | null = null;
  let source: "s3-confirmed" | "vst-live" = "vst-live";
  // Diagnostics accumulated across resolution branches, surfaced in the 404
  // body so the operator learns *why* a clip is missing (no recording, clock
  // skew, sensor name not in VST, …) instead of a bare "not found".
  const diag: string[] = [];
  let resolvedStreamId: string | null = null;

  // Branch 1: manifest exists → the materializer confirmed the clip in VST.
  // Its window is the materializer's own, so an incident span skips it.
  const manifest = span ? null : await fetchManifestFromS3(sensor, tsRounded);
  if (manifest) {
    mp4Buffer = await fetchMp4FromUrl(manifest.vst_clip_url, diag);
    if (mp4Buffer) {
      source = "s3-confirmed";
    }
  } else if (!span) {
    diag.push("no alert-clip manifest in S3");
  }

  // Branch 2: no manifest → fetch the recorded clip from VST storage.
  if (!mp4Buffer) {
    const streamId = await resolveStreamId(sensor);
    resolvedStreamId = streamId;
    if (streamId) {
      mp4Buffer = await fetchMp4FromUrl(buildVstClipUrl(streamId, ts, end), diag);

      // Camera-clock skew: VST records on the node clock (use_sensor_ntp_time
      // off), but an incident's NTP ts comes from the camera clock. When those
      // diverge (unsynced camera, or the synthetic camera-sim whose looped-file
      // timestamps drift off wall-clock), the exact-ts window falls outside
      // VST's recorded timeline and 404s. Incidents stream in near-real-time,
      // so the footage was recorded ~now on the node clock — fall back to the
      // most recent recorded window so the camera's clip still plays. No-op for
      // clock-synced cameras (the exact fetch succeeds).
      if (!mp4Buffer) {
        const recentTs = new Date(Date.now() - 30_000).toISOString();
        mp4Buffer = await fetchMp4FromUrl(buildVstClipUrl(streamId, recentTs), diag);
      }
    } else {
      diag.push(
        `no VST stream resolved for sensor "${sensor}" (name not found / no online sensor)`
      );
    }
  }

  if (!mp4Buffer) {
    return NextResponse.json(
      {
        error: "Clip not found in S3 or VST",
        sensor,
        resolvedStreamId,
        requestedTs: ts,
        window: { start: win.start.toISOString(), end: win.end.toISOString() },
        diagnostics: diag,
      },
      { status: 404 }
    );
  }

  // Write MP4 to a temp file for ffmpeg.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clip-"));
  const tmpMp4 = path.join(tmpDir, "clip.mp4");
  fs.writeFileSync(tmpMp4, mp4Buffer);

  const outDir = ensureCacheDir(sensor, win.key);

  try {
    await transcodeToHls(tmpMp4, outDir);
    const thumbPath = cachePath(sensor, win.key, "thumb.jpg");
    await extractThumbnail(tmpMp4, thumbPath, win.thumbSecs);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  // LRU eviction in background (don't block response).
  setImmediate(evictLru);

  if (!fs.existsSync(playlistPath)) {
    return NextResponse.json(
      { error: "Transcoding produced no output" },
      { status: 500 }
    );
  }

  return new NextResponse(playlist(), {
    status: 200,
    headers: {
      "Content-Type": "application/vnd.apple.mpegurl",
      "X-Cache": "miss",
      "X-Source": source,
      "Cache-Control": "no-store",
    },
  });
}

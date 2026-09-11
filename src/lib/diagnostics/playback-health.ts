import "server-only";
import { CLUSTER } from "@/lib/cluster-refs";

/**
 * Read-side health of VST's storage: can a window VST's own timeline lists be
 * fetched back as a clip?
 *
 * VST builds its unified storage manager once, at process start, and has no
 * re-init path. When that construction fails the recorder keeps writing (the
 * gstmux cloud buffer is a separate path) while every `/storage/file` read
 * returns 500 `VMSInternalError` and the aging thread logs "not initialized"
 * every two seconds — a log line that rotates away within hours. On the
 * showroom (2026-09-10) that state went undated because nothing surfaced it.
 * This probe puts it on the connectivity strip.
 */

export interface TimelineSegment {
  startTime: string;
  endTime: string;
}

export interface PlaybackWindow {
  streamId: string;
  start: string;
  end: string;
}

const RECENT_MS = 10 * 60_000;
const WINDOW_MS = 60_000;
const LEAD_MS = 60_000;
const PROBE_TIMEOUT_MS = 12_000;

/**
 * Pure: pick a window to fetch — the last minute before the lead of the most
 * recently finished-or-live segment, on whichever stream ends most recently,
 * provided that end is within `RECENT_MS` of `nowMs` and the segment is long
 * enough to hold it. Null when nothing recent enough exists.
 */
export function pickPlaybackWindow(
  timelines: Record<string, TimelineSegment[]>,
  nowMs: number,
): PlaybackWindow | null {
  let best: { streamId: string; seg: TimelineSegment; endMs: number } | null = null;
  for (const [streamId, segs] of Object.entries(timelines)) {
    const seg = segs[segs.length - 1];
    if (!seg) continue;
    const endMs = Date.parse(seg.endTime);
    const startMs = Date.parse(seg.startTime);
    if (!Number.isFinite(endMs) || !Number.isFinite(startMs)) continue;
    if (nowMs - endMs > RECENT_MS) continue;
    if (endMs - startMs < LEAD_MS + WINDOW_MS) continue;
    if (!best || endMs > best.endMs) best = { streamId, seg, endMs };
  }
  if (!best) return null;
  const end = best.endMs - LEAD_MS;
  return {
    streamId: best.streamId,
    start: new Date(end - WINDOW_MS).toISOString(),
    end: new Date(end).toISOString(),
  };
}

export type PlaybackVerdict = {
  ok: boolean;
  severity: "ok" | "warn" | "error";
  detail: string;
};

/** Pure: the verdict from the clip fetch's status and error body. */
export function classifyPlayback(status: number, body: string): PlaybackVerdict {
  if (status === 200) return { ok: true, severity: "ok", detail: "a timeline window fetches back as a clip" };
  if (status === 500 && /VMSInternalError/.test(body)) {
    return {
      ok: false,
      severity: "error",
      detail:
        "VST cannot read back a window its own timeline lists (500 VMSInternalError) — " +
        "the storage manager is not initialized; a streamprocessing restart clears it",
    };
  }
  if (status === 404) {
    return {
      ok: false,
      severity: "warn",
      detail: "VST lists a recent window but returns no clip for it (404 VMSNoDataError)",
    };
  }
  return { ok: false, severity: "error", detail: `clip fetch returned HTTP ${status}` };
}

export async function probePlayback(): Promise<PlaybackVerdict> {
  const base = process.env.VST_MS_URL ?? CLUSTER.vst.storageBase;
  const tl = await fetch(`${base}/storage/timelines`, {
    cache: "no-store",
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });
  if (!tl.ok) return { ok: false, severity: "error", detail: `timelines returned HTTP ${tl.status}` };
  const timelines = (await tl.json()) as Record<string, TimelineSegment[]>;
  const win = pickPlaybackWindow(timelines, Date.now());
  if (!win) return { ok: true, severity: "warn", detail: "no recording in the last 10 min to read back" };
  const url =
    `${base}/storage/file/${encodeURIComponent(win.streamId)}` +
    `?startTime=${encodeURIComponent(win.start)}&endTime=${encodeURIComponent(win.end)}&container=mp4&disableAudio=true`;
  const resp = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
  // Only the error body is read; a 200 carries the whole MP4 and is discarded unread.
  const body = resp.status === 200 ? "" : await resp.text().catch(() => "");
  await resp.body?.cancel().catch(() => undefined);
  return classifyPlayback(resp.status, body);
}

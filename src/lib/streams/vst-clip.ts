// Shared VST clip-retrieval helpers used by the clip-serving routes
// (/api/clips/[sensor]/[ts] and /api/clips/preload).
//
// Incidents carry a sensor *name* (e.g. "checkout-1"); the VST clip-download
// API is keyed by stream id. We resolve the name to the active stream id, then
// download the ±5s MP4 from /storage/file/{streamId} on the VST storage base.

import { CLUSTER } from "@/lib/cluster-refs";

/**
 * Resolves the active VST stream id for a sensor *name*.
 * Re-adds leave stale duplicate sensors of the same name, so prefer the one
 * that is online with a recorded timeline. Returns null when none match.
 */
export async function resolveStreamId(sensor: string): Promise<string | null> {
  try {
    const resp = await fetch(CLUSTER.vst.sensorListUrl, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as unknown;
    const list = Array.isArray(data)
      ? data
      : ((data as { sensors?: unknown[]; data?: unknown[] }).sensors ??
         (data as { data?: unknown[] }).data ??
         []);
    const sensors = list as Array<{
      name?: string;
      sensorId?: string;
      state?: string;
      isTimelinePresent?: boolean;
    }>;
    const match =
      sensors.find(
        (s) => s.name === sensor && s.state === "online" && s.isTimelinePresent
      ) ?? sensors.find((s) => s.name === sensor);
    const sid = match?.sensorId;
    if (!sid) return null;

    // Resolve the stream id under this sensor; fall back to the sensor id
    // (on the current build streamId === sensorId for live RTSP sensors).
    try {
      const sr = await fetch(`${CLUSTER.vst.sensorBase}/${sid}/streams`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (sr.ok) {
        const sd = (await sr.json()) as unknown;
        const streams = (
          Array.isArray(sd)
            ? sd
            : ((sd as { streams?: unknown[]; data?: unknown[] }).streams ??
               (sd as { data?: unknown[] }).data ??
               [])
        ) as Array<{ streamId?: string }>;
        if (streams[0]?.streamId) return streams[0].streamId;
      }
    } catch {
      /* fall through to sensorId */
    }
    return sid;
  } catch {
    return null;
  }
}

/**
 * Builds the VST clip-download URL for a stream id, a ±5s window around `ts`.
 * GET /storage/file/{streamId}?startTime=..&endTime=..&container=mp4 returns
 * binary MP4 bytes (verified on the live alerts build).
 */
export function buildVstClipUrl(streamId: string, ts: string): string {
  const base = process.env.VST_MS_URL ?? CLUSTER.vst.storageBase;
  const start = new Date(new Date(ts).getTime() - 5_000).toISOString();
  const end = new Date(new Date(ts).getTime() + 5_000).toISOString();
  return `${base}/storage/file/${encodeURIComponent(streamId)}?startTime=${encodeURIComponent(start)}&endTime=${encodeURIComponent(end)}&container=mp4&disableAudio=true`;
}

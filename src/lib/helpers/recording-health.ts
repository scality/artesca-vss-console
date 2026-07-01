import "server-only";
import { CLUSTER } from "@/lib/cluster-refs";
import type { VstSensor } from "@/lib/helpers/vst";

// Ground-truth recording health. `isTimelinePresent` (the field the REC badge
// used to read) goes stale — a camera can report REC while nothing is being
// written. The only honest answer to "is this camera recording right now" is:
// does VST storage return video for a recent, already-finalized window?
//
// 200 = data exists (recording) · 404 (VMSNoDataError) = no data (not
// recording) · anything else / network error = unknown. Only the status is
// used — the response body is cancelled, so the probe stays cheap regardless
// of clip size. Results are cached per stream for a short TTL so page refreshes
// and diagnostics don't hammer VST.

export type RecordingStatus = "recording" | "not-recording" | "unknown";

const TTL_MS = 45_000;
// A short slice ending ~20s in the past — recent enough to reflect "now",
// old enough that the segment has finalized (a live edge can 404 spuriously).
const LOOKBACK_END_MS = 20_000;
const WINDOW_MS = 3_000;

const cache = new Map<string, { status: RecordingStatus; at: number }>();

function storageBase(): string {
  return process.env.VST_MS_URL ?? CLUSTER.vst.storageBase;
}

/** Probe whether VST has recorded video for `streamId` (the VST UUID, not the
 *  camera name) in a recent finalized window. Cached per stream for TTL_MS. */
export async function probeRecording(streamId: string): Promise<RecordingStatus> {
  if (!streamId) return "unknown";
  const now = Date.now();
  const hit = cache.get(streamId);
  if (hit && now - hit.at < TTL_MS) return hit.status;

  const end = new Date(now - LOOKBACK_END_MS).toISOString();
  const start = new Date(now - LOOKBACK_END_MS - WINDOW_MS).toISOString();
  const url = `${storageBase()}/storage/file/${encodeURIComponent(streamId)}?startTime=${encodeURIComponent(start)}&endTime=${encodeURIComponent(end)}&container=mp4&disableAudio=true`;

  let status: RecordingStatus = "unknown";
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(8_000), cache: "no-store" });
    try {
      await resp.body?.cancel();
    } catch {
      /* body already consumed / no body — ignore */
    }
    status = resp.status === 200 ? "recording" : resp.status === 404 ? "not-recording" : "unknown";
  } catch {
    status = "unknown";
  }
  cache.set(streamId, { status, at: now });
  return status;
}

function streamIdOf(s: VstSensor): string {
  const sid = (s as { streamId?: unknown }).streamId;
  return typeof sid === "string" ? sid : String(sid ?? "");
}

/**
 * Probe recording for the online sensors, keyed by camera NAME (= sensor id).
 * Returns the tri-state the REC badge expects: true = recording, false =
 * online-but-not-recording, undefined = unknown (probe unreachable).
 */
export async function probeRecordingByName(
  sensors: VstSensor[],
): Promise<Map<string, boolean | undefined>> {
  const online = sensors.filter((s) => s.status === "online" && s.name);
  const entries = await Promise.all(
    online.map(async (s) => {
      const st = await probeRecording(streamIdOf(s));
      const val = st === "recording" ? true : st === "not-recording" ? false : undefined;
      return [s.name as string, val] as const;
    }),
  );
  return new Map(entries);
}

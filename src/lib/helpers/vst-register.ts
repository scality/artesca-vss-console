import "server-only";
import { vstAddSensor, vstStartStream, vstListSensors } from "@/lib/helpers/vst";

// Registering a camera with VST is TWO calls, and getting the second one wrong
// is silent:
//
//   1. sensor/add          — metadata. The camera appears "online".
//   2. proxy/stream/add    — arms the recorder. WITHOUT this, or with the wrong
//                            id, the camera is registered and records nothing.
//
// Step 2 is keyed by the sensor's UUID, not its name. Arming by name is
// accepted, creates a proxy stream, and never records; re-registering mints a
// NEW UUID, so arming with a stale one no-ops the same way. Both produced
// "registered but not recording" on the Pyramid showroom with no error surfaced.
//
// Every caller that brings a camera up must use this function, so the pairing
// and the UUID rule live in exactly one place. Callers: the reconcile cluster
// adapter (add / restore / reconcile) and rearmRecording (the /restart action).

export interface RegisterResult {
  ok: boolean;
  /** The sensor's live UUID — what the recording pipeline is keyed by. */
  uuid?: string;
  warnings: string[];
}

/** UUID of a live sensor by name. Needed when sensor/add was idempotent (409)
 *  and so returned no body to read the UUID from. */
export async function resolveSensorUuid(name: string): Promise<string | undefined> {
  // Fully defensive: this runs on the camera bring-up path, so an unreachable
  // (or absent) sensor list must degrade to "no UUID" — never throw and abort
  // a registration that already succeeded.
  try {
    const listed = await vstListSensors();
    const sensors = listed?.sensors ?? [];
    const match = sensors.find((s) => s.sensor_id === name) as
      | { streamId?: unknown; sensor_uuid?: unknown }
      | undefined;
    const val = match?.streamId ?? match?.sensor_uuid;
    return typeof val === "string" && val ? val : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Register a camera with VST and arm its recorder.
 *
 * `ok` reflects the registration; a failure to arm comes back as ok:true with a
 * warning, because the camera is registered and visible — the caller should
 * surface "not recording" rather than claim the whole add failed.
 */
export async function registerSensorAndArm(input: {
  name: string;
  rtspUrl: string;
  description?: string;
}): Promise<RegisterResult> {
  const warnings: string[] = [];

  const add = await vstAddSensor({
    sensorId: input.name,
    rtspUrl: input.rtspUrl,
    description: input.description,
  });
  if (!add.ok) {
    if (add.warning) warnings.push(add.warning);
    return { ok: false, warnings };
  }

  const uuid = add.uuid ?? (await resolveSensorUuid(input.name));
  if (!uuid) {
    warnings.push(
      `${input.name}: VST returned no sensor UUID — recording not armed (camera is registered but will not record)`,
    );
    return { ok: true, warnings };
  }

  const stream = await vstStartStream({ sensorId: uuid, rtspUrl: input.rtspUrl });
  if (!stream.ok && stream.warning) warnings.push(stream.warning);

  return { ok: true, uuid, warnings };
}

/** An RTSP URL may embed credentials (rtsp://user:pass@host/path). Strip the
 *  userinfo before the URL reaches an audit row, a log line or an error sink —
 *  those are read by people who should not receive camera passwords. */
export function redactRtspUrl(url: string | undefined): string | undefined {
  if (!url) return url;
  return url.replace(/^(rtsps?:\/\/)[^/@]*@/i, "$1<redacted>@");
}

import "server-only";
import { vstDeleteSensor, vstAddSensor, vstStartStream } from "@/lib/helpers/vst";

export interface RearmResult {
  ok: boolean;
  warnings: string[];
}

/**
 * Re-arm a VST sensor's recording pipeline: delete the existing registration
 * by its VST UUID, then re-register it with the same name + rtspUrl and start
 * the recording pipeline. This is the same delete-by-UUID + re-add sequence
 * `POST /api/cameras/[id]/restart` has always used (VST keys deletes by the
 * UUID it assigned, not by camera name — a name-keyed delete 404s and leaves
 * the old sensor live, making the re-add collide) — extracted here so the
 * restart route and the recording-recovery reconcile pass share one
 * implementation. Never throws; failures are reported via `ok`/`warnings`.
 */
export async function rearmRecording(
  name: string,
  rtspUrl: string,
  streamId: string,
  description?: string,
): Promise<RearmResult> {
  const warnings: string[] = [];

  const del = await vstDeleteSensor(streamId || name);
  if (!del.ok && del.warning) warnings.push(del.warning);

  const add = await vstAddSensor({ sensorId: name, rtspUrl, description });
  if (!add.ok) {
    if (add.warning) warnings.push(add.warning);
    return { ok: false, warnings };
  }

  const stream = await vstStartStream({ sensorId: name, rtspUrl });
  if (!stream.ok && stream.warning) warnings.push(stream.warning);

  return { ok: true, warnings };
}

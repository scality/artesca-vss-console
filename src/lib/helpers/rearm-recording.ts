import "server-only";
import { vstDeleteSensor } from "@/lib/helpers/vst";
import { registerSensorAndArm } from "@/lib/helpers/vst-register";

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

  const res = await registerSensorAndArm({ name, rtspUrl, description });
  warnings.push(...res.warnings);
  return { ok: res.ok, warnings };
}

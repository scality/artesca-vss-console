import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { vstListSensors } from "@/lib/helpers/vst";
import { gcsCamerasGet, gcsCamerasPut, type CameraList, type CameraEntry } from "@/lib/helpers/gcs-config";

export const dynamic = "force-dynamic";

const VSS_INSTANCE_NAME = process.env.VSS_INSTANCE_NAME ?? "";

// ─── POST /api/cameras/sync-gcs ───────────────────────────────────────────────
//
// Snapshots the current VST sensor list as the new GCS camera definition.
// Used by the "Save all to GCS" button to persist a runtime-only state.

export async function POST() {
  const session = await auth();
  if (!session)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (!VSS_INSTANCE_NAME) {
    return NextResponse.json(
      { error: "VSS_INSTANCE_NAME is not set — cannot write to GCS" },
      { status: 400 },
    );
  }

  const { sensors, warning } = await vstListSensors();

  if (sensors.length === 0 && warning) {
    return NextResponse.json(
      { error: `VST unreachable: ${warning}` },
      { status: 502 },
    );
  }

  // Pull the existing GCS doc first so per-camera v2 overrides
  // (scenarioIds, recording) survive a full sync from VST sensors.
  let existingByCameraId = new Map<string, CameraEntry>();
  try {
    const existing = await gcsCamerasGet(VSS_INSTANCE_NAME);
    if (existing) {
      existingByCameraId = new Map(existing.cameras.map((c) => [c.id, c]));
    }
  } catch {
    // No existing doc or read failed — proceed with fresh write.
  }

  const cameras: CameraEntry[] = sensors.map((s) => {
    const existing = existingByCameraId.get(s.sensor_id);
    return {
      id: s.sensor_id,
      rtspUrl: typeof s.rtsp_url === "string" ? s.rtsp_url : "",
      description: typeof s.name === "string" ? s.name : undefined,
      // Preserve operator-set v2 overrides across a full re-sync.
      ...(existing?.scenarioIds != null && { scenarioIds: existing.scenarioIds }),
      ...(existing?.recording != null && { recording: existing.recording }),
    };
  });

  const list: CameraList = {
    schema: "isv-labs.cameras.v2",
    instance: VSS_INSTANCE_NAME,
    updatedAt: new Date().toISOString(),
    updatedBy: session.user?.email ?? "console",
    cameras,
  };

  process.env.UPDATED_BY = list.updatedBy;

  try {
    await gcsCamerasPut(list);
  } catch (err) {
    return NextResponse.json(
      { error: `GCS write failed: ${err instanceof Error ? err.message : String(err)}` },
      { status: 502 },
    );
  }

  return NextResponse.json({
    ok: true,
    instance: VSS_INSTANCE_NAME,
    synced: cameras.length,
    warnings: warning ? [warning] : [],
  });
}

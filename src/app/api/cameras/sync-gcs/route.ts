import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { vstListSensors } from "@/lib/helpers/vst";
import { gcsCamerasPut, type CameraList, type CameraEntry } from "@/lib/helpers/gcs-config";

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

  const cameras: CameraEntry[] = sensors.map((s) => ({
    id: s.sensor_id,
    rtspUrl: typeof s.rtsp_url === "string" ? s.rtsp_url : "",
    description: typeof s.name === "string" ? s.name : undefined,
  }));

  const list: CameraList = {
    schema: "isv-labs.cameras.v1",
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

import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { withRequestContext } from "@/lib/with-request-context";
import { auditLog } from "@/lib/helpers/audit";
import {
  vstListSensors,
  vstAddSensor,
  vstDeleteSensor,
  setRecording,
} from "@/lib/helpers/vst";
import {
  camsimListCameras,
  camsimDeleteCamera,
  camsimAddCamera,
  controlPlaneHost,
} from "@/lib/helpers/camsim-control";
import { gcsCamerasGet, type CameraEntry } from "@/lib/helpers/gcs-config";

export const dynamic = "force-dynamic";

const DOCKER_MODE = process.env.CONSOLE_RUNTIME === "docker";
const VSS_INSTANCE_NAME = process.env.VSS_INSTANCE_NAME ?? "";

// ─── POST — restart a camera's ingest ─────────────────────────────────────────
//
// A camera is defined by its RTSP URL — a synthetic camera-sim stream and a
// real IP camera are treated identically. "Restart" bounces VST ingest for
// that stream: unregister the sensor, then re-register it with its stored
// RTSP URL. This works for any camera and needs no CAMERA_SIM_HOST.
//
// Bouncing the camera-sim publisher (which regenerates the synthetic RTSP
// loop) is a best-effort side-effect applied only when the source IS our
// simulator and its control-plane is reachable — its absence degrades to a
// warning, never a failure.

/** Read the stored camera definition from the authoritative config store. */
async function readStoredCamera(id: string): Promise<CameraEntry | undefined> {
  if (!DOCKER_MODE) {
    const { makeReconcileContext } = await import("@/lib/reconcile/context");
    const ctx = await makeReconcileContext();
    return (await ctx.store.readCameras(ctx.instance)).find((c) => c.id === id);
  }
  if (VSS_INSTANCE_NAME) {
    const list = await gcsCamerasGet(VSS_INSTANCE_NAME);
    return list?.cameras.find((c) => c.id === id);
  }
  return undefined;
}

export const POST = withRequestContext(async function (
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const warnings: string[] = [];

  // Resolve the camera definition (rtspUrl + recording) from the config store.
  let stored: CameraEntry | undefined;
  try {
    stored = await readStoredCamera(id);
  } catch (err) {
    warnings.push(
      `config store read failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Resolve the RTSP URL: stored definition → live VST sensor → constructed
  // from CAMERA_SIM_HOST (last resort, sim-only).
  let rtspUrl = stored?.rtspUrl?.trim() || "";
  if (!rtspUrl) {
    const live = await vstListSensors();
    const sensor = live.sensors.find((s) => s.sensor_id === id);
    if (sensor && typeof sensor.rtsp_url === "string") rtspUrl = sensor.rtsp_url;
  }
  if (!rtspUrl) {
    const camsimHost = process.env.CAMERA_SIM_HOST;
    if (camsimHost && !camsimHost.startsWith("<")) {
      rtspUrl = `rtsp://${camsimHost}:8554/${id}`;
    }
  }
  if (!rtspUrl) {
    return NextResponse.json(
      { error: `No RTSP URL known for camera '${id}' — cannot restart ingest.` },
      { status: 400 },
    );
  }

  // Primary action: bounce VST ingest (unregister → re-register).
  const del = await vstDeleteSensor(id);
  if (!del.ok && del.warning) warnings.push(del.warning);
  const add = await vstAddSensor({ sensorId: id, rtspUrl, description: stored?.description });
  if (!add.ok && add.warning) warnings.push(add.warning);
  if (!add.ok) {
    return NextResponse.json(
      { error: `VST re-registration failed for '${id}'`, warnings },
      { status: 502 },
    );
  }

  // Re-arm recording if the stored policy had it enabled (no-op on the k8s
  // path where proxyStreamAddUrl is empty).
  if (stored?.recording?.enabled) {
    const rec = await setRecording(id, true, rtspUrl);
    if (!rec.ok && rec.warning) warnings.push(rec.warning);
  }

  // Best-effort: bounce the camera-sim publisher when this camera's source is
  // our simulator and the control-plane is reachable. Failures are warnings.
  let camsimHost = "";
  try {
    camsimHost = controlPlaneHost();
  } catch {
    // No control-plane configured — nothing to bounce. Not an error here.
  }
  if (camsimHost) {
    try {
      const simCameras = await camsimListCameras();
      const simEntry = simCameras.find((c) => c.name === id);
      if (simEntry) {
        await camsimDeleteCamera(id);
        await camsimAddCamera({
          name: id,
          source: simEntry.source,
          description: simEntry.description,
        });
      }
    } catch (err) {
      warnings.push(
        `camera-sim publisher bounce skipped: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  await auditLog("camera-restart", `camera/${id}`, { rtspUrl });

  return NextResponse.json({ ok: true, cameraId: id, warnings });
});

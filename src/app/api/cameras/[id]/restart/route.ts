import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { withRequestContext } from "@/lib/with-request-context";
import { auditLog } from "@/lib/helpers/audit";
import { vstListSensors } from "@/lib/helpers/vst";
import { rearmRecording } from "@/lib/helpers/rearm-recording";
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

  // Find the live VST sensor for this camera. VST keys deletes by the UUID it
  // assigned (`sensorId`), not by our camera name, and reports the source host
  // it's pulling from as `sensorIp`. Pick the active registration (a camera may
  // have stale "removed" entries lingering in the list).
  const live = await vstListSensors();
  const matches = live.sensors.filter((s) => s.sensor_id === id);
  const active =
    matches.find((s) => s.status === "online") ??
    matches.find((s) => s.isTimelinePresent) ??
    matches[0];

  // Resolve the RTSP URL from the camera's own definition. NEVER construct it
  // from host+id: the source publishes arbitrary path names (e.g. the pyramid
  // camera-sim serves aisle-1 as `gcp-aisle-1-h264`), so a `rtsp://<host>/<id>`
  // guess silently registers a dead stream. Priority: config store (Firestore
  // on k8s, GCS on docker) → GCS camera doc (holds the real URLs even when the
  // Firestore entry doesn't) → the live VST sensor's explicit URL.
  let rtspUrl = stored?.rtspUrl?.trim() || "";
  if (!rtspUrl && VSS_INSTANCE_NAME) {
    try {
      const doc = await gcsCamerasGet(VSS_INSTANCE_NAME);
      rtspUrl = doc?.cameras.find((c) => c.id === id)?.rtspUrl?.trim() || "";
    } catch (err) {
      warnings.push(
        `GCS camera lookup failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  if (!rtspUrl && active?.rtsp_url) rtspUrl = active.rtsp_url;
  if (!rtspUrl) {
    return NextResponse.json(
      {
        error: `No RTSP URL known for camera '${id}' — cannot restart ingest. The camera has no rtspUrl in the config store or GCS camera list.`,
      },
      { status: 400 },
    );
  }

  // Primary action: bounce VST ingest (unregister → re-register + start the
  // recording pipeline). Delete by the UUID sensorId (a name-keyed delete
  // 404s and leaves the old sensor live, making the re-add collide).
  const uuid = active?.streamId != null ? String(active.streamId) : "";
  const rearm = await rearmRecording(id, rtspUrl, uuid || id, stored?.description);
  warnings.push(...rearm.warnings);
  if (!rearm.ok) {
    return NextResponse.json(
      { error: `VST re-registration failed for '${id}'`, warnings },
      { status: 502 },
    );
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

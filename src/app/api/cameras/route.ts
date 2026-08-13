import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { z } from "zod";
import { rejectIfKiosk } from "@/lib/kiosk-server";
import { createLogger } from "@/lib/logger";
import { withRequestContext } from "@/lib/with-request-context";

const log = createLogger("api/cameras");
import { vstListSensors } from "@/lib/helpers/vst";
import { mediamtxListPaths } from "@/lib/helpers/mediamtx";
import { auditLog } from "@/lib/helpers/audit";
import type { Camera, Feed } from "@/lib/types";
import {
  camsimListCameras,
  camsimAddCamera,
  camsimUploadFile,
  controlPlaneHost,
  CamsimControlError,
} from "@/lib/helpers/camsim-control";
import {
  gcsCamerasGet,
  gcsCamerasPut,
  gcsHealthCheck,
  type CameraEntry,
  type CameraList,
} from "@/lib/helpers/gcs-config";
import { listCameraOverrides } from "@/lib/db";
import { redactRtspUrl } from "@/lib/helpers/vst-register";

// The camera-sim's control-plane API (http://<camera-sim>:8080) is the
// authoritative source for cameras.yaml — it owns the YAML, triggers the
// restart, and its POST /cameras is idempotent. VST registration status
// and mediamtx "is the stream actually flowing" status are best-effort
// enrichment layered on top.
//
// GCS provides cross-restart persistence: cameras/<instance>.json is the
// authoritative definition list; VST is the runtime registration view.

export const dynamic = "force-dynamic";

const VSS_INSTANCE_NAME = process.env.VSS_INSTANCE_NAME ?? "";

// Simple mutex for GCS writes — prevents concurrent PUT races from simultaneous
// requests (add + another add racing, etc.).
let _gcsWriteChain: Promise<void> = Promise.resolve();

function chainGcsWrite(fn: () => Promise<void>): Promise<void> {
  _gcsWriteChain = _gcsWriteChain.then(fn).catch((err) => log.error("gcs-write failed", { err }));
  return _gcsWriteChain;
}

// ─── GET — unified camera list ─────────────────────────────────────────────────

export async function GET() {
  const session = await auth();
  if (!session)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { makeReconcileContext, ReconcileContextError } = await import("@/lib/reconcile/context");
  const { buildK8sCamerasResponse } = await import("@/lib/cameras/collect-k8s");
  const { listIngestingCameras } = await import("@/lib/helpers/ingestion");
  const { probeRecordingByName } = await import("@/lib/helpers/recording-health");
  const { getRecoveryStates } = await import("@/lib/reconcile/recording-recovery");
  try {
    const ctx = await makeReconcileContext();
    const [desired, vstResult, mtxResult, status, ingestResult] = await Promise.all([
      ctx.store.readCameras(ctx.instance),
      vstListSensors(),
      mediamtxListPaths().catch(() => ({ paths: [] as { name: string; ready: boolean }[], warning: undefined })),
      ctx.store.readStatus(ctx.instance).catch(() => null),
      listIngestingCameras().catch(() => ({ ingesting: new Set<string>(), warning: undefined })),
    ]);
    const warnings: string[] = [];
    if (vstResult.warning) warnings.push(vstResult.warning);
    if (mtxResult.warning) warnings.push(mtxResult.warning);
    if (ingestResult.warning) warnings.push(ingestResult.warning);
    const liveNames = vstResult.sensors.map((s) => s.sensor_id);
    const mtxReady = new Map(mtxResult.paths.map((p) => [p.name, p.ready]));
    // Recording status keyed by camera id (= VST sensor name). Ground truth,
    // not isTimelinePresent (which goes stale): probe VST storage for a recent
    // finalized window. true = recording, false = not, undefined = unknown.
    const recordingByName = await probeRecordingByName(vstResult.sensors);
    // VLM ingestion: cameras with an active realtime alert rule. Pass the set
    // only when the alert-bridge was reachable, so an outage reads "unknown"
    // (undefined) rather than falsely "not ingesting" for every camera.
    const ingestingNames = ingestResult.warning ? undefined : ingestResult.ingesting;
    // Guarded auto-heal state from the reconcile loop's recording-recovery
    // pass — pure in-memory read, no I/O.
    const recoveryByName = getRecoveryStates();
    const { cameras, reconcile } = buildK8sCamerasResponse(desired, liveNames, mtxReady, status, recordingByName, ingestingNames, recoveryByName);
    return NextResponse.json({ cameras, eip: "", gcs: { available: false }, reconcile, warnings });
  } catch (err) {
    const msg = err instanceof ReconcileContextError ? err.message : String(err);
    return NextResponse.json(
      { cameras: [], eip: "", gcs: { available: false }, warnings: [`config store unavailable: ${msg}`] },
      { status: 200 },
    );
  }
}

// ─── POST — add a new camera ───────────────────────────────────────────────────

const AddFeedSchema = z.object({
  feedId: z.string().optional(),
  fileName: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.(ts|mp4|mkv|mov)$/),
  fileBase64: z.string().min(1),
});

const AddCameraSchema = z
  .object({
    cameraId: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/),
    role: z.string().optional(),
    description: z.string().optional(),
    rtspUrl: z.string().optional(),
    feeds: z.array(AddFeedSchema).optional(),
  })
  // Two ways to add a camera, and a real deployment needs both:
  //   feeds[]  — upload footage to the camera-sim, which publishes it as RTSP.
  //   rtspUrl  — a camera that already speaks RTSP (an IP camera on the store
  //              LAN, or an existing sim stream). Requires no camera-sim at all.
  // The showroom has no camera-sim host, so demanding feeds[] made Add Camera
  // unusable there — its four real cameras had to be registered out-of-band.
  .refine((v) => (v.feeds?.length ?? 0) > 0 || !!v.rtspUrl?.trim(), {
    message: "Provide either an uploaded feed or an rtspUrl",
    path: ["rtspUrl"],
  })
  .refine((v) => !v.rtspUrl?.trim() || /^rtsps?:\/\/\S+$/.test(v.rtspUrl.trim()), {
    message: "rtspUrl must be an rtsp:// or rtsps:// URL",
    path: ["rtspUrl"],
  });

export const POST = withRequestContext(async (req: NextRequest) => {
  const session = await auth();
  if (!session)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const blocked = await rejectIfKiosk();
  if (blocked) return blocked;

  const body = await req.json().catch(() => null);
  const parsed = AddCameraSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const { cameraId, role, description } = parsed.data;
  const feeds = parsed.data.feeds ?? [];
  const warnings: string[] = [];

  // Direct-RTSP mode: nothing to upload and no camera-sim involved. Steps 1
  // and 2 are skipped entirely rather than attempted-and-tolerated, so a
  // deployment without a camera-sim never sees a spurious control-plane error.
  const primary = feeds[0];
  const directRtsp = !primary;

  if (feeds.length > 1) {
    warnings.push(
      `Only the first feed is used — cluster schema is one source file per camera (dropped: ${feeds
        .slice(1)
        .map((f) => f.fileName)
        .join(", ")})`,
    );
  }

  if (!directRtsp) {
    // 1. Upload the source file to /opt/camera-sim/data/ via the control-plane.
    try {
      const buf = Buffer.from(primary.fileBase64, "base64");
      await camsimUploadFile(primary.fileName, buf);
    } catch (err) {
      const status = err instanceof CamsimControlError ? err.status : 502;
      return NextResponse.json(
        { error: `Upload failed: ${err instanceof Error ? err.message : String(err)}` },
        { status },
      );
    }

    // 2. Register with the camera-sim control-plane (rewrites cameras.yaml +
    //    mediamtx.yml, restarts the stack).
    try {
      await camsimAddCamera({
        name: cameraId,
        source: primary.fileName,
        description,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const status = err instanceof CamsimControlError ? err.status : 502;
      return NextResponse.json(
        { error: `Control-plane add failed: ${msg}` },
        { status },
      );
    }
  }

  const { makeReconcileContext, ReconcileContextError } = await import("@/lib/reconcile/context");
  const { reconcileCameras } = await import("@/lib/reconcile/cameras");
  const entry = {
    id: cameraId,
    rtspUrl: parsed.data.rtspUrl ?? "",
    ...(role ? { role } : {}),
    ...(description ? { description } : {}),
  };
  try {
    const ctx = await makeReconcileContext();
    await ctx.store.upsertCamera(ctx.instance, entry, session.user?.email ?? "console");
    const result = await reconcileCameras([entry], ctx.adapter, { prune: false });
    result.failed.forEach((f) => warnings.push(`apply ${f.id}: ${f.warning ?? "failed"}`));
  } catch (err) {
    const msg = err instanceof ReconcileContextError ? err.message : String(err);
    warnings.push(`config store write failed (camera created on camera-sim): ${msg}`);
  }
  await auditLog("camera-add", `camera/${cameraId}`, {
    cameraId,
    source: directRtsp ? redactRtspUrl(parsed.data.rtspUrl) : primary.fileName,
  });
  return NextResponse.json({ ok: true, cameraId, warnings });
});

// ─── GCS write helper (shared by POST and [id]/route DELETE) ──────────────────

/**
 * Read the current GCS list, apply a mutation, and write back.
 * Uses the in-process chain mutex to avoid concurrent write races.
 * Returns an error warning string, or undefined on success.
 */
async function writeToGcs(
  cameraId: string,
  entry: CameraEntry | null, // null = delete
  updatedBy: string,
  op: "add" | "remove",
): Promise<string | undefined> {
  let warning: string | undefined;
  await chainGcsWrite(async () => {
    try {
      const current = await gcsCamerasGet(VSS_INSTANCE_NAME);
      const existingCameras: CameraEntry[] = current?.cameras ?? [];

      let nextCameras: CameraEntry[];
      if (op === "add" && entry !== null) {
        // Replace if already present (idempotent), otherwise append.
        const existing = existingCameras.findIndex((c) => c.id === cameraId);
        if (existing >= 0) {
          nextCameras = [
            ...existingCameras.slice(0, existing),
            entry,
            ...existingCameras.slice(existing + 1),
          ];
        } else {
          nextCameras = [...existingCameras, entry];
        }
      } else {
        nextCameras = existingCameras.filter((c) => c.id !== cameraId);
      }

      const list: CameraList = {
        schema: "isv-labs.cameras.v2",
        instance: VSS_INSTANCE_NAME,
        updatedAt: new Date().toISOString(),
        updatedBy,
        cameras: nextCameras,
      };

      process.env.UPDATED_BY = updatedBy;
      await gcsCamerasPut(list);
    } catch (err) {
      warning = `GCS ${op} failed (VST change already applied): ${
        err instanceof Error ? err.message : String(err)
      }`;
      log.warn("gcs write failed", { err, op });
    }
  });
  return warning;
}

// ─── Export for use by [id]/route.ts ──────────────────────────────────────────
export { writeToGcs };
export type { CameraEntry };

import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { z } from "zod";
import { createLogger } from "@/lib/logger";
import { withRequestContext } from "@/lib/with-request-context";

const log = createLogger("api/cameras/[id]");
import { vstDeleteSensor, setRecording } from "@/lib/helpers/vst";
import { setIngestion } from "@/lib/helpers/ingestion";
import { auditLog } from "@/lib/helpers/audit";
import {
  camsimListCameras,
  camsimDeleteCamera,
  camsimAddCamera,
  camsimUploadFile,
  camsimDeleteFile,
  CamsimControlError,
} from "@/lib/helpers/camsim-control";
import {
  upsertCameraOverride,
  getCameraOverride,
  deleteCameraOverride,
  listCameraOverrides,
  type CameraOverrideRow,
} from "@/lib/db";
import {
  gcsCamerasGet,
  gcsCamerasPut,
  type CameraList,
  type CameraEntry,
} from "@/lib/helpers/gcs-config";
import { writeToGcs } from "../route";

export const dynamic = "force-dynamic";

const VSS_INSTANCE_NAME = process.env.VSS_INSTANCE_NAME ?? "";

/**
 * Read a camera's authoritative definition from the config store — Firestore
 * from the config store. Independent of the camera-sim
 * control-plane: a camera is defined by its RTSP URL, not by the simulator.
 */
async function readStoredCameraEntry(id: string): Promise<CameraEntry | undefined> {
  const { makeReconcileContext } = await import("@/lib/reconcile/context");
  const ctx = await makeReconcileContext();
  return (await ctx.store.readCameras(ctx.instance)).find((c) => c.id === id);
}

// ─── GET — single camera overrides ────────────────────────────────────────────

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;

  // k8s path: read overrides from Firestore camera doc.
  const { makeReconcileContext } = await import("@/lib/reconcile/context");
  try {
    const ctx = await makeReconcileContext();
    const cam = (await ctx.store.readCameras(ctx.instance)).find((c) => c.id === id);
    const override = cam
      ? {
          cameraId: id,
          scenarioIds: cam.scenarioIds ?? null,
          recordingEnabled: cam.recording?.enabled ?? null,
          recordingPolicy: cam.recording?.policy ?? null,
          recordingRetentionDays: cam.recording?.retentionDays ?? null,
          updatedAt: "",
          updatedBy: "",
        }
      : null;
    return NextResponse.json({ cameraId: id, override });
  } catch {
    return NextResponse.json({ cameraId: id, override: null });
  }
}

// ─── PUT — upsert per-camera scenario bindings + recording policy ─────────────

const PutCameraOverrideSchema = z.object({
  /** undefined = remove override entirely. null = same effect. */
  scenarioIds: z.array(z.string()).nullable().optional(),
  recording: z
    .object({
      enabled: z.boolean(),
      policy: z.enum(["always", "event-only", "off"]),
      retentionDays: z.number().int().positive(),
    })
    .nullable()
    .optional(),
  /** Bound detection prompt-set id. null = remove the binding. */
  promptId: z.string().nullable().optional(),
  /** VLM ingestion on/off — creates/deletes the camera's realtime alert rule
   *  (incident generation). Independent of recording. */
  ingestion: z.object({ enabled: z.boolean() }).optional(),
});

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const body = await req.json().catch(() => null);
  const parsed = PutCameraOverrideSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const { scenarioIds, recording, promptId, ingestion } = parsed.data;
  const updatedBy = session.user?.email ?? "console";

  // k8s path: merge overrides into the Firestore camera doc.
  // Placed ABOVE the docker clear-block so k8s always takes this branch.
  // Semantics: undefined field = leave unchanged; null = remove the field.
  const { makeReconcileContext, ReconcileContextError } = await import("@/lib/reconcile/context");
  try {
    const ctx = await makeReconcileContext();
    const existing = (await ctx.store.readCameras(ctx.instance)).find((c) => c.id === id);
    if (!existing) {
      return NextResponse.json({ error: `Camera '${id}' not found in config store` }, { status: 404 });
    }
    const next = { ...existing };
    if (scenarioIds !== undefined) {
      if (scenarioIds === null) delete next.scenarioIds; else next.scenarioIds = scenarioIds;
    }
    if (promptId !== undefined) {
      if (promptId === null) delete next.promptId; else next.promptId = promptId;
    }
    if (recording !== undefined) {
      if (recording === null) delete next.recording; else next.recording = recording;
    }
    await ctx.store.upsertCamera(ctx.instance, next, updatedBy);

    // Apply the recording on/off change to the VST so recording actually
    // stops/starts (not just the persisted policy). Best-effort: a VST
    // warning is surfaced but does not fail the config-store write.
    const warnings: string[] = [];
    if (recording !== undefined && recording !== null) {
      const vst = await setRecording(id, recording.enabled, existing.rtspUrl);
      if (!vst.ok && vst.warning) warnings.push(vst.warning);
    }

    // Apply the VLM ingestion on/off change to the alert-bridge so the
    // realtime rule (incident generation) is actually created/deleted.
    if (ingestion !== undefined) {
      const ing = await setIngestion(id, ingestion.enabled, existing.rtspUrl);
      if (!ing.ok && ing.warning) warnings.push(ing.warning);
    }

    await auditLog("camera-override-update", `camera/${id}`, { scenarioIds, promptId, recording, ingestion });
    return NextResponse.json({ ok: true, cameraId: id, ...(warnings.length ? { warnings } : {}) });
  } catch (err) {
    const msg = err instanceof ReconcileContextError ? err.message : String(err);
    return NextResponse.json({ error: `config store write failed: ${msg}` }, { status: 502 });
  }
}

/**
 * Read the current GCS camera list, apply all SQLite overrides, and write back
 * as v2.  Best-effort — errors are returned as a warning string.
 */
async function pushOverridesToGcs(updatedBy: string): Promise<string | undefined> {
  try {
    const current = await gcsCamerasGet(VSS_INSTANCE_NAME);
    if (!current) return undefined; // No GCS list yet — nothing to enrich.

    const allOverrides = listCameraOverrides();
    const overrideMap = new Map(allOverrides.map((o) => [o.cameraId, o]));

    const cameras: CameraEntry[] = current.cameras.map((cam) => {
      const ov = overrideMap.get(cam.id);
      if (!ov) return cam;
      const enriched: CameraEntry = { ...cam };
      if (ov.scenarioIds !== null) enriched.scenarioIds = ov.scenarioIds;
      if (
        ov.recordingEnabled !== null &&
        ov.recordingPolicy !== null &&
        ov.recordingRetentionDays !== null
      ) {
        enriched.recording = {
          enabled: ov.recordingEnabled,
          policy: ov.recordingPolicy,
          retentionDays: ov.recordingRetentionDays,
        };
      }
      return enriched;
    });

    const list: CameraList = {
      schema: "isv-labs.cameras.v2",
      instance: VSS_INSTANCE_NAME,
      updatedAt: new Date().toISOString(),
      updatedBy,
      cameras,
    };
    process.env.UPDATED_BY = updatedBy;
    await gcsCamerasPut(list);
    return undefined;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn("GCS v2 push failed", { err });
    return `GCS push failed (SQLite saved): ${msg}`;
  }
}

// ─── PATCH — update a camera ──────────────────────────────────────────────────
//
// The control-plane has no PATCH endpoint (by design — cameras.yaml entries
// are immutable except for add + delete). "Updating" a camera = DELETE the
// existing entry + ADD it back with the new source/description. Both calls
// restart the stack; we wrap them so the operator sees a single UI action.

const PatchFeedSchema = z.object({
  feedId: z.string().optional(),
  fileName: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.(ts|mp4|mkv|mov)$/)
    .optional(),
  fileBase64: z.string().optional(),
});

const PatchCameraSchema = z.object({
  role: z.string().optional(),
  description: z.string().optional(),
  feeds: z.array(PatchFeedSchema).min(1).optional(),
});

export const PATCH = withRequestContext(async function (
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const body = await req.json().catch(() => null);
  const parsed = PatchCameraSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const update = parsed.data;
  const warnings: string[] = [];

  // The config store (Firestore/GCS) is authoritative for a camera's
  // definition. The camera-sim entry is consulted only for its synthetic
  // source file — a camera defined by RTSP URL alone need not exist there.
  let stored: CameraEntry | undefined;
  try {
    stored = await readStoredCameraEntry(id);
  } catch (err) {
    warnings.push(
      `config store read failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let simEntry: Awaited<ReturnType<typeof camsimListCameras>>[number] | undefined;
  try {
    simEntry = (await camsimListCameras()).find((c) => c.name === id);
  } catch {
    // Control-plane unreachable — the sim republish below is skipped.
  }

  if (!stored && !simEntry) {
    return NextResponse.json({ error: `Camera '${id}' not found` }, { status: 404 });
  }

  const feed = update.feeds?.[0];
  const newSource = feed?.fileName ?? simEntry?.source;
  const newDescription =
    update.description ?? stored?.description ?? simEntry?.description;

  // Upload a replacement synthetic source file if supplied — best-effort
  // (only meaningful for camera-sim streams; failure must not block the edit).
  if (feed?.fileName && feed.fileBase64) {
    try {
      const buf = Buffer.from(feed.fileBase64, "base64");
      await camsimUploadFile(feed.fileName, buf);
    } catch (err) {
      warnings.push(
        `source upload skipped: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Bounce the camera-sim publisher (delete + re-add) when this is a sim
  // stream and the control-plane is reachable — best-effort side-effect.
  if (simEntry && newSource) {
    try {
      await camsimDeleteCamera(id);
      await camsimAddCamera({
        name: id,
        source: newSource,
        description: newDescription,
      });
    } catch (err) {
      warnings.push(
        `camera-sim update skipped: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // k8s path: upsert the updated entry to Firestore + apply to cluster.
  const { makeReconcileContext, ReconcileContextError } = await import("@/lib/reconcile/context");
  const { reconcileCameras } = await import("@/lib/reconcile/cameras");
  const rtspBase = process.env.CAMERA_SIM_HOST ? `rtsp://${process.env.CAMERA_SIM_HOST}:8554/${id}` : "";
  const entry = { id, rtspUrl: rtspBase, ...(update.role ? { role: update.role } : {}), ...(newDescription ? { description: newDescription } : {}) };
  try {
    const ctx = await makeReconcileContext();
    const existing = (await ctx.store.readCameras(ctx.instance)).find((c) => c.id === id);
    const merged = {
      ...entry,
      ...(existing?.scenarioIds ? { scenarioIds: existing.scenarioIds } : {}),
      ...(existing?.recording ? { recording: existing.recording } : {}),
      ...(existing?.rtspUrl && !rtspBase ? { rtspUrl: existing.rtspUrl } : {}),
    };
    await ctx.store.upsertCamera(ctx.instance, merged, session.user?.email ?? "console");
    const result = await reconcileCameras([merged], ctx.adapter, { prune: false });
    result.failed.forEach((f) => warnings.push(`apply ${f.id}: ${f.warning ?? "failed"}`));
  } catch (err) {
    const msg = err instanceof ReconcileContextError ? err.message : String(err);
    warnings.push(`config store update failed (camera-sim already updated): ${msg}`);
  }

  await auditLog("camera-update", `camera/${id}`, { update });

  return NextResponse.json({ ok: true, cameraId: id, warnings });
});

// ─── DELETE — unregister a camera ─────────────────────────────────────────────

export const DELETE = withRequestContext(async function (
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const warnings: string[] = [];

  // Look up the source file BEFORE delete so we can remove it from /data/.
  let sourceFile: string | undefined;
  try {
    const entries = await camsimListCameras();
    sourceFile = entries.find((c) => c.name === id)?.source;
  } catch (err) {
    // Can't list cameras? Delete will fail next anyway.
    warnings.push(err instanceof Error ? err.message : String(err));
  }

  // 1. Remove from the camera-sim publisher (cameras.yaml + mediamtx.yml) —
  //    best-effort. Only relevant when the source is our simulator; a camera
  //    defined solely by its RTSP URL has nothing here. Failure must not block
  //    the authoritative VST + config-store removal below.
  try {
    await camsimDeleteCamera(id);
  } catch (err) {
    warnings.push(
      `camera-sim delete skipped: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // 2. Unregister from VST (best-effort — a stale VST sensor is harmless).
  const vstDel = await vstDeleteSensor(id);
  if (!vstDel.ok && vstDel.warning) warnings.push(vstDel.warning);

  // 3. Delete the .ts file via control-plane (best-effort — leaving it is
  //    harmless, just consumes disk).
  if (sourceFile) {
    try {
      await camsimDeleteFile(sourceFile);
    } catch (err) {
      if (!(err instanceof CamsimControlError && err.status === 404)) {
        warnings.push(
          `rm ${sourceFile} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  // 4. Persist removal to the config store.
  const instanceName = process.env.VSS_INSTANCE_NAME ?? "";
  const { makeReconcileContext, ReconcileContextError } = await import("@/lib/reconcile/context");
  try {
    const ctx = await makeReconcileContext();
    await ctx.store.deleteCamera(ctx.instance, id, session.user?.email ?? "console");
  } catch (err) {
    const msg = err instanceof ReconcileContextError ? err.message : String(err);
    warnings.push(`config store delete failed (camera removed from camera-sim): ${msg}`);
  }

  await auditLog("camera-delete", `camera/${id}`, {
    cameraId: id,
    source: sourceFile,
  });

  return NextResponse.json({ ok: true, cameraId: id, warnings });
});

import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { z } from "zod";
import { createLogger } from "@/lib/logger";
import { withRequestContext } from "@/lib/with-request-context";

const log = createLogger("api/cameras/[id]");
import { vstDeleteSensor } from "@/lib/helpers/vst";
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

// ─── GET — single camera overrides ────────────────────────────────────────────

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const override = getCameraOverride(id);
  return NextResponse.json({ cameraId: id, override });
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

  const { scenarioIds, recording } = parsed.data;
  const updatedBy = session.user?.email ?? "console";

  // k8s path: merge overrides into the Firestore camera doc.
  // Placed ABOVE the docker clear-block so k8s always takes this branch.
  // Semantics: undefined field = leave unchanged; null = remove the field.
  const DOCKER_MODE = process.env.CONSOLE_RUNTIME === "docker";
  if (!DOCKER_MODE) {
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
      if (recording !== undefined) {
        if (recording === null) delete next.recording; else next.recording = recording;
      }
      await ctx.store.upsertCamera(ctx.instance, next, updatedBy);
      await auditLog("camera-override-update", `camera/${id}`, { scenarioIds, recording });
      return NextResponse.json({ ok: true, cameraId: id });
    } catch (err) {
      const msg = err instanceof ReconcileContextError ? err.message : String(err);
      return NextResponse.json({ error: `config store write failed: ${msg}` }, { status: 502 });
    }
  }

  // docker path below: SQLite + GCS.

  // If both fields are absent/null, treat as clearing the override entirely.
  if (scenarioIds === undefined && recording === undefined) {
    deleteCameraOverride(id);
    await auditLog("camera-override-clear", `camera/${id}`, {});
    return NextResponse.json({ ok: true, cameraId: id, cleared: true });
  }

  const overrideRow: CameraOverrideRow = {
    cameraId: id,
    scenarioIds: scenarioIds ?? null,
    recordingEnabled: recording?.enabled ?? null,
    recordingPolicy: recording?.policy ?? null,
    recordingRetentionDays: recording?.retentionDays ?? null,
    updatedAt: new Date().toISOString(),
    updatedBy,
  };
  upsertCameraOverride(overrideRow);

  await auditLog("camera-override-update", `camera/${id}`, {
    scenarioIds,
    recording,
  });

  // Persist overrides to GCS as v2 (best-effort — SQLite write already done).
  const gcsWarning = VSS_INSTANCE_NAME
    ? await pushOverridesToGcs(updatedBy)
    : undefined;

  return NextResponse.json({
    ok: true,
    cameraId: id,
    ...(gcsWarning ? { gcsWarning } : {}),
  });
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

  // Read current state from control-plane.
  let current: Awaited<ReturnType<typeof camsimListCameras>>[number] | undefined;
  try {
    const all = await camsimListCameras();
    current = all.find((c) => c.name === id);
  } catch (err) {
    const status = err instanceof CamsimControlError ? err.status : 502;
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status },
    );
  }
  if (!current) {
    return NextResponse.json(
      { error: `Camera '${id}' not found on camera-sim` },
      { status: 404 },
    );
  }

  const feed = update.feeds?.[0];
  const newSource = feed?.fileName ?? current.source;
  const newDescription = update.description ?? current.description;

  // Upload replacement file if one was supplied (control-plane HTTP, no SSH).
  if (feed?.fileName && feed.fileBase64) {
    try {
      const buf = Buffer.from(feed.fileBase64, "base64");
      await camsimUploadFile(feed.fileName, buf);
    } catch (err) {
      const status = err instanceof CamsimControlError ? err.status : 502;
      return NextResponse.json(
        { error: `Upload failed: ${err instanceof Error ? err.message : String(err)}` },
        { status },
      );
    }
  }

  // Replace the entry atomically: delete then re-add. Two stack restarts
  // worst-case (~20s) — acceptable for a rarely-used operation.
  try {
    await camsimDeleteCamera(id);
    await camsimAddCamera({
      name: id,
      source: newSource,
      description: newDescription,
    });
  } catch (err) {
    const status = err instanceof CamsimControlError ? err.status : 502;
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status },
    );
  }

  // k8s path: upsert the updated entry to Firestore + apply to cluster.
  if (process.env.CONSOLE_RUNTIME !== "docker") {
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

  // 1. Remove from cameras.yaml + mediamtx.yml via control-plane.
  try {
    await camsimDeleteCamera(id);
  } catch (err) {
    const status = err instanceof CamsimControlError ? err.status : 502;
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status },
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

  // 4. Persist removal: Firestore (k8s) or GCS (docker).
  const DOCKER_MODE = process.env.CONSOLE_RUNTIME === "docker";
  const instanceName = process.env.VSS_INSTANCE_NAME ?? "";
  if (!DOCKER_MODE) {
    const { makeReconcileContext, ReconcileContextError } = await import("@/lib/reconcile/context");
    try {
      const ctx = await makeReconcileContext();
      await ctx.store.deleteCamera(ctx.instance, id, session.user?.email ?? "console");
    } catch (err) {
      const msg = err instanceof ReconcileContextError ? err.message : String(err);
      warnings.push(`config store delete failed (camera removed from camera-sim): ${msg}`);
    }
  } else if (instanceName) {
    const email = session?.user?.email ?? "console";
    const gcsWarning = await writeToGcs(id, null, email, "remove");
    if (gcsWarning) warnings.push(gcsWarning);
  }

  await auditLog("camera-delete", `camera/${id}`, {
    cameraId: id,
    source: sourceFile,
  });

  return NextResponse.json({ ok: true, cameraId: id, warnings });
});

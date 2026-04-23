import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { z } from "zod";
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

export const dynamic = "force-dynamic";

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

export async function PATCH(
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

  await auditLog("camera-update", `camera/${id}`, { update });

  return NextResponse.json({ ok: true, cameraId: id, warnings });
}

// ─── DELETE — unregister a camera ─────────────────────────────────────────────

export async function DELETE(
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

  await auditLog("camera-delete", `camera/${id}`, {
    cameraId: id,
    source: sourceFile,
  });

  return NextResponse.json({ ok: true, cameraId: id, warnings });
}

import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { withRequestContext } from "@/lib/with-request-context";
import { auditLog } from "@/lib/helpers/audit";
import {
  camsimListCameras,
  camsimDeleteCamera,
  camsimAddCamera,
  CamsimControlError,
} from "@/lib/helpers/camsim-control";

export const dynamic = "force-dynamic";

// ─── POST — restart a camera's RTSP replay ────────────────────────────────────
//
// The camera-sim control-plane has no "restart" verb. Bouncing a single
// camera's replay loop = DELETE the entry + ADD it back with the SAME source
// and description. The control-plane rewrites mediamtx.yml and restarts the
// stack on each call, which re-establishes the ffmpeg publisher for the feed.
// Unlike PATCH, nothing about the camera changes — this is purely a recovery
// action for a stalled/looping feed.

export const POST = withRequestContext(async function (
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;

  // Read current state so we re-add the entry verbatim.
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

  // Delete then re-add with identical source/description.
  try {
    await camsimDeleteCamera(id);
    await camsimAddCamera({
      name: id,
      source: current.source,
      description: current.description,
    });
  } catch (err) {
    const status = err instanceof CamsimControlError ? err.status : 502;
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status },
    );
  }

  await auditLog("camera-restart", `camera/${id}`, { source: current.source });

  return NextResponse.json({ ok: true, cameraId: id });
});

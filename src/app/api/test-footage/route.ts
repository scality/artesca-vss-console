import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { rejectIfKiosk } from "@/lib/kiosk-server";
import { withRequestContext } from "@/lib/with-request-context";
import { auditLog } from "@/lib/helpers/audit";
import {
  FootageError,
  MAX_UPLOAD_BYTES,
  deleteFootage,
  listFootage,
  sanitiseFilename,
  saveFootage,
} from "@/lib/test-footage";
import { listAlertProfiles, listRuns, pausedSensors } from "@/lib/test-footage-run";

export const dynamic = "force-dynamic";

// GET  — uploaded files + which of them are currently running
// POST — stream a video upload onto the footage volume
// DELETE ?name=<file> — remove one

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const [files, runs, alertProfiles, paused] = await Promise.all([
    listFootage().catch(() => []),
    listRuns().catch(() => []),
    listAlertProfiles().catch(() => []),
    pausedSensors().catch(() => []),
  ]);
  return NextResponse.json({
    files,
    runs,
    alertProfiles,
    // Non-empty with no run registered = an abandoned run left the live cameras
    // paused. The panel surfaces this as a repair prompt.
    pausedSensors: paused,
    maxUploadBytes: MAX_UPLOAD_BYTES,
  });
}

export const POST = withRequestContext(async (req: NextRequest) => {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const blocked = await rejectIfKiosk();
  if (blocked) return blocked;

  // The filename rides in a header rather than a multipart body: the body is
  // then the raw video, which streams straight to disk. Parsing multipart would
  // mean buffering a multi-hundred-MB file in a 1 Gi pod.
  const rawName = req.headers.get("x-footage-filename");
  if (!rawName) {
    return NextResponse.json(
      { error: "missing x-footage-filename header" },
      { status: 400 },
    );
  }
  if (!req.body) {
    return NextResponse.json({ error: "empty request body" }, { status: 400 });
  }

  try {
    const name = sanitiseFilename(rawName);
    const declared = Number(req.headers.get("content-length") ?? "") || undefined;
    const file = await saveFootage(name, req.body, declared);
    await auditLog("test-footage-upload", `footage/${name}`, {
      name,
      sizeBytes: file.sizeBytes,
    });
    return NextResponse.json({ ok: true, file });
  } catch (err) {
    if (err instanceof FootageError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return NextResponse.json(
      { error: `upload failed: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 },
    );
  }
});

export const DELETE = withRequestContext(async (req: NextRequest) => {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const blocked = await rejectIfKiosk();
  if (blocked) return blocked;

  const name = new URL(req.url).searchParams.get("name");
  if (!name) return NextResponse.json({ error: "missing ?name" }, { status: 400 });

  try {
    await deleteFootage(name);
    await auditLog("test-footage-delete", `footage/${name}`, { name });
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof FootageError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
});

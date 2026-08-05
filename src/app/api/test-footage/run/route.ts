import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { rejectIfKiosk } from "@/lib/kiosk-server";
import { withRequestContext } from "@/lib/with-request-context";
import { auditLog } from "@/lib/helpers/audit";
import { FootageError } from "@/lib/test-footage";
import { startRun, stopRun } from "@/lib/test-footage-run";

export const dynamic = "force-dynamic";

// POST   — start a run (register the file as a camera, enable VLM analysis)
// DELETE — stop a run and resume whichever live cameras it paused

const StartSchema = z.object({
  fileName: z.string().min(1),
  mode: z.enum(["loop", "once"]),
  /** Pause the live cameras' analysis so the GPU is dedicated to this run. */
  pauseLive: z.boolean(),
  /** Scenario the clip is judged against — the alert_type + prompt handed to
   *  the VLM. Omitted → the generic "anything notable" default. */
  alertType: z.string().min(1).optional(),
  prompt: z.string().min(1).optional(),
});

export const POST = withRequestContext(async (req: NextRequest) => {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const blocked = await rejectIfKiosk();
  if (blocked) return blocked;

  const parsed = StartSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  try {
    const res = await startRun(parsed.data);
    await auditLog("test-footage-run-start", `footage/${parsed.data.fileName}`, {
      ...parsed.data,
      cameraId: res.cameraId,
      alertType: res.alertType,
      pausedCameras: res.pausedCameras,
    });
    return NextResponse.json({ ok: true, ...res });
  } catch (err) {
    if (err instanceof FootageError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
});

const StopSchema = z.object({
  /** Omit to stop every test-footage camera (cleanup after an abandoned run). */
  cameraId: z.string().optional(),
  /** Live cameras to re-enable — echoed back from the start response. */
  resume: z.array(z.string()).default([]),
});

export const DELETE = withRequestContext(async (req: NextRequest) => {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const blocked = await rejectIfKiosk();
  if (blocked) return blocked;

  const parsed = StopSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const res = await stopRun(parsed.data);
  await auditLog("test-footage-run-stop", `footage/${parsed.data.cameraId ?? "all"}`, { ...res });
  return NextResponse.json({ ok: true, ...res });
});

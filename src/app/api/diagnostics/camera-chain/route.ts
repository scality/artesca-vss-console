import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { collectCameraChains, type DesiredCamera, type ScenarioBinding } from "@/lib/diagnostics/camera-chain";

export const dynamic = "force-dynamic";

// Per-camera "why isn't this working" diagnosis, plus the shared object-storage
// preflight. Backs the reason text on /cameras: the badges say WHAT the state
// is, this says WHY and what to do. Also useful as a pre-demo canary — a
// non-empty `unhealthy` means something will not produce incidents-with-video.

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const warnings: string[] = [];
  let desired: DesiredCamera[] = [];
  let scenarios: ScenarioBinding[] = [];

  const { makeReconcileContext } = await import("@/lib/reconcile/context");
  try {
    const ctx = await makeReconcileContext();
    const [cams, scens] = await Promise.all([
      ctx.store.readCameras(ctx.instance),
      ctx.store.readScenarios(ctx.instance),
    ]);
    desired = cams.map((c) => ({ id: c.id, rtspUrl: c.rtspUrl }));
    scenarios = scens.map((s) => ({
      id: s.id,
      enabled: s.enabled !== false,
      sensorFilter: s.sensor_filter ?? "",
    }));
  } catch (err) {
    // No desired list = nothing to diagnose against. Report it rather than
    // rendering an empty, falsely-clean page.
    return NextResponse.json(
      {
        error: `config store unavailable: ${err instanceof Error ? err.message : String(err)}`,
      },
      { status: 503 },
    );
  }

  const report = await collectCameraChains({ desired, scenarios });
  const unhealthy = report.cameras.filter((c) => c.verdict).map((c) => c.cameraId);

  return NextResponse.json({
    ...report,
    warnings: [...warnings, ...report.warnings],
    ok: unhealthy.length === 0 && report.storage.state === "ok",
    unhealthy,
  });
}

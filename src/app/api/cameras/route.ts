import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { z } from "zod";
import { vstListSensors } from "@/lib/helpers/vst";
import { mediamtxListPaths } from "@/lib/helpers/mediamtx";
import { auditLog } from "@/lib/helpers/audit";
import { sshScp } from "@/lib/ssh";
import type { Camera, Feed } from "@/lib/types";
import {
  camsimListCameras,
  camsimAddCamera,
  controlPlaneHost,
  CamsimControlError,
} from "@/lib/helpers/camsim-control";

// The camera-sim's control-plane API (http://<camera-sim>:8080) is the
// authoritative source for cameras.yaml — it owns the YAML, triggers the
// restart, and its POST /cameras is idempotent. VST registration status
// and mediamtx "is the stream actually flowing" status are best-effort
// enrichment layered on top.
//
// Old orchestration (SCP + patch ConfigMap "cameras" in pyramid-ingress +
// ssh systemctl restart + create register-cameras Job) is gone. The k8s
// ConfigMap approach couldn't tell whether the camera-sim had actually
// picked up the change — now we know because the control-plane returns
// the restart exit code inline.

export const dynamic = "force-dynamic";

// ─── GET — unified camera list ─────────────────────────────────────────────────

export async function GET() {
  const session = await auth();
  if (!session)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const warnings: string[] = [];

  let eip = "";
  try {
    eip = controlPlaneHost();
  } catch (err) {
    return NextResponse.json(
      {
        cameras: [],
        eip: "",
        warnings: [
          err instanceof Error ? err.message : String(err),
          "Set CAMERA_SIM_HOST in the console-env ConfigMap and rollout restart deploy/console.",
        ],
      },
      { status: 200 },
    );
  }

  let entries: Awaited<ReturnType<typeof camsimListCameras>> = [];
  try {
    entries = await camsimListCameras();
  } catch (err) {
    const msg =
      err instanceof CamsimControlError ? err.message : String(err);
    warnings.push(msg);
  }

  const [vstResult, mtxResult] = await Promise.all([
    vstListSensors(),
    mediamtxListPaths(),
  ]);
  if (vstResult.warning) warnings.push(vstResult.warning);
  if (mtxResult.warning) warnings.push(mtxResult.warning);
  const vstRegistered = new Set(vstResult.sensors.map((s) => s.sensor_id));
  const mtxReady = new Map(mtxResult.paths.map((p) => [p.name, p.ready]));

  const cameras: Camera[] = entries.map((e) => {
    const feed: Feed = {
      id: "default",
      sensorId: e.name,
      source: e.source,
      rtspUrl: `rtsp://${eip}:8554/${e.name}`,
      vstRegistered: vstRegistered.has(e.name),
      replayReady: mtxReady.get(e.name) ?? false,
    };
    return {
      id: e.name,
      role: "other",
      description: e.description,
      feeds: [feed],
    };
  });

  return NextResponse.json({ cameras, eip, warnings });
}

// ─── POST — add a new camera ───────────────────────────────────────────────────
//
// Expected body (from AddCameraDialog):
//   {
//     cameraId: "checkout-1",
//     role: "checkout",
//     description: "...",
//     feeds: [{ feedId: "default", fileName: "clip.ts", fileBase64: "..." }]
//   }
//
// Real cluster schema allows exactly one source file per camera; if the
// dialog submits multiple feeds we use feeds[0] and warn about the rest.

const AddFeedSchema = z.object({
  feedId: z.string().optional(),
  fileName: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.(ts|mp4|mkv|mov)$/),
  fileBase64: z.string().min(1),
});

const AddCameraSchema = z.object({
  cameraId: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/),
  role: z.string().optional(),
  description: z.string().optional(),
  feeds: z.array(AddFeedSchema).min(1),
});

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => null);
  const parsed = AddCameraSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const operator = session.user?.name ?? session.user?.email ?? "unknown";
  const { cameraId, description, feeds } = parsed.data;
  const warnings: string[] = [];

  const primary = feeds[0];
  if (feeds.length > 1) {
    warnings.push(
      `Only the first feed is used — cluster schema is one source file per camera (dropped: ${feeds
        .slice(1)
        .map((f) => f.fileName)
        .join(", ")})`,
    );
  }

  // 1. SCP the source file to /opt/camera-sim/data/.
  try {
    const buf = Buffer.from(primary.fileBase64, "base64");
    await sshScp(buf, `/opt/camera-sim/data/${primary.fileName}`, operator);
  } catch (err) {
    return NextResponse.json(
      { error: `SCP failed: ${String(err)}` },
      { status: 502 },
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
    const status =
      err instanceof CamsimControlError ? err.status : 502;
    return NextResponse.json(
      {
        error: `Control-plane add failed: ${msg}`,
      },
      { status },
    );
  }

  await auditLog("camera-add", `camera/${cameraId}`, {
    cameraId,
    source: primary.fileName,
  });

  return NextResponse.json({
    ok: true,
    cameraId,
    warnings,
  });
}

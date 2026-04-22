import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { z } from "zod";
import { vstListSensors } from "@/lib/helpers/vst";
import { mediamtxListPaths } from "@/lib/helpers/mediamtx";
import { patchConfigMapKey, readConfigMapKey } from "@/lib/helpers/configmaps";
import { auditLog } from "@/lib/helpers/audit";
import { sshScp, sshExec } from "@/lib/ssh";
import { batchV1 } from "@/lib/k8s";
import { CLUSTER } from "@/lib/cluster-refs";
import type { Camera, Feed } from "@/lib/types";
import { CameraSchema, FeedSchema } from "@/lib/schemas";

// Real cameras.yaml schema (k8s/pyramid-ingress/11-configmap-cameras.yaml):
//   cameras:
//     - name: checkout-1          ← maps to Camera.id
//       source: euroshop.ts       ← maps to Feed.source (single feed per camera)
//       description: "..."
//
// The console UI model has cameras with multiple feeds; the real cluster has
// one source-file per camera entry.  We bridge by treating each camera entry
// as a single-feed camera where feed.id = "default" and feed.source = entry.source.
type RealCameraEntry = {
  name: string;
  source: string;
  description?: string;
};

export const dynamic = "force-dynamic";

// ─── GET — unified camera list ─────────────────────────────────────────────────

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const warnings: string[] = [];

  const [vstResult, mtxResult] = await Promise.all([
    vstListSensors(),
    mediamtxListPaths(),
  ]);

  if (vstResult.warning) warnings.push(vstResult.warning);
  if (mtxResult.warning) warnings.push(mtxResult.warning);

  // Build a map of sensorId → vst registered
  const vstRegisteredIds = new Set(vstResult.sensors.map((s) => s.sensor_id));

  // Build a map of pathName → ready from mediamtx
  const mtxReadyMap = new Map(mtxResult.paths.map((p) => [p.name, p.ready]));

  // Read "cameras" ConfigMap (k8s/pyramid-ingress/11-configmap-cameras.yaml).
  // Schema: each entry has name (=sensor id), source (=.ts file), description.
  let cameras: Camera[] = [];

  try {
    const { value: configData } = await readConfigMapKey<{ cameras?: RealCameraEntry[] }>(
      CLUSTER.cameras.namespace,
      CLUSTER.cameras.configMap,
      CLUSTER.cameras.yamlKey
    );

    const cameraDefs = configData?.cameras ?? [];
    const eip = process.env.CAMERA_SIM_HOST ?? "camera-sim-host";

    cameras = cameraDefs.map((cam): Camera => {
      // Each entry is a single-feed camera.  sensorId = cam.name.
      const sensorId = cam.name;
      const feed: Feed = {
        id: "default",
        sensorId,
        source: cam.source,
        rtspUrl: `rtsp://${eip}:8554/${sensorId}`,
        vstRegistered: vstRegisteredIds.has(sensorId),
        replayReady: mtxReadyMap.get(sensorId) ?? false,
      };
      return {
        id: cam.name,
        role: "other",
        description: cam.description,
        feeds: [feed],
      };
    });
  } catch {
    warnings.push("cameras ConfigMap unreadable — deriving from VST + mediamtx");

    // Fallback: group VST sensors by camera prefix
    const cameraMap = new Map<string, Camera>();
    const eip = process.env.CAMERA_SIM_HOST ?? "camera-sim-host";

    for (const sensor of vstResult.sensors) {
      const sensorId = sensor.sensor_id;
      const parts = sensorId.split("-");
      if (parts.length < 2) continue;
      const feedId = parts[parts.length - 1];
      const cameraId = parts.slice(0, -1).join("-");

      if (!cameraMap.has(cameraId)) {
        cameraMap.set(cameraId, {
          id: cameraId,
          role: "other",
          feeds: [],
        });
      }

      const camera = cameraMap.get(cameraId)!;
      const feed: Feed = {
        id: feedId,
        sensorId,
        source: `${sensorId}.ts`,
        rtspUrl: `rtsp://${eip}:8554/${sensorId}`,
        vstRegistered: true,
        replayReady: mtxReadyMap.get(sensorId) ?? false,
      };
      camera.feeds.push(feed);
    }

    cameras = Array.from(cameraMap.values());
  }

  return NextResponse.json({ cameras, warnings });
}

// ─── POST — add a new camera ───────────────────────────────────────────────────

const AddFeedSchema = FeedSchema.omit({ vstRegistered: true, replayReady: true }).extend({
  fileBase64: z.string().min(1), // base64-encoded .ts file content
});

const AddCameraSchema = CameraSchema.omit({ feeds: true }).extend({
  feeds: z.array(AddFeedSchema).min(1),
});

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => null);
  const parsed = AddCameraSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Validation failed", issues: parsed.error.issues }, { status: 400 });
  }

  const operator = session.user?.name ?? session.user?.email ?? "unknown";
  const camera = parsed.data;
  const warnings: string[] = [];

  // 1. SCP .ts files to camera-sim
  for (const feed of camera.feeds) {
    const buf = Buffer.from(feed.fileBase64, "base64");
    const remotePath = `/opt/camera-sim/data/${feed.source}`;
    try {
      await sshScp(buf, remotePath, operator);
    } catch (err) {
      return NextResponse.json(
        { error: `SCP failed for feed ${feed.id}: ${String(err)}` },
        { status: 502 }
      );
    }
  }

  // 2. Patch ConfigMap "cameras" with real schema (name + source + description).
  // Use first feed's source file — the cluster schema has one source per camera.
  const ifMatch = req.headers.get("If-Match") ?? undefined;
  try {
    const { value: existing, resourceVersion } = await readConfigMapKey<{ cameras?: RealCameraEntry[] }>(
      CLUSTER.cameras.namespace,
      CLUSTER.cameras.configMap,
      CLUSTER.cameras.yamlKey
    );

    const existingCameras = existing?.cameras ?? [];
    const newEntry: RealCameraEntry = {
      name: camera.id,
      source: camera.feeds[0].source,
      ...(camera.description ? { description: camera.description } : {}),
    };
    existingCameras.push(newEntry);

    await patchConfigMapKey(
      CLUSTER.cameras.namespace,
      CLUSTER.cameras.configMap,
      CLUSTER.cameras.yamlKey,
      { cameras: existingCameras },
      ifMatch ?? resourceVersion
    );
  } catch (err: unknown) {
    const k8sErr = err as { statusCode?: number; body?: { message?: string } };
    if (k8sErr.statusCode === 409) {
      return NextResponse.json(
        { error: "Config modified by another operator — reload and retry" },
        { status: 409 }
      );
    }
    return NextResponse.json(
      { error: `ConfigMap patch failed: ${String(err)}` },
      { status: 502 }
    );
  }

  // 3. Restart camera-sim
  try {
    await sshExec("sudo systemctl restart camera-sim");
  } catch (err) {
    warnings.push(`camera-sim restart failed: ${String(err)}`);
  }

  // 4. Create register-cameras Job (template name: "register-cameras" per k8s/pyramid-ingress/30-register-job.yaml)
  const jobName = `register-cameras-${Date.now()}`;
  try {
    const existingJob = await batchV1().listNamespacedJob({ namespace: CLUSTER.cameras.namespace });
    const templateJob = existingJob.items.find((j) => j.metadata?.name?.startsWith(CLUSTER.cameras.registerJobPrefix));

    if (templateJob?.spec?.template) {
      await batchV1().createNamespacedJob({
        namespace: CLUSTER.cameras.namespace,
        body: {
          apiVersion: "batch/v1",
          kind: "Job",
          metadata: { name: jobName, namespace: CLUSTER.cameras.namespace },
          spec: {
            ...templateJob.spec,
            template: templateJob.spec.template,
          },
        },
      });
    } else {
      warnings.push("register-cameras Job template not found — skipping re-registration");
    }
  } catch (err) {
    warnings.push(`register-cameras Job creation failed: ${String(err)}`);
  }

  // 5. Audit log
  await auditLog("camera-add", `camera/${camera.id}`, {
    cameraId: camera.id,
    feeds: camera.feeds.map((f) => f.id),
    jobName,
  });

  return NextResponse.json({ ok: true, cameraId: camera.id, jobName, warnings });
}

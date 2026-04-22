import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { z } from "zod";
import { vstDeleteSensor } from "@/lib/helpers/vst";
import { patchConfigMapKey, readConfigMapKey } from "@/lib/helpers/configmaps";
import { auditLog } from "@/lib/helpers/audit";
import { sshScp, sshExec } from "@/lib/ssh";
import { FeedSchema } from "@/lib/schemas";
import { CLUSTER } from "@/lib/cluster-refs";

export const dynamic = "force-dynamic";

// Real schema from k8s/pyramid-ingress/11-configmap-cameras.yaml.
// Each camera entry has: name (=sensor id), source (.ts file), optional description.
type CameraConfigEntry = {
  name: string;
  source: string;
  description?: string;
};

type CamerasConfig = { cameras?: CameraConfigEntry[] };

// ─── PATCH — update a camera ───────────────────────────────────────────────────

const PatchFeedSchema = FeedSchema.omit({ vstRegistered: true, replayReady: true }).extend({
  fileBase64: z.string().optional(), // optional — only upload if changed
});

const PatchCameraSchema = z.object({
  role: z.enum(["checkout", "aisle", "dock", "backroom", "other"]).optional(),
  description: z.string().optional(),
  feeds: z.array(PatchFeedSchema).min(1).optional(),
});

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const body = await req.json().catch(() => null);
  const parsed = PatchCameraSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Validation failed", issues: parsed.error.issues }, { status: 400 });
  }

  const operator = session.user?.name ?? session.user?.email ?? "unknown";
  const update = parsed.data;
  const warnings: string[] = [];

  // SCP changed feeds only
  if (update.feeds) {
    for (const feed of update.feeds) {
      if (feed.fileBase64) {
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
    }
  }

  // Patch "cameras" ConfigMap using real schema (name + source + description).
  const ifMatch = req.headers.get("If-Match") ?? undefined;
  try {
    const { value: existing, resourceVersion } = await readConfigMapKey<CamerasConfig>(
      CLUSTER.cameras.namespace,
      CLUSTER.cameras.configMap,
      CLUSTER.cameras.yamlKey
    );

    const cameras = existing?.cameras ?? [];
    const idx = cameras.findIndex((c) => c.name === id);
    if (idx === -1) {
      return NextResponse.json({ error: `Camera ${id} not found in ConfigMap` }, { status: 404 });
    }

    // role is not stored in real schema — description and source can be updated
    if (update.description !== undefined) cameras[idx].description = update.description;
    if (update.feeds && update.feeds.length > 0) {
      cameras[idx].source = update.feeds[0].source;
    }

    await patchConfigMapKey(
      CLUSTER.cameras.namespace,
      CLUSTER.cameras.configMap,
      CLUSTER.cameras.yamlKey,
      { cameras },
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

  // Restart camera-sim
  try {
    await sshExec("sudo systemctl restart camera-sim");
  } catch (err) {
    warnings.push(`camera-sim restart failed: ${String(err)}`);
  }

  await auditLog("camera-update", `camera/${id}`, { update });

  return NextResponse.json({ ok: true, cameraId: id, warnings });
}

// ─── DELETE — unregister a camera ─────────────────────────────────────────────

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const warnings: string[] = [];

  // 1. Read "cameras" ConfigMap using real schema to discover sensor id and source file.
  // Each camera entry: name = sensor id, source = .ts file (single source per camera).
  let feedIds: string[] = [];
  let feedSources: string[] = [];
  const ifMatch = req.headers.get("If-Match") ?? undefined;

  try {
    const { value: existing, resourceVersion } = await readConfigMapKey<CamerasConfig>(
      CLUSTER.cameras.namespace,
      CLUSTER.cameras.configMap,
      CLUSTER.cameras.yamlKey
    );

    const cameras = existing?.cameras ?? [];
    const cam = cameras.find((c) => c.name === id);
    if (!cam) {
      return NextResponse.json({ error: `Camera ${id} not found` }, { status: 404 });
    }

    // sensor id = camera name; single source file per camera in real schema
    feedIds = [cam.name];
    feedSources = [cam.source];

    const updated = cameras.filter((c) => c.name !== id);
    await patchConfigMapKey(
      CLUSTER.cameras.namespace,
      CLUSTER.cameras.configMap,
      CLUSTER.cameras.yamlKey,
      { cameras: updated },
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

  // 2. Unregister from VST
  for (const sensorId of feedIds) {
    const { ok, warning } = await vstDeleteSensor(sensorId);
    if (!ok && warning) warnings.push(warning);
  }

  // 3. Remove .ts files from camera-sim via SSH
  for (const source of feedSources) {
    try {
      await sshExec(`rm -f /opt/camera-sim/data/${source}`);
    } catch (err) {
      warnings.push(`rm ${source} failed: ${String(err)}`);
    }
  }

  // 4. Restart camera-sim
  try {
    await sshExec("sudo systemctl restart camera-sim");
  } catch (err) {
    warnings.push(`camera-sim restart failed: ${String(err)}`);
  }

  await auditLog("camera-delete", `camera/${id}`, { feedIds, feedSources });

  return NextResponse.json({ ok: true, cameraId: id, warnings });
}

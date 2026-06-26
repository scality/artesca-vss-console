// GET/PATCH /api/tuning/sampling
//
// VLM frame sampling for the realtime-alert path. These knobs live on the
// alert-bridge rules (per-query), sourced from the `realtime-alert-rules`
// ConfigMap that the vlm-stream-reconciler converges from — NOT a NIM env.
//
// GET  reads the desired sampling from the ConfigMap's rules.json top-level.
// PATCH writes the new sampling into rules.json, then deletes the live rules so
//       the reconciler re-seeds them from the updated ConfigMap (~15s). Single
//       writer (the reconciler), so no duplicate rules.

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { CLUSTER } from "@/lib/cluster-refs";
import { readConfigMapKey, patchConfigMapRawKey } from "@/lib/helpers/configmaps";
import { listRealtimeRules, deleteRealtimeRule } from "@/lib/helpers/alert-bridge";
import { auditLog } from "@/lib/helpers/audit";
import { withRequestContext } from "@/lib/with-request-context";
import { rejectIfKiosk } from "@/lib/kiosk-server";
import { extractK8sError } from "@/lib/errors";

export const dynamic = "force-dynamic";

const RULES_KEY = "rules.json";

const DEFAULTS = {
  framesPerChunk: 6,
  useFps: false,
  chunkDuration: 30,
} as const;

const SamplingSchema = z.object({
  // alert-bridge types this as an integer; fps mode treats it as frames/sec,
  // fixed mode as frames-per-chunk.
  framesPerChunk: z.number().int().min(1).max(30),
  useFps: z.boolean(),
  chunkDuration: z.number().int().min(5).max(120),
});

interface RulesDoc {
  num_frames_per_second_or_fixed_frames_chunk?: number;
  use_fps_for_chunking?: boolean;
  chunk_duration?: number;
  [k: string]: unknown;
}

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const { value } = await readConfigMapKey<RulesDoc>(
      CLUSTER.alertBridge.rulesNamespace,
      CLUSTER.alertBridge.rulesConfigMap,
      RULES_KEY,
    );
    return NextResponse.json({
      framesPerChunk:
        typeof value?.num_frames_per_second_or_fixed_frames_chunk === "number"
          ? value.num_frames_per_second_or_fixed_frames_chunk
          : DEFAULTS.framesPerChunk,
      useFps:
        typeof value?.use_fps_for_chunking === "boolean"
          ? value.use_fps_for_chunking
          : DEFAULTS.useFps,
      chunkDuration:
        typeof value?.chunk_duration === "number"
          ? value.chunk_duration
          : DEFAULTS.chunkDuration,
    });
  } catch (err: unknown) {
    const { status } = extractK8sError(err);
    // ConfigMap absent → report defaults rather than erroring the page.
    if (status === 404) return NextResponse.json({ ...DEFAULTS, warning: "rules ConfigMap not found — showing defaults" });
    const { message } = extractK8sError(err);
    return NextResponse.json({ error: message }, { status });
  }
}

export const PATCH = withRequestContext(async function (req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const blocked = await rejectIfKiosk();
  if (blocked) return blocked;

  const body = await req.json().catch(() => null);
  const parsed = SamplingSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Validation failed", issues: parsed.error.issues }, { status: 400 });
  }
  const { framesPerChunk, useFps, chunkDuration } = parsed.data;

  const ns = CLUSTER.alertBridge.rulesNamespace;
  const cm = CLUSTER.alertBridge.rulesConfigMap;

  // ── Step 1: patch rules.json top-level sampling in the ConfigMap ───────────
  let doc: RulesDoc;
  let resourceVersion: string | undefined;
  try {
    const read = await readConfigMapKey<RulesDoc>(ns, cm, RULES_KEY);
    doc = read.value && typeof read.value === "object" ? read.value : ({} as RulesDoc);
    resourceVersion = read.resourceVersion;
  } catch (err: unknown) {
    const { status, message } = extractK8sError(err);
    return NextResponse.json({ error: `read rules ConfigMap failed: ${message}`, k8sCode: status }, { status });
  }

  doc.num_frames_per_second_or_fixed_frames_chunk = framesPerChunk;
  doc.use_fps_for_chunking = useFps;
  doc.chunk_duration = chunkDuration;

  try {
    await patchConfigMapRawKey(ns, cm, RULES_KEY, JSON.stringify(doc, null, 2), resourceVersion);
  } catch (err: unknown) {
    const { status, message } = extractK8sError(err);
    return NextResponse.json({ error: `patch rules ConfigMap failed: ${message}`, k8sCode: status }, { status });
  }

  // ── Step 2: delete live rules → reconciler re-seeds from the updated CM ────
  const { rules, warning } = await listRealtimeRules();
  let deleted = 0;
  const delWarnings: string[] = [];
  for (const r of rules) {
    const res = await deleteRealtimeRule(r.id);
    if (res.ok) deleted += 1;
    else if (res.warning) delWarnings.push(res.warning);
  }

  await auditLog("tuning-sampling", `configmap/${cm}`, {
    patches: {
      num_frames_per_second_or_fixed_frames_chunk: String(framesPerChunk),
      use_fps_for_chunking: String(useFps),
      chunk_duration: String(chunkDuration),
    },
    rulesDeleted: String(deleted),
  });

  return NextResponse.json({
    ok: true,
    applied: { framesPerChunk, useFps, chunkDuration },
    rulesDeleted: deleted,
    note: "Sampling written to the rules ConfigMap; the vlm-stream-reconciler re-seeds the rules from it within ~15s. No VLM restart.",
    ...(warning || delWarnings.length ? { warnings: [warning, ...delWarnings].filter(Boolean) } : {}),
  });
});

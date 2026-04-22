import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { z } from "zod";
import { loadProfile, saveProfile, getDb } from "@/lib/db";
import { DemoProfileSchema } from "@/lib/schemas";
import { auditLog } from "@/lib/helpers/audit";
import { patchConfigMapKey, patchConfigMapRawKey, readConfigMapKey } from "@/lib/helpers/configmaps";
import { rolloutRestart } from "@/lib/k8s";
import { sshExec } from "@/lib/ssh";
import type { Scenario } from "@/lib/types";

export const dynamic = "force-dynamic";

// ─── GET — load a profile ─────────────────────────────────────────────────────

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ name: string }> }
) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { name } = await params;
  const profile = loadProfile(name);

  if (!profile) {
    return NextResponse.json({ error: `Profile "${name}" not found` }, { status: 404 });
  }

  return NextResponse.json({ profile });
}

// ─── PUT — apply a profile atomically ─────────────────────────────────────────

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { name } = await params;
  const profile = loadProfile(name);

  if (!profile) {
    return NextResponse.json({ error: `Profile "${name}" not found` }, { status: 404 });
  }

  const warnings: string[] = [];

  // Apply scenarios
  try {
    const { resourceVersion } = await readConfigMapKey("alerts", "scenarios-config", "scenarios.yaml");
    await patchConfigMapKey(
      "alerts",
      "scenarios-config",
      "scenarios.yaml",
      {
        scenarios: profile.scenarios.map((s: Scenario) => ({
          id: s.id,
          name: s.name,
          ...(s.description ? { description: s.description } : {}),
          severity: s.severity,
          channels: s.channels,
          sensor_filter: s.sensorFilter,
          keywords: s.keywords,
          enabled: s.enabled,
        })),
      },
      resourceVersion
    );
    await rolloutRestart("Deployment", "alerts", "alert-worker");
  } catch (err) {
    warnings.push(`Scenarios apply failed: ${String(err)}`);
  }

  // Apply VLM prompt
  try {
    await patchConfigMapRawKey("rtvi", "rtvi-runtime-env", "RTVI_VLM_SYSTEM_PROMPT", profile.vlmPrompt);
    if (profile.nimModel) {
      await patchConfigMapRawKey("rtvi", "rtvi-runtime-env", "RTVI_VLM_MODEL", profile.nimModel);
    }
    await rolloutRestart("Deployment", "rtvi", "rtvi-vlm");
  } catch (err) {
    warnings.push(`Prompt apply failed: ${String(err)}`);
  }

  // Apply rtvi tuning
  if (Object.keys(profile.rtviTuning).length > 0) {
    try {
      const tuning = profile.rtviTuning;
      const patches: Record<string, string> = {};
      if (tuning.maxNumSeqs !== undefined) patches["MAX_NUM_SEQS"] = String(tuning.maxNumSeqs);
      if (tuning.kvCachePct !== undefined) patches["KV_CACHE_PERCENT"] = String(tuning.kvCachePct);
      if (tuning.maxModelLen !== undefined) patches["MAX_MODEL_LEN"] = String(tuning.maxModelLen);

      for (const [key, val] of Object.entries(patches)) {
        await patchConfigMapRawKey("rtvi", "rtvi-runtime-env", key, val);
      }
    } catch (err) {
      warnings.push(`RTVI tuning apply failed: ${String(err)}`);
    }
  }

  // Apply alert tuning
  if (Object.keys(profile.alertTuning).length > 0) {
    try {
      const tuning = profile.alertTuning;
      if (tuning.cooldownSeconds !== undefined) {
        await patchConfigMapRawKey(
          "alerts",
          "alert-worker-config",
          "COOLDOWN_SECONDS",
          String(tuning.cooldownSeconds)
        );
      }
      await rolloutRestart("Deployment", "alerts", "alert-worker");
    } catch (err) {
      warnings.push(`Alert tuning apply failed: ${String(err)}`);
    }
  }

  await auditLog("profile-apply", `profile/${name}`, {
    name,
    scenarioCount: profile.scenarios.length,
    nimModel: profile.nimModel,
    warnings,
  });

  return NextResponse.json({ ok: true, name, warnings: warnings.length ? warnings : undefined });
}

// ─── DELETE — remove a profile ────────────────────────────────────────────────

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ name: string }> }
) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { name } = await params;
  const db = getDb();
  const result = db.prepare("DELETE FROM profiles WHERE name = ?").run(name);

  if (result.changes === 0) {
    return NextResponse.json({ error: `Profile "${name}" not found` }, { status: 404 });
  }

  await auditLog("profile-delete", `profile/${name}`, { name });

  return NextResponse.json({ ok: true, name });
}

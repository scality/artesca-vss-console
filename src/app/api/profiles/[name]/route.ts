import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { z } from "zod";
import { rejectIfKiosk } from "@/lib/kiosk-server";
import { loadProfile, saveProfile, getDb } from "@/lib/db";
import { withRequestContext } from "@/lib/with-request-context";
import { DemoProfileSchema } from "@/lib/schemas";
import { auditLog } from "@/lib/helpers/audit";
import { patchConfigMapKey, patchConfigMapRawKey, readConfigMapKey } from "@/lib/helpers/configmaps";
import { rolloutRestart } from "@/lib/k8s";
import { sshExec } from "@/lib/ssh";
import type { Scenario } from "@/lib/types";
import { CLUSTER } from "@/lib/cluster-refs";
import { dockerSock, dockerRecreateWithEnv } from "@/lib/helpers/docker-sock";
import {
  gcsScenariosPut,
  type ScenariosConfig,
} from "@/lib/helpers/gcs-config";

export const dynamic = "force-dynamic";

const DOCKER_MODE = process.env.CONSOLE_RUNTIME === "docker";
const VSS_INSTANCE_NAME = process.env.VSS_INSTANCE_NAME ?? "";

// Docker container names for components the profile apply touches.
const DOCKER_ALERTS_CONTAINER = "vss-video-analytics-api-alerts";
const DOCKER_VLM_CONTAINER = "rtvi-vlm";
const DOCKER_NIM_CONTAINER = "cosmos-reason2-8b";
// Env var keys on the rtvi-vlm container (matches prompt/route.ts).
const DOCKER_PROMPT_ENV = "VLM_SYSTEM_PROMPT";
const DOCKER_MODEL_ENV = "VIA_VLM_OPENAI_MODEL_DEPLOYMENT_NAME";

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

export const PUT = withRequestContext(async function (
  req: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const blocked = await rejectIfKiosk();
  if (blocked) return blocked;

  const { name } = await params;
  const profile = loadProfile(name);

  if (!profile) {
    return NextResponse.json({ error: `Profile "${name}" not found` }, { status: 404 });
  }

  const warnings: string[] = [];

  if (DOCKER_MODE) {
    // Scenarios — push to GCS, then restart alert-worker (unless alert tuning
    // also touches it, in which case we combine into one recreate call below).
    const alertsEnvPatch: Record<string, string> = {};

    if (Object.keys(profile.alertTuning).length > 0) {
      if (profile.alertTuning.cooldownSeconds !== undefined) {
        alertsEnvPatch[CLUSTER.alertsTuning.cooldownKey] = String(profile.alertTuning.cooldownSeconds);
      }
      if (profile.alertTuning.slackWebhookConfigured !== undefined) {
        alertsEnvPatch[CLUSTER.alertsTuning.slackConfiguredKey] =
          profile.alertTuning.slackWebhookConfigured ? "true" : "false";
      }
    }

    try {
      if (VSS_INSTANCE_NAME) {
        const gcsConfig: ScenariosConfig = {
          schema: "isv-labs.scenarios.v1",
          instance: VSS_INSTANCE_NAME,
          updatedAt: new Date().toISOString(),
          updatedBy: session.user?.email ?? "console",
          scenarios: profile.scenarios.map((s: Scenario) => ({
            id: s.id,
            name: s.name,
            ...(s.description ? { description: s.description } : {}),
            severity: s.severity as "low" | "medium" | "high" | "critical",
            channels: s.channels,
            sensor_filter: s.sensorFilter,
            keywords: s.keywords,
            enabled: s.enabled,
          })),
        };
        await gcsScenariosPut(gcsConfig);
      }
      if (Object.keys(alertsEnvPatch).length > 0) {
        await dockerRecreateWithEnv(DOCKER_ALERTS_CONTAINER, alertsEnvPatch);
      } else {
        await dockerSock(
          "POST",
          `/containers/${encodeURIComponent(DOCKER_ALERTS_CONTAINER)}/restart?t=10`,
        );
      }
    } catch (err) {
      warnings.push(`Scenarios/alert-tuning apply failed: ${String(err)}`);
    }

    // VLM prompt
    const promptPatch: Record<string, string> = {
      [DOCKER_PROMPT_ENV]: profile.vlmPrompt,
      [DOCKER_MODEL_ENV]: profile.nimModel,
    };
    try {
      await dockerRecreateWithEnv(DOCKER_VLM_CONTAINER, promptPatch);
    } catch (err) {
      warnings.push(`Prompt apply failed: ${String(err)}`);
    }

    // RTVI tuning — recreates NIM (5–10 min downtime)
    if (Object.keys(profile.rtviTuning).length > 0) {
      const rtviPatch: Record<string, string> = {};
      if (profile.rtviTuning.maxNumSeqs !== undefined) {
        rtviPatch[CLUSTER.rtvi.nimMaxNumSeqsKey] = String(profile.rtviTuning.maxNumSeqs);
      }
      if (profile.rtviTuning.kvCachePct !== undefined) {
        rtviPatch[CLUSTER.rtvi.nimKvCacheKey] = String(profile.rtviTuning.kvCachePct);
      }
      if (profile.rtviTuning.maxModelLen !== undefined) {
        rtviPatch[CLUSTER.rtvi.nimMaxModelLenKey] = String(profile.rtviTuning.maxModelLen);
      }
      if (Object.keys(rtviPatch).length > 0) {
        try {
          await dockerRecreateWithEnv(DOCKER_NIM_CONTAINER, rtviPatch);
          warnings.push("NIM container recreating — expect 5–10 min downtime.");
        } catch (err) {
          warnings.push(`RTVI tuning apply failed: ${String(err)}`);
        }
      }
    }

    await auditLog("profile-apply", `docker/profile/${name}`, {
      name,
      scenarioCount: profile.scenarios.length,
      nimModel: profile.nimModel,
      warnings,
    });
    return NextResponse.json({ ok: true, name, warnings: warnings.length ? warnings : undefined, runtime: "docker" });
  }

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
});

// ─── DELETE — remove a profile ────────────────────────────────────────────────

export const DELETE = withRequestContext(async function (
  _req: Request,
  { params }: { params: Promise<{ name: string }> }
) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const blocked = await rejectIfKiosk();
  if (blocked) return blocked;

  const { name } = await params;
  const db = getDb();
  const result = db.prepare("DELETE FROM profiles WHERE name = ?").run(name);

  if (result.changes === 0) {
    return NextResponse.json({ error: `Profile "${name}" not found` }, { status: 404 });
  }

  await auditLog("profile-delete", `profile/${name}`, { name });

  return NextResponse.json({ ok: true, name });
});

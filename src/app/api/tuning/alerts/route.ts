import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { createLogger } from "@/lib/logger";
import { withRequestContext } from "@/lib/with-request-context";

const log = createLogger("api/tuning/alerts");
import { z } from "zod";
import { coreV1, rolloutRestart } from "@/lib/k8s";
import { patchConfigMapRawKey } from "@/lib/helpers/configmaps";
import { auditLog } from "@/lib/helpers/audit";
import { CLUSTER } from "@/lib/cluster-refs";
import {
  inspectContainer,
  dockerRecreateWithEnv,
  DOCKER_TUNING_DIR,
} from "@/lib/helpers/docker-sock";
import { extractK8sError } from "@/lib/errors";
import { rejectIfKiosk } from "@/lib/kiosk-server";
import fs from "fs/promises";
import path from "node:path";

export const dynamic = "force-dynamic";

const DOCKER_MODE = process.env.CONSOLE_RUNTIME === "docker";
const ALERTS_CONTAINER = "vss-video-analytics-api-alerts";
const ALERTS_PERSIST_FILE = path.join(DOCKER_TUNING_DIR, "alerts.json");

const AlertsTuningSchema = z.object({
  cooldownSeconds: z.number().int().nonnegative().optional(),
  slackWebhookConfigured: z.boolean().optional(),
}).refine(
  (d) => Object.values(d).some((v) => v !== undefined),
  { message: "At least one tuning field is required" }
);

// Defaults align with k8s/nvidia-vss/alerts/11-configmap-runtime-env.yaml + the
// AlertsTuningForm client contract (cooldownSeconds default 120,
// slackWebhookConfigured default false).
const ALERTS_TUNING_DEFAULTS = {
  cooldownSeconds: 120,
  slackWebhookConfigured: false,
} as const;

interface AlertsTuningState {
  cooldownSeconds: number;
  slackWebhookConfigured: boolean;
}

async function readPersistedAlertsTuning(): Promise<AlertsTuningState | null> {
  try {
    const raw = await fs.readFile(ALERTS_PERSIST_FILE, "utf-8");
    return JSON.parse(raw) as AlertsTuningState;
  } catch {
    return null;
  }
}

async function persistAlertsTuning(state: AlertsTuningState): Promise<void> {
  await fs.mkdir(DOCKER_TUNING_DIR, { recursive: true });
  await fs.writeFile(ALERTS_PERSIST_FILE, JSON.stringify(state), "utf-8");
}

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (DOCKER_MODE) {
    const inspect = await inspectContainer(ALERTS_CONTAINER);
    if (inspect) {
      const env: Record<string, string> = {};
      for (const line of inspect.Config.Env ?? []) {
        const eq = line.indexOf("=");
        if (eq > 0) env[line.slice(0, eq)] = line.slice(eq + 1);
      }
      const rawCooldown = env[CLUSTER.alertsTuning.cooldownKey];
      const rawSlack = env[CLUSTER.alertsTuning.slackConfiguredKey];
      return NextResponse.json({
        cooldownSeconds:
          rawCooldown !== undefined && Number.isFinite(parseInt(rawCooldown, 10))
            ? Math.max(0, parseInt(rawCooldown, 10))
            : ALERTS_TUNING_DEFAULTS.cooldownSeconds,
        slackWebhookConfigured:
          rawSlack === "true" ? true : rawSlack === "false" ? false : ALERTS_TUNING_DEFAULTS.slackWebhookConfigured,
        runtime: "docker",
      });
    }
    // Container not running — fall back to persisted state or defaults.
    const persisted = await readPersistedAlertsTuning();
    return NextResponse.json({
      ...(persisted ?? ALERTS_TUNING_DEFAULTS),
      runtime: "docker",
      warnings: ["alert-worker container not running — showing last-known or default values"],
    });
  }

  let data: Record<string, string> | undefined;
  try {
    const cm = await coreV1().readNamespacedConfigMap({
      name: CLUSTER.alertsTuning.configMap,
      namespace: CLUSTER.alertsTuning.namespace,
    });
    data = cm.data;
  } catch (err: unknown) {
    const { status, message } = extractK8sError(err);
    return NextResponse.json(
      { error: message, k8sCode: status },
      { status }
    );
  }

  const rawCooldown = data?.[CLUSTER.alertsTuning.cooldownKey];
  const cooldownSeconds =
    rawCooldown !== undefined && rawCooldown !== "" && Number.isFinite(parseInt(rawCooldown, 10))
      ? Math.max(0, parseInt(rawCooldown, 10))
      : ALERTS_TUNING_DEFAULTS.cooldownSeconds;

  const rawSlack = data?.[CLUSTER.alertsTuning.slackConfiguredKey];
  const slackWebhookConfigured =
    rawSlack === "true" ? true : rawSlack === "false" ? false : ALERTS_TUNING_DEFAULTS.slackWebhookConfigured;

  return NextResponse.json({ cooldownSeconds, slackWebhookConfigured });
}

export const PATCH = withRequestContext(async function (req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const blocked = await rejectIfKiosk();
  if (blocked) return blocked;

  const body = await req.json().catch(() => null);
  const parsed = AlertsTuningSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Validation failed", issues: parsed.error.issues }, { status: 400 });
  }

  const tuning = parsed.data;

  if (DOCKER_MODE) {
    const inspect = await inspectContainer(ALERTS_CONTAINER);
    const existingEnv: Record<string, string> = {};
    if (inspect) {
      for (const line of inspect.Config.Env ?? []) {
        const eq = line.indexOf("=");
        if (eq > 0) existingEnv[line.slice(0, eq)] = line.slice(eq + 1);
      }
    }

    const envPatch: Record<string, string> = {};
    if (tuning.cooldownSeconds !== undefined) {
      envPatch[CLUSTER.alertsTuning.cooldownKey] = String(tuning.cooldownSeconds);
    }
    if (tuning.slackWebhookConfigured !== undefined) {
      envPatch[CLUSTER.alertsTuning.slackConfiguredKey] = tuning.slackWebhookConfigured ? "true" : "false";
    }

    try {
      await dockerRecreateWithEnv(ALERTS_CONTAINER, envPatch);
    } catch (err) {
      return NextResponse.json(
        { error: `alert-worker recreate failed: ${String(err)}`, runtime: "docker" },
        { status: 502 },
      );
    }

    const parsedCooldown = parseInt(existingEnv[CLUSTER.alertsTuning.cooldownKey] ?? "", 10);
    const newState: AlertsTuningState = {
      cooldownSeconds: tuning.cooldownSeconds ?? (Number.isFinite(parsedCooldown) ? parsedCooldown : ALERTS_TUNING_DEFAULTS.cooldownSeconds),
      slackWebhookConfigured: tuning.slackWebhookConfigured ?? (existingEnv[CLUSTER.alertsTuning.slackConfiguredKey] === "true" ? true : ALERTS_TUNING_DEFAULTS.slackWebhookConfigured),
    };
    await persistAlertsTuning(newState).catch((err) => log.error("alerts-tuning persist failed", { err }));

    await auditLog("tuning-alerts", `docker/${ALERTS_CONTAINER}`, { patches: envPatch });
    return NextResponse.json({ ok: true, applied: envPatch, runtime: "docker" });
  }

  const patches: Array<[string, string]> = [];

  if (tuning.cooldownSeconds !== undefined) {
    patches.push([CLUSTER.alertsTuning.cooldownKey, String(tuning.cooldownSeconds)]);
  }
  if (tuning.slackWebhookConfigured !== undefined) {
    patches.push([CLUSTER.alertsTuning.slackConfiguredKey, tuning.slackWebhookConfigured ? "true" : "false"]);
  }

  try {
    // Real ConfigMap is "alerts-runtime-env" (k8s/nvidia-vss/alerts/11-configmap-runtime-env.yaml),
    // not "alert-worker-config".
    for (const [key, val] of patches) {
      await patchConfigMapRawKey(CLUSTER.alertsTuning.namespace, CLUSTER.alertsTuning.configMap, key, val);
    }
  } catch (err: unknown) {
    const { status, message } = extractK8sError(err);
    return NextResponse.json(
      { error: message, k8sCode: status },
      { status }
    );
  }

  // Rollout-restart alert-worker to apply new env
  try {
    await rolloutRestart("Deployment", CLUSTER.alertsTuning.namespace, CLUSTER.scenarios.alertWorkerDeployment);
  } catch (err) {
    return NextResponse.json(
      { error: `Rollout restart failed: ${String(err)}` },
      { status: 502 }
    );
  }

  await auditLog("tuning-alerts", `configmap/${CLUSTER.alertsTuning.configMap}`, { patches: Object.fromEntries(patches) });

  return NextResponse.json({ ok: true, applied: Object.fromEntries(patches) });
});

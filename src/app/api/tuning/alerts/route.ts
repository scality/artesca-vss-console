import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { createLogger } from "@/lib/logger";
import { withRequestContext } from "@/lib/with-request-context";

const log = createLogger("api/tuning/alerts");
import { z } from "zod";
import { parse as yamlParse } from "yaml";
import { coreV1, rolloutRestart } from "@/lib/k8s";
import { patchConfigMapKey } from "@/lib/helpers/configmaps";
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

  // The alert-worker enforces cooldown PER SCENARIO (cooldown_seconds in the
  // scenarios ConfigMap) — there is no global cooldown env on this chart. Report
  // a representative value (the max set across scenarios) so the card reflects
  // what's actually in effect.
  let scenarios: Array<Record<string, unknown>>;
  try {
    const cm = await coreV1().readNamespacedConfigMap({
      name: CLUSTER.scenarios.configMap,
      namespace: CLUSTER.scenarios.namespace,
    });
    const doc = yamlParse(cm.data?.[CLUSTER.scenarios.yamlKey] ?? "") as { scenarios?: Array<Record<string, unknown>> } | null;
    scenarios = Array.isArray(doc?.scenarios) ? doc!.scenarios! : [];
  } catch (err: unknown) {
    const { status, message } = extractK8sError(err);
    if (status === 404) {
      return NextResponse.json({
        ...ALERTS_TUNING_DEFAULTS,
        warning: "scenarios ConfigMap not found — showing defaults",
      });
    }
    return NextResponse.json({ error: message, k8sCode: status }, { status });
  }

  const cooldowns = scenarios
    .map((s) => Number(s.cooldown_seconds ?? 0))
    .filter((n) => Number.isFinite(n));
  const cooldownSeconds = cooldowns.length ? Math.max(0, ...cooldowns) : 0;

  return NextResponse.json({
    cooldownSeconds,
    slackWebhookConfigured: ALERTS_TUNING_DEFAULTS.slackWebhookConfigured,
  });
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

  // Cooldown is per-scenario on this chart — apply the requested value to every
  // scenario's cooldown_seconds in the scenarios ConfigMap. (slackWebhookConfigured
  // has no backing on the alerts profile and is ignored.)
  if (tuning.cooldownSeconds === undefined) {
    return NextResponse.json({ ok: true, applied: {}, note: "Nothing to apply (cooldown only on this chart)." });
  }

  let doc: { scenarios?: Array<Record<string, unknown>> } | null;
  try {
    const cm = await coreV1().readNamespacedConfigMap({
      name: CLUSTER.scenarios.configMap,
      namespace: CLUSTER.scenarios.namespace,
    });
    doc = yamlParse(cm.data?.[CLUSTER.scenarios.yamlKey] ?? "") as typeof doc;
  } catch (err: unknown) {
    const { status, message } = extractK8sError(err);
    return NextResponse.json({ error: `read scenarios ConfigMap failed: ${message}`, k8sCode: status }, { status });
  }

  const scenarios = Array.isArray(doc?.scenarios) ? doc!.scenarios! : [];
  if (scenarios.length === 0) {
    return NextResponse.json({ error: "no scenarios to apply cooldown to" }, { status: 409 });
  }
  for (const s of scenarios) s.cooldown_seconds = tuning.cooldownSeconds;

  try {
    await patchConfigMapKey(
      CLUSTER.scenarios.namespace,
      CLUSTER.scenarios.configMap,
      CLUSTER.scenarios.yamlKey,
      { scenarios },
    );
  } catch (err: unknown) {
    const { status, message } = extractK8sError(err);
    return NextResponse.json({ error: `patch scenarios ConfigMap failed: ${message}`, k8sCode: status }, { status });
  }

  // Rollout-restart alert-worker to reload scenarios.
  try {
    await rolloutRestart("Deployment", CLUSTER.scenarios.namespace, CLUSTER.scenarios.alertWorkerDeployment);
  } catch (err) {
    return NextResponse.json({ error: `Rollout restart failed: ${String(err)}` }, { status: 502 });
  }

  await auditLog("tuning-alerts", `configmap/${CLUSTER.scenarios.configMap}`, {
    cooldownSeconds: String(tuning.cooldownSeconds),
    scenariosUpdated: String(scenarios.length),
  });

  return NextResponse.json({
    ok: true,
    applied: { cooldownSeconds: tuning.cooldownSeconds },
    scenariosUpdated: scenarios.length,
    note: "Cooldown applied to all scenarios; alert-worker restarted.",
  });
});

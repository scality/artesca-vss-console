import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { createLogger } from "@/lib/logger";
import { withRequestContext } from "@/lib/with-request-context";

const log = createLogger("api/tuning/alerts");
import { z } from "zod";
import { auditLog } from "@/lib/helpers/audit";
import { CLUSTER } from "@/lib/cluster-refs";
import type { ScenarioEntry } from "@/lib/config-store/types";
import {
  inspectContainer,
  dockerRecreateWithEnv,
  DOCKER_TUNING_DIR,
} from "@/lib/helpers/docker-sock";
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

  // The alert-worker enforces cooldown PER SCENARIO (cooldown_seconds on each
  // scenario) — there is no global cooldown env on this chart. Firestore is the
  // source of truth for scenarios on k8s (the scenarios ConfigMap is reconciled
  // FROM it), so read from the config store and report a representative value
  // (the max cooldown set across scenarios) so the card reflects what's in effect.
  const { makeReconcileContext, ReconcileContextError } = await import("@/lib/reconcile/context");
  let scenarios: ScenarioEntry[];
  try {
    const ctx = await makeReconcileContext();
    scenarios = await ctx.store.readScenarios(ctx.instance);
  } catch (err: unknown) {
    if (err instanceof ReconcileContextError) {
      return NextResponse.json({
        ...ALERTS_TUNING_DEFAULTS,
        warning: `config store unavailable — showing defaults: ${err.message}`,
      });
    }
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 502 });
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

  // Cooldown is per-scenario on this chart, and Firestore is the source of truth
  // for scenarios on k8s (the scenarios ConfigMap is reconciled FROM it). Apply
  // the requested value to every scenario's cooldown_seconds in the config store,
  // then reconcile so the ConfigMap converges + the alert-worker reloads.
  // (slackWebhookConfigured has no backing on the alerts profile and is ignored.)
  if (tuning.cooldownSeconds === undefined) {
    return NextResponse.json({ ok: true, applied: {}, note: "Nothing to apply (cooldown only on this chart)." });
  }

  const { makeReconcileContext, ReconcileContextError } = await import("@/lib/reconcile/context");
  const { reconcileScenarios } = await import("@/lib/reconcile/scenarios");

  let ctx: Awaited<ReturnType<typeof makeReconcileContext>>;
  let scenarios: ScenarioEntry[];
  try {
    ctx = await makeReconcileContext();
    scenarios = await ctx.store.readScenarios(ctx.instance);
  } catch (err: unknown) {
    const msg = err instanceof ReconcileContextError ? err.message : String(err);
    return NextResponse.json({ error: `read scenarios failed: ${msg}` }, { status: 502 });
  }

  if (scenarios.length === 0) {
    return NextResponse.json({ error: "no scenarios to apply cooldown to" }, { status: 409 });
  }
  const updated = scenarios.map((s) => ({ ...s, cooldown_seconds: tuning.cooldownSeconds! }));

  let reconcileWarning: string | undefined;
  try {
    await ctx.store.writeScenarios(ctx.instance, updated, session.user?.email ?? "console");
    const res = await reconcileScenarios(updated, ctx.adapter, ctx.refs.scenarios);
    reconcileWarning = res.error;
  } catch (err: unknown) {
    const msg = err instanceof ReconcileContextError ? err.message : String(err);
    return NextResponse.json({ error: `write scenarios failed: ${msg}` }, { status: 502 });
  }

  await auditLog("tuning-alerts", `firestore/${ctx.instance}`, {
    cooldownSeconds: String(tuning.cooldownSeconds),
    scenariosUpdated: String(updated.length),
  });

  return NextResponse.json({
    ok: true,
    applied: { cooldownSeconds: tuning.cooldownSeconds },
    scenariosUpdated: updated.length,
    note: "Cooldown applied to all scenarios; alert-worker restarted.",
    ...(reconcileWarning ? { warnings: [reconcileWarning] } : {}),
  });
});

import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { createLogger } from "@/lib/logger";
import { withRequestContext } from "@/lib/with-request-context";

const log = createLogger("api/tuning/alerts");
import { z } from "zod";
import { auditLog } from "@/lib/helpers/audit";
import { CLUSTER } from "@/lib/cluster-refs";
import type { ScenarioEntry } from "@/lib/config-store/types";
import { rejectIfKiosk } from "@/lib/kiosk-server";
import fs from "fs/promises";
import path from "node:path";

export const dynamic = "force-dynamic";

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

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });


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

import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { z } from "zod";
import { coreV1, rolloutRestart } from "@/lib/k8s";
import { ScenarioSchema } from "@/lib/schemas";
import { patchConfigMapKey, readConfigMapKey } from "@/lib/helpers/configmaps";
import { auditLog } from "@/lib/helpers/audit";
import { CLUSTER } from "@/lib/cluster-refs";
import type { Scenario } from "@/lib/types";

export const dynamic = "force-dynamic";

type ScenariosConfigRaw = {
  scenarios?: Array<{
    id?: string;
    name?: string;
    description?: string;
    severity?: string;
    channels?: string[];
    sensor_filter?: string;
    sensorFilter?: string;
    keywords?: string[];
    enabled?: boolean;
    cooldown_seconds?: number;
  }>;
};

function parseRawScenarios(raw: ScenariosConfigRaw): Scenario[] {
  return (raw.scenarios ?? []).map((s, i) => ({
    id: s.id ?? String(i),
    name: s.name ?? `scenario-${i}`,
    description: s.description,
    severity: (s.severity as Scenario["severity"]) ?? "medium",
    channels: ((s.channels ?? ["ui"]) as Array<"ui" | "slack">),
    sensorFilter: s.sensor_filter ?? s.sensorFilter ?? "*",
    keywords: s.keywords ?? [],
    enabled: s.enabled !== false,
  }));
}

function scenariosToConfigMap(scenarios: Scenario[]): ScenariosConfigRaw {
  return {
    scenarios: scenarios.map((s) => ({
      id: s.id,
      name: s.name,
      ...(s.description ? { description: s.description } : {}),
      severity: s.severity,
      channels: s.channels,
      sensor_filter: s.sensorFilter,
      keywords: s.keywords,
      enabled: s.enabled,
    })),
  };
}

// ─── GET ───────────────────────────────────────────────────────────────────────

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const warnings: string[] = [];

  try {
    const { value: raw, resourceVersion } = await readConfigMapKey<ScenariosConfigRaw>(
      CLUSTER.scenarios.namespace,
      CLUSTER.scenarios.configMap,
      CLUSTER.scenarios.yamlKey
    );

    const scenarios = parseRawScenarios(raw ?? {});
    return NextResponse.json({ scenarios, resourceVersion, warnings });
  } catch (err) {
    warnings.push(`scenarios-config unreadable: ${String(err)}`);
    return NextResponse.json({ scenarios: [], warnings });
  }
}

// ─── PATCH ─────────────────────────────────────────────────────────────────────

const PatchScenariosSchema = z.object({
  scenarios: z.array(ScenarioSchema).min(1),
});

export async function PATCH(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => null);
  const parsed = PatchScenariosSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Validation failed", issues: parsed.error.issues }, { status: 400 });
  }

  const { scenarios } = parsed.data;
  const ifMatch = req.headers.get("If-Match") ?? undefined;

  try {
    // Read current resourceVersion if If-Match not supplied
    let resourceVersion = ifMatch;
    if (!resourceVersion) {
      const cm = await coreV1().readNamespacedConfigMap({
        name: CLUSTER.scenarios.configMap,
        namespace: CLUSTER.scenarios.namespace,
      });
      resourceVersion = cm.metadata?.resourceVersion;
    }

    await patchConfigMapKey(
      CLUSTER.scenarios.namespace,
      CLUSTER.scenarios.configMap,
      CLUSTER.scenarios.yamlKey,
      scenariosToConfigMap(scenarios),
      resourceVersion
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

  // Rollout-restart alert-worker to pick up new config
  try {
    await rolloutRestart("Deployment", CLUSTER.scenarios.namespace, CLUSTER.scenarios.alertWorkerDeployment);
  } catch (err) {
    return NextResponse.json(
      { error: `Rollout restart failed: ${String(err)}` },
      { status: 502 }
    );
  }

  await auditLog(`scenarios-update`, `configmap/${CLUSTER.scenarios.configMap}`, {
    count: scenarios.length,
    ids: scenarios.map((s) => s.id),
  });

  return NextResponse.json({ ok: true, count: scenarios.length });
}

import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { createLogger } from "@/lib/logger";
import { withRequestContext } from "@/lib/with-request-context";

const log = createLogger("api/scenarios");
import { z } from "zod";
import { coreV1, rolloutRestart } from "@/lib/k8s";
import { extractK8sError } from "@/lib/errors";
import { rejectIfKiosk } from "@/lib/kiosk-server";
import { ScenarioSchema } from "@/lib/schemas";
import { patchConfigMapKey, readConfigMapKey } from "@/lib/helpers/configmaps";
import { auditLog } from "@/lib/helpers/audit";
import { CLUSTER } from "@/lib/cluster-refs";
import type { Scenario } from "@/lib/types";
import {
  gcsScenariosGet,
  gcsScenariosPut,
  type ScenariosConfig,
  type ScenarioConfig,
} from "@/lib/helpers/gcs-config";
import { scenarioToGcsConfig } from "@/lib/helpers/scenarios-apply";
import { dockerSock } from "@/lib/helpers/docker-sock";
import fs from "fs/promises";
import path from "path";

export const dynamic = "force-dynamic";

const DOCKER_MODE = process.env.CONSOLE_RUNTIME === "docker";
const DOCKER_TUNING_DIR = path.join(
  process.env.CONSOLE_DATA_DIR ?? "/data",
  ".docker-tuning",
);
const DOCKER_ALERT_CONTAINER = "vss-video-analytics-api-alerts";

const VSS_INSTANCE_NAME = process.env.VSS_INSTANCE_NAME ?? "";

// Mutex for GCS writes.
let _gcsWriteChain: Promise<void> = Promise.resolve();
function chainGcsWrite(fn: () => Promise<void>): Promise<void> {
  _gcsWriteChain = _gcsWriteChain.then(fn).catch((err) => log.error("gcs-write failed", { err }));
  return _gcsWriteChain;
}

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

  if (DOCKER_MODE) {
    let gcsCfg: ScenariosConfig | null = null;
    let scenarios: Scenario[] = [];

    if (VSS_INSTANCE_NAME) {
      gcsCfg = await gcsScenariosGet(VSS_INSTANCE_NAME).catch(() => null);
    }

    if (gcsCfg) {
      scenarios = parseRawScenarios({ scenarios: gcsCfg.scenarios });
    } else {
      try {
        const raw = JSON.parse(
          await fs.readFile(path.join(DOCKER_TUNING_DIR, "scenarios.json"), "utf-8"),
        ) as ScenariosConfigRaw;
        scenarios = parseRawScenarios(raw);
        if (VSS_INSTANCE_NAME) {
          warnings.push("GCS unavailable — serving from local fallback");
        }
      } catch {
        warnings.push("No scenarios found — GCS unavailable and no local fallback");
      }
    }

    return NextResponse.json({
      scenarios,
      resourceVersion: null,
      gcs: buildGcsField(gcsCfg),
      warnings,
    });
  }

  // GCS fetch runs in parallel with the ConfigMap read.
  const gcsPromise = VSS_INSTANCE_NAME
    ? gcsScenariosGet(VSS_INSTANCE_NAME)
    : Promise.resolve(null);

  try {
    const [{ value: raw, resourceVersion }, gcsCfg] = await Promise.all([
      readConfigMapKey<ScenariosConfigRaw>(
        CLUSTER.scenarios.namespace,
        CLUSTER.scenarios.configMap,
        CLUSTER.scenarios.yamlKey
      ),
      gcsPromise,
    ]);

    const scenarios = parseRawScenarios(raw ?? {});
    return NextResponse.json({
      scenarios,
      resourceVersion,
      gcs: buildGcsField(gcsCfg),
      warnings,
    });
  } catch (err) {
    warnings.push(`scenarios-config unreadable: ${String(err)}`);
    const gcsCfg = await gcsPromise.catch(() => null);
    return NextResponse.json({ scenarios: [], gcs: buildGcsField(gcsCfg), warnings });
  }
}

function buildGcsField(gcsCfg: ScenariosConfig | null) {
  if (!gcsCfg) {
    return { available: false };
  }
  return {
    available: true,
    lastUpdated: gcsCfg.updatedAt,
    lastUpdatedBy: gcsCfg.updatedBy,
    totalScenarios: gcsCfg.scenarios.length,
  };
}

// ─── PATCH ─────────────────────────────────────────────────────────────────────

const PatchScenariosSchema = z.object({
  scenarios: z.array(ScenarioSchema).min(1),
});

export const PATCH = withRequestContext(async (req: NextRequest) => {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const blocked = await rejectIfKiosk();
  if (blocked) return blocked;

  const body = await req.json().catch(() => null);
  const parsed = PatchScenariosSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Validation failed", issues: parsed.error.issues }, { status: 400 });
  }

  const { scenarios } = parsed.data;
  const ifMatch = req.headers.get("If-Match") ?? undefined;

  if (DOCKER_MODE) {
    await fs.mkdir(DOCKER_TUNING_DIR, { recursive: true });
    await fs.writeFile(
      path.join(DOCKER_TUNING_DIR, "scenarios.json"),
      JSON.stringify(scenariosToConfigMap(scenarios), null, 2),
      { mode: 0o600 },
    );

    const gcsWarnings: string[] = [];
    if (VSS_INSTANCE_NAME) {
      const warn = await persistScenarisoToGcs(scenarios, session.user?.email ?? "console");
      if (warn) gcsWarnings.push(warn);
    }

    const restartWarnings: string[] = [];
    try {
      await dockerSock("POST", `/containers/${DOCKER_ALERT_CONTAINER}/restart?t=10`);
    } catch (err) {
      restartWarnings.push(`Container restart failed: ${String(err)}`);
    }

    await auditLog("scenarios-update", `docker/${DOCKER_ALERT_CONTAINER}`, {
      count: scenarios.length,
      ids: scenarios.map((s) => s.id),
    });

    return NextResponse.json({
      ok: true,
      count: scenarios.length,
      ...(gcsWarnings.length ? { gcsWarnings } : {}),
      ...(restartWarnings.length ? { warnings: restartWarnings } : {}),
    });
  }

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
    const { status } = extractK8sError(err);
    if (status === 409) {
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

  // Persist to GCS (best-effort — ConfigMap already patched).
  const gcsWarnings: string[] = [];
  if (VSS_INSTANCE_NAME) {
    const gcsWarning = await persistScenarisoToGcs(scenarios, session.user?.email ?? "console");
    if (gcsWarning) gcsWarnings.push(gcsWarning);
  }

  return NextResponse.json({
    ok: true,
    count: scenarios.length,
    ...(gcsWarnings.length ? { gcsWarnings } : {}),
  });
});

// ─── GCS write helper ─────────────────────────────────────────────────────────

async function persistScenarisoToGcs(
  scenarios: Scenario[],
  updatedBy: string,
): Promise<string | undefined> {
  let warning: string | undefined;
  await chainGcsWrite(async () => {
    try {
      const gcsScenarios: ScenarioConfig[] = scenarios.map(scenarioToGcsConfig);
      const config: ScenariosConfig = {
        schema: "isv-labs.scenarios.v1",
        instance: VSS_INSTANCE_NAME,
        updatedAt: new Date().toISOString(),
        updatedBy,
        scenarios: gcsScenarios,
      };
      await gcsScenariosPut(config);
    } catch (err) {
      warning = `GCS scenarios write failed (ConfigMap already patched): ${
        err instanceof Error ? err.message : String(err)
      }`;
      log.warn("gcs scenarios write failed", { err });
    }
  });
  return warning;
}

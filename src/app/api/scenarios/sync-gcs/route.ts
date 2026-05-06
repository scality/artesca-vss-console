import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import {
  gcsScenariosPut,
  type ScenariosConfig,
  type ScenarioConfig,
} from "@/lib/helpers/gcs-config";
import { readConfigMapKey } from "@/lib/helpers/configmaps";
import { CLUSTER } from "@/lib/cluster-refs";
import fs from "fs/promises";
import path from "path";

export const dynamic = "force-dynamic";

const DOCKER_MODE = process.env.CONSOLE_RUNTIME === "docker";
const DOCKER_TUNING_DIR = path.join(
  process.env.CONSOLE_DATA_DIR ?? "/data",
  ".docker-tuning",
);

const VSS_INSTANCE_NAME = process.env.VSS_INSTANCE_NAME ?? "";

// ─── POST /api/scenarios/sync-gcs ────────────────────────────────────────────
//
// Snapshots the current live scenarios to GCS.
// Used by the "Save all to GCS" button on the scenarios page.

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

export async function POST() {
  const session = await auth();
  if (!session)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (!VSS_INSTANCE_NAME) {
    return NextResponse.json(
      { error: "VSS_INSTANCE_NAME is not set — cannot write to GCS" },
      { status: 400 },
    );
  }

  let raw: ScenariosConfigRaw;

  if (DOCKER_MODE) {
    try {
      raw = JSON.parse(
        await fs.readFile(path.join(DOCKER_TUNING_DIR, "scenarios.json"), "utf-8"),
      ) as ScenariosConfigRaw;
    } catch {
      return NextResponse.json(
        { error: "No local scenarios found — save scenarios first before syncing to GCS" },
        { status: 404 },
      );
    }
  } else {
    try {
      const { value } = await readConfigMapKey<ScenariosConfigRaw>(
        CLUSTER.scenarios.namespace,
        CLUSTER.scenarios.configMap,
        CLUSTER.scenarios.yamlKey,
      );
      raw = value ?? {};
    } catch (err) {
      return NextResponse.json(
        { error: `Failed to read scenarios ConfigMap: ${err instanceof Error ? err.message : String(err)}` },
        { status: 502 },
      );
    }
  }

  // Convert raw entries to GCS wire format.
  const scenarios: ScenarioConfig[] = (raw.scenarios ?? []).map((s, i) => ({
    id: s.id ?? String(i),
    name: s.name ?? `scenario-${i}`,
    ...(s.description ? { description: s.description } : {}),
    severity: (s.severity as ScenarioConfig["severity"]) ?? "medium",
    channels: ((s.channels ?? ["ui"]) as ("ui" | "slack")[]),
    sensor_filter: s.sensor_filter ?? s.sensorFilter ?? "*",
    keywords: s.keywords ?? [],
    enabled: s.enabled !== false,
    ...(s.cooldown_seconds !== undefined ? { cooldown_seconds: s.cooldown_seconds } : {}),
  }));

  const config: ScenariosConfig = {
    schema: "isv-labs.scenarios.v1",
    instance: VSS_INSTANCE_NAME,
    updatedAt: new Date().toISOString(),
    updatedBy: session.user?.email ?? "console",
    scenarios,
  };

  try {
    await gcsScenariosPut(config);
  } catch (err) {
    return NextResponse.json(
      { error: `GCS write failed: ${err instanceof Error ? err.message : String(err)}` },
      { status: 502 },
    );
  }

  return NextResponse.json({
    ok: true,
    instance: VSS_INSTANCE_NAME,
    synced: scenarios.length,
  });
}

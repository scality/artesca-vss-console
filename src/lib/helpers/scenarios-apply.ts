/**
 * Shared helper for applying a scenarios update — used by both the route
 * handler and the GCS bootstrap. Isolates the ConfigMap patch logic so
 * the bootstrap can call it directly without HTTP round-trips.
 *
 * Note: docker mode has no separate scenarios ConfigMap (scenarios are only
 * used by the alert-worker which runs inside K8s even in docker-compose stacks).
 * The apply function skips silently when CONSOLE_RUNTIME=docker.
 */
import "server-only";
import { stringify as yamlStringify } from "yaml";
import { patchConfigMapKey } from "./configmaps";
import { CLUSTER } from "../cluster-refs";
import type { ScenarioConfig } from "./gcs-config";
import type { Scenario } from "../types";

/** Convert GCS wire-format scenarios to the ConfigMap YAML payload. */
export function gcsScenariosToCmPayload(
  scenarios: ScenarioConfig[],
): { scenarios: object[] } {
  return {
    scenarios: scenarios.map((s) => ({
      id: s.id,
      name: s.name,
      ...(s.description ? { description: s.description } : {}),
      severity: s.severity,
      channels: s.channels,
      sensor_filter: s.sensor_filter,
      keywords: s.keywords,
      enabled: s.enabled,
      ...(s.cooldown_seconds !== undefined ? { cooldown_seconds: s.cooldown_seconds } : {}),
    })),
  };
}

/** Convert Scenario (camelCase) to GCS wire-format (snake_case). */
export function scenarioToGcsConfig(s: Scenario): ScenarioConfig {
  return {
    id: s.id,
    name: s.name,
    ...(s.description ? { description: s.description } : {}),
    severity: s.severity as ScenarioConfig["severity"],
    channels: s.channels,
    sensor_filter: s.sensorFilter,
    keywords: s.keywords,
    enabled: s.enabled,
  };
}

/** Apply a set of GCS-format scenarios to the live ConfigMap.
 *  Skips silently in docker mode (no scenarios ConfigMap in docker-compose). */
export async function applyScenariosLive(
  dockerMode: boolean,
  scenarios: ScenarioConfig[],
): Promise<void> {
  if (dockerMode) {
    console.log("[scenarios-apply] docker mode — skipping ConfigMap patch (no scenarios CM in compose)");
    return;
  }
  const payload = gcsScenariosToCmPayload(scenarios);
  await patchConfigMapKey(
    CLUSTER.scenarios.namespace,
    CLUSTER.scenarios.configMap,
    CLUSTER.scenarios.yamlKey,
    payload,
  );
}

/** Stringify scenarios payload to YAML for comparison / logging. */
export function scenariosToYaml(scenarios: ScenarioConfig[]): string {
  return yamlStringify(gcsScenariosToCmPayload(scenarios));
}

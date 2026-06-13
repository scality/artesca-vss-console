import "server-only";

import { vstListSensors, vstAddSensor } from "@/lib/helpers/vst";
import { appsV1, rolloutRestart, MERGE_PATCH_OPTS } from "@/lib/k8s";
import { readConfigMapKey, patchConfigMapRawKey } from "@/lib/helpers/configmaps";

/** A live sensor as the reconciler sees it (subset of VstSensor, renamed). */
export interface AdapterSensor {
  sensorId: string;
  name: string;
  rtspUrl?: string;
}

/**
 * The cluster operations the reconciler needs. `removeSensor` is optional —
 * prune only runs when it is present (the Vst adapter omits it in Plan 1).
 */
export interface ClusterAdapter {
  listSensors(): Promise<AdapterSensor[]>;
  addSensor(name: string, rtspUrl: string, description?: string): Promise<{ ok: boolean; warning?: string }>;
  removeSensor?(sensorId: string): Promise<{ ok: boolean; warning?: string }>;
  /** Read a container[0] env var value from a Deployment (null if unset). Plan 4. */
  getDeploymentEnv?(ns: string, deployment: string, key: string): Promise<string | null>;
  /** Set/replace a container[0] env var on a Deployment. Plan 4. */
  patchDeploymentEnv?(ns: string, deployment: string, key: string, value: string): Promise<void>;
  /** Read a ConfigMap data key (raw string) (null if absent). Plan 4. */
  getConfigMapKey?(ns: string, cm: string, key: string): Promise<string | null>;
  /** Set a ConfigMap data key (raw string). Plan 4. */
  patchConfigMapKey?(ns: string, cm: string, key: string, value: string): Promise<void>;
  /** Rollout-restart a Deployment. Plan 4. */
  restartDeployment?(ns: string, deployment: string): Promise<void>;
  /** Ensure a Deployment uses the given update strategy (e.g. "Recreate" for
   *  single-GPU workloads). Returns true if it patched, false if already set. */
  ensureDeploymentStrategy?(ns: string, deployment: string, type: "Recreate" | "RollingUpdate"): Promise<boolean>;
}

/** Real adapter backed by the in-cluster VIOS HTTP API via the vst.ts helpers. */
export class VstClusterAdapter implements ClusterAdapter {
  async listSensors(): Promise<AdapterSensor[]> {
    const { sensors, warning } = await vstListSensors();
    if (warning) return [];
    return sensors.map((s) => ({
      sensorId: s.sensor_id,
      name: typeof s.name === "string" ? s.name : s.sensor_id,
      rtspUrl: typeof s.rtsp_url === "string" ? s.rtsp_url : undefined,
    }));
  }

  async addSensor(
    name: string,
    rtspUrl: string,
    description?: string,
  ): Promise<{ ok: boolean; warning?: string }> {
    return vstAddSensor({ sensorId: name, rtspUrl, description });
  }
  // removeSensor intentionally omitted — convergence is additive-only here.

  async getDeploymentEnv(ns: string, deployment: string, key: string): Promise<string | null> {
    const d = await appsV1().readNamespacedDeployment({ name: deployment, namespace: ns });
    const env = d.spec?.template?.spec?.containers?.[0]?.env ?? [];
    const e = env.find((x) => x.name === key);
    return e?.value ?? null;
  }

  async patchDeploymentEnv(ns: string, deployment: string, key: string, value: string): Promise<void> {
    const d = await appsV1().readNamespacedDeployment({ name: deployment, namespace: ns });
    const container = d.spec?.template?.spec?.containers?.[0];
    if (!container) throw new Error(`deployment ${deployment} has no container[0]`);
    const env = container.env ? [...container.env] : [];
    const idx = env.findIndex((x) => x.name === key);
    if (idx >= 0) env[idx] = { name: key, value }; else env.push({ name: key, value });
    await appsV1().patchNamespacedDeployment({
      name: deployment, namespace: ns,
      body: { spec: { template: { spec: { containers: [{ name: container.name, env }] } } } },
    }, MERGE_PATCH_OPTS);
  }

  async getConfigMapKey(ns: string, cm: string, key: string): Promise<string | null> {
    try {
      const r = await readConfigMapKey(ns, cm, key);
      return r.raw ?? null;
    } catch {
      return null;
    }
  }

  async patchConfigMapKey(ns: string, cm: string, key: string, value: string): Promise<void> {
    await patchConfigMapRawKey(ns, cm, key, value);
  }

  async restartDeployment(ns: string, deployment: string): Promise<void> {
    await rolloutRestart("Deployment", ns, deployment);
  }

  async ensureDeploymentStrategy(ns: string, deployment: string, type: "Recreate" | "RollingUpdate"): Promise<boolean> {
    const d = await appsV1().readNamespacedDeployment({ name: deployment, namespace: ns });
    if (d.spec?.strategy?.type === type) return false;
    const strategy = type === "Recreate" ? { type, rollingUpdate: null } : { type };
    await appsV1().patchNamespacedDeployment({
      name: deployment, namespace: ns,
      body: { spec: { strategy } },
    }, MERGE_PATCH_OPTS);
    return true;
  }
}

import "server-only";

import { vstListSensors, vstDeleteSensor } from "@/lib/helpers/vst";
import { registerSensorAndArm } from "@/lib/helpers/vst-register";
import { appsV1, rolloutRestart, MERGE_PATCH_OPTS } from "@/lib/k8s";
import { readConfigMapKey, patchConfigMapRawKey } from "@/lib/helpers/configmaps";
import {
  listRealtimeRules as abList,
  addRealtimeRule as abAdd,
  deleteRealtimeRule as abDelete,
} from "@/lib/helpers/alert-bridge";

/** A live sensor as the reconciler sees it (subset of VstSensor, renamed). */
export interface AdapterSensor {
  /** Identity key — the camera NAME on the k8s path (used for desired-vs-live
   *  matching). NOT safe as a VST delete key; use `uuid`. */
  sensorId: string;
  /** Real VIOS UUID for lifecycle ops (delete). Falls back to sensorId when the
   *  source didn't surface a distinct UUID. */
  uuid?: string;
  name: string;
  rtspUrl?: string;
  /** VST's lifecycle state, normalised by vstListSensors from the API's `state`
   *  field. `"removed"` is a TOMBSTONE, not a sensor: VST keeps deleted sensors in
   *  /sensor/list rather than dropping them, so a caller that ignores this counts
   *  every camera ever deleted as still present. */
  status?: string;
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
  /** Rollout-restart the VST streamprocessing workload (StatefulSet or Deployment
   *  per CLUSTER.vst.streamProcessingKind). Escalation path for the pod-global
   *  recorder stall: a fresh boot re-registers every sensor from always_recording=true,
   *  which per-sensor delete+re-add can't fix when the whole recorder process is wedged. */
  restartStreamProcessing?(): Promise<void>;
  /** Ensure a Deployment uses the given update strategy (e.g. "Recreate" for
   *  single-GPU workloads). Returns true if it patched, false if already set. */
  ensureDeploymentStrategy?(ns: string, deployment: string, type: "Recreate" | "RollingUpdate"): Promise<boolean>;
  /** List all realtime alert rules. */
  listRealtimeRules?(): Promise<{ id: string; liveStreamUrl: string; alertType: string; prompt?: string }[]>;
  /** Create a realtime alert rule. */
  addRealtimeRule?(input: { streamUrl: string; alertType: string; prompt: string; sensorName?: string; systemPrompt?: string; model?: string }): Promise<{ ok: boolean; id?: string; warning?: string }>;
  /** Delete a realtime alert rule by id. */
  deleteRealtimeRule?(id: string): Promise<{ ok: boolean; warning?: string }>;
}

/** Real adapter backed by the in-cluster VIOS HTTP API via the vst.ts helpers. */
export class VstClusterAdapter implements ClusterAdapter {
  async listSensors(): Promise<AdapterSensor[]> {
    const { sensors, warning } = await vstListSensors();
    if (warning) return [];
    return sensors.map((s) => ({
      sensorId: s.sensor_id,
      uuid: typeof s.sensor_uuid === "string" ? s.sensor_uuid : undefined,
      name: typeof s.name === "string" ? s.name : s.sensor_id,
      rtspUrl: typeof s.rtsp_url === "string" ? s.rtsp_url : undefined,
      status: s.status,
    }));
  }

  async addSensor(
    name: string,
    rtspUrl: string,
    description?: string,
  ): Promise<{ ok: boolean; warning?: string }> {
    // Step 1: register metadata. Step 2: start the recording pipeline
    // (proxy/stream/add) — required for the recorder to actually record;
    // no-op where the proxy endpoint is unset (legacy path).
    const res = await registerSensorAndArm({ name, rtspUrl, description });
    return res.warnings.length
      ? { ok: res.ok, warning: res.warnings.join("; ") }
      : { ok: res.ok };
  }

  // De-register a live sensor by its VIOS UUID. Used to "park" disabled cameras
  // (recording.enabled === false) so VIOS/streamprocessing stops retrying an
  // unconnectable stream, and by the opt-in prune path. The steady-state loop
  // runs prune=false, so this only fires for explicit desired-state parking.
  async removeSensor(sensorId: string): Promise<{ ok: boolean; warning?: string }> {
    return vstDeleteSensor(sensorId);
  }

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

  async restartStreamProcessing(): Promise<void> {
    const { CLUSTER } = await import("@/lib/cluster-refs");
    await rolloutRestart(
      CLUSTER.vst.streamProcessingKind,
      CLUSTER.vst.namespace,
      CLUSTER.vst.streamProcessingDeployment,
    );
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

  async listRealtimeRules(): Promise<{ id: string; liveStreamUrl: string; alertType: string; prompt?: string }[]> {
    const { rules } = await abList();
    return rules.map((r) => ({
      id: r.id,
      liveStreamUrl: r.live_stream_url,
      alertType: r.alert_type,
      prompt: r.prompt,
    }));
  }

  async addRealtimeRule(input: { streamUrl: string; alertType: string; prompt: string; sensorName?: string; systemPrompt?: string; model?: string }): Promise<{ ok: boolean; id?: string; warning?: string }> {
    return abAdd(input);
  }

  async deleteRealtimeRule(id: string): Promise<{ ok: boolean; warning?: string }> {
    return abDelete(id);
  }
}

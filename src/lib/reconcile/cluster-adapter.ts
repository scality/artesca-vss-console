import "server-only";

import { vstListSensors, vstAddSensor } from "@/lib/helpers/vst";

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
}

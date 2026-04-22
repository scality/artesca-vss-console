import "server-only";
import { CLUSTER } from "../cluster-refs";

// sensor-ms exposes its HTTP API on port 30000 (k8s/vst/30-sensor-ms.yaml).
// The original default used port 5010, which sensor-ms does not expose.
const VST_BASE = CLUSTER.vst.sensorUrl;

export interface VstSensor {
  sensor_id: string;
  name?: string;
  rtsp_url?: string;
  status?: string;
  [key: string]: unknown;
}

/** List all sensors registered in VST. */
export async function vstListSensors(): Promise<{
  sensors: VstSensor[];
  warning?: string;
}> {
  try {
    const resp = await fetch(`${VST_BASE}/list`, {
      next: { revalidate: 0 },
      signal: AbortSignal.timeout(5_000),
    });

    if (!resp.ok) {
      return {
        sensors: [],
        warning: `VST sensor-ms returned HTTP ${resp.status}`,
      };
    }

    const json = (await resp.json()) as { sensors?: VstSensor[] } | VstSensor[];

    const sensors = Array.isArray(json)
      ? json
      : (json as { sensors?: VstSensor[] }).sensors ?? [];

    return { sensors };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[vst] unreachable: ${msg}`);
    return { sensors: [], warning: `VST sensor-ms unreachable: ${msg}` };
  }
}

/** Delete a sensor from VST. */
export async function vstDeleteSensor(
  sensorId: string
): Promise<{ ok: boolean; warning?: string }> {
  try {
    const resp = await fetch(`${VST_BASE}/${encodeURIComponent(sensorId)}`, {
      method: "DELETE",
      next: { revalidate: 0 },
      signal: AbortSignal.timeout(10_000),
    });

    if (!resp.ok) {
      return {
        ok: false,
        warning: `VST delete returned HTTP ${resp.status}`,
      };
    }

    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, warning: `VST delete failed: ${msg}` };
  }
}

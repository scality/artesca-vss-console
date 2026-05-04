import "server-only";
import { CLUSTER } from "../cluster-refs";

// sensor-ms exposes its HTTP API on port 30000 (k8s/nvidia-vss/vst/30-sensor-ms.yaml).
// The original default used port 5010, which sensor-ms does not expose.
const VST_BASE = CLUSTER.vst.sensorUrl;

export interface VstSensor {
  sensor_id: string;
  name?: string;
  rtsp_url?: string;
  status?: string;
  [key: string]: unknown;
}

/** List all sensors registered in VST. Supports both the k8s sensor-ms /list
 *  shape (`{sensors: [...]} | [...]`) and the docker-compose vst-ingress
 *  /vst/api/v1/sensor/streams shape (an array of objects keyed by streamId
 *  containing one element each — `{name, streamId, url, type, metadata}`).
 *  The endpoint is selected by VST_SENSOR_LIST_URL: when the URL ends with
 *  `/sensor/streams` we parse the docker shape, otherwise the k8s shape. */
export async function vstListSensors(): Promise<{
  sensors: VstSensor[];
  warning?: string;
}> {
  // Prefer the explicit VST_SENSOR_LIST_URL when set (docker path); fall
  // back to `${VST_BASE}/list` (legacy k8s path).
  const url = CLUSTER.vst.sensorListUrl ?? `${VST_BASE}/list`;
  const isDockerStreamsShape = /\/sensor\/streams\b/.test(url);
  try {
    const resp = await fetch(url, {
      next: { revalidate: 0 },
      signal: AbortSignal.timeout(15_000),
    });

    if (!resp.ok) {
      return {
        sensors: [],
        warning: `VST sensor-ms returned HTTP ${resp.status}`,
      };
    }

    const json = await resp.json();

    if (isDockerStreamsShape) {
      // [{<streamId>: [<streamObj>]}, ...] → flatten to VstSensor[].
      const sensors: VstSensor[] = [];
      const arr = Array.isArray(json) ? json : [];
      for (const entry of arr) {
        if (!entry || typeof entry !== "object") continue;
        for (const streams of Object.values(entry as Record<string, unknown>)) {
          if (!Array.isArray(streams)) continue;
          for (const s of streams) {
            if (!s || typeof s !== "object") continue;
            const o = s as Record<string, unknown>;
            sensors.push({
              sensor_id: typeof o.name === "string" ? o.name : String(o.streamId ?? ""),
              name: typeof o.name === "string" ? o.name : undefined,
              rtsp_url: typeof o.url === "string" ? o.url : undefined,
              status: typeof o.type === "string" ? o.type : undefined,
              ...(o.metadata && typeof o.metadata === "object" ? { metadata: o.metadata } : {}),
              streamId: o.streamId,
            });
          }
        }
      }
      return { sensors };
    }

    // k8s sensor-ms /list shape — array or {sensors: [...]}.
    const sensors = Array.isArray(json)
      ? (json as VstSensor[])
      : (json as { sensors?: VstSensor[] }).sensors ?? [];
    return { sensors };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[vst] unreachable: ${msg}`);
    return { sensors: [], warning: `VST sensor-ms unreachable: ${msg}` };
  }
}

/** Add (register) a sensor in VST.  Returns ok=true on 2xx and on 409
 *  (already registered — idempotent).  Returns ok=false with a warning
 *  string on any other failure; does not throw. */
export async function vstAddSensor(input: {
  sensorId: string;
  rtspUrl: string;
  description?: string;
}): Promise<{ ok: boolean; warning?: string }> {
  const body: Record<string, string> = {
    sensorUrl: input.rtspUrl,
    name: input.sensorId,
  };
  if (input.description) body.location = input.description;

  try {
    const resp = await fetch(CLUSTER.vst.sensorAddUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      next: { revalidate: 0 },
      signal: AbortSignal.timeout(15_000),
    });

    // 409 = already registered — treat as success (idempotent).
    if (resp.status === 409) return { ok: true };

    if (!resp.ok) {
      return {
        ok: false,
        warning: `VST add returned HTTP ${resp.status} for sensor ${input.sensorId}`,
      };
    }

    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, warning: `VST add failed for ${input.sensorId}: ${msg}` };
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

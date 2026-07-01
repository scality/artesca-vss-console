import "server-only";
import { CLUSTER } from "../cluster-refs";
import { createLogger } from "@/lib/logger";

const log = createLogger("vst");

// sensor-ms exposes its HTTP API on port 30000 (k8s/nvidia-vss/vst/30-sensor-ms.yaml).
// The original default used port 5010, which sensor-ms does not expose.
const VST_BASE = CLUSTER.vst.sensorUrl;

export interface VstSensor {
  sensor_id: string;
  name?: string;
  rtsp_url?: string;
  /** Source host VST is pulling from (RTSP camera / camera-sim). Present in the
   *  k8s sensor-ms shape as `sensorIp`; lets callers reconstruct the RTSP URL
   *  (`rtsp://<sensorIp>:8554/<name>`) when the explicit URL isn't persisted. */
  sensorIp?: string;
  status?: string;
  /** VST has a recorded timeline for this sensor — i.e. recording is actively
   *  producing segments. False = registered/live but NOT recording. */
  isTimelinePresent?: boolean;
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

    // k8s sensor-ms /list shape — array (or {sensors:[...]}) of VST sensor
    // objects keyed by `name` (= the camera id) with a UUID `sensorId`. Map
    // them to VstSensor so `sensor_id` carries the matching key (the name). A
    // raw cast leaves sensor_id undefined (the response is camelCase sensorId),
    // which makes every camera read as "not registered" (PENDING-RESTORE).
    const rawList = Array.isArray(json)
      ? json
      : ((json as { sensors?: unknown[] }).sensors ?? []);
    const sensors: VstSensor[] = (rawList as Array<Record<string, unknown>>)
      .filter((o) => o && typeof o === "object")
      .map((o) => ({
        sensor_id:
          typeof o.name === "string"
            ? o.name
            : String(o.sensorId ?? o.sensor_id ?? ""),
        name: typeof o.name === "string" ? o.name : undefined,
        rtsp_url: typeof o.rtsp_url === "string" ? o.rtsp_url : undefined,
        sensorIp: typeof o.sensorIp === "string" ? o.sensorIp : undefined,
        status:
          typeof o.state === "string"
            ? o.state
            : typeof o.status === "string"
              ? o.status
              : undefined,
        isTimelinePresent:
          typeof o.isTimelinePresent === "boolean" ? o.isTimelinePresent : undefined,
        streamId: o.sensorId ?? o.streamId,
      }));
    return { sensors };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn("unreachable", { err });
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

/** Start recording a stream via the streamprocessing-ms proxy endpoint.
 *  Docker-path only — returns ok:true immediately when proxyStreamAddUrl is empty (k8s path). */
export async function vstStartStream(input: {
  sensorId: string;
  rtspUrl: string;
}): Promise<{ ok: boolean; warning?: string }> {
  const url = CLUSTER.vst.proxyStreamAddUrl;
  if (!url) return { ok: true };

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: input.rtspUrl, id: input.sensorId, name: input.sensorId }),
      next: { revalidate: 0 },
      signal: AbortSignal.timeout(15_000),
    });
    if (resp.status === 409) return { ok: true };
    if (!resp.ok) {
      return {
        ok: false,
        warning: `proxy/stream/add HTTP ${resp.status} for ${input.sensorId}`,
      };
    }
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, warning: `proxy/stream/add failed for ${input.sensorId}: ${msg}` };
  }
}

/** Stop recording a stream via the streamprocessing-ms proxy endpoint.
 *  Symmetric to vstStartStream: tears down the recording pipeline for the
 *  sensor (clears sensor_details.url) while leaving the sensor itself
 *  registered + live — only recording stops.
 *  Returns ok:true immediately when proxyStreamRemoveUrl is empty (k8s path).
 *  404 = stream not currently recording — treated as success (idempotent). */
export async function vstStopStream(input: {
  sensorId: string;
}): Promise<{ ok: boolean; warning?: string }> {
  const url = CLUSTER.vst.proxyStreamRemoveUrl;
  if (!url) return { ok: true };

  try {
    const resp = await fetch(url, {
      // VST 3.2 proxy/stream/remove is a DELETE (POST → 405 Method Not Allowed).
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: input.sensorId, name: input.sensorId }),
      next: { revalidate: 0 },
      signal: AbortSignal.timeout(15_000),
    });
    // 404 = not currently recording — idempotent success.
    if (resp.status === 404) return { ok: true };
    if (!resp.ok) {
      return {
        ok: false,
        warning: `proxy/stream/remove HTTP ${resp.status} for ${input.sensorId}`,
      };
    }
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, warning: `proxy/stream/remove failed for ${input.sensorId}: ${msg}` };
  }
}

/** Apply a recording on/off change for a sensor on the VST.
 *  enabled=true  → vstStartStream (arms the recording pipeline; needs rtspUrl).
 *  enabled=false → vstStopStream  (tears the recording pipeline down).
 *  The sensor stays registered + live in both cases — only recording changes.
 *  Returns ok=false with a warning string on failure; never throws. On the
 *  k8s path both proxy URLs are empty, so this is a no-op (ok:true) — recording
 *  is governed by the VST config there, not the proxy endpoint. */
export async function setRecording(
  sensorId: string,
  enabled: boolean,
  rtspUrl?: string,
): Promise<{ ok: boolean; warning?: string }> {
  // k8s path: the proxy add/remove endpoints are empty, so a recording toggle
  // can't be applied here — recording is governed by sensor presence (VST starts
  // recording when the sensor is registered). Surface that instead of silently
  // reporting success, so the operator isn't misled.
  if (!CLUSTER.vst.proxyStreamAddUrl && !CLUSTER.vst.proxyStreamRemoveUrl) {
    return {
      ok: true,
      warning: `recording toggle is not available on this deploy — recording follows sensor presence; use Add/Remove camera to ${enabled ? "start" : "stop"} recording for ${sensorId}`,
    };
  }
  if (enabled) {
    if (!rtspUrl) {
      return {
        ok: false,
        warning: `cannot start recording for ${sensorId}: no RTSP URL known`,
      };
    }
    return vstStartStream({ sensorId, rtspUrl });
  }
  return vstStopStream({ sensorId });
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

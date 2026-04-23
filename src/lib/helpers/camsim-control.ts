import "server-only";

/**
 * Thin client for the camera-sim control-plane HTTP API (:8080).
 *
 * The camera-sim EC2 runs a vanilla-Python service (camera-sim/control-plane.py)
 * that owns cameras.yaml + mediamtx.yml and triggers `systemctl restart
 * camera-sim` on mutations. Using this API instead of the old SCP + ConfigMap
 * + Kubernetes Job dance means:
 *   - One HTTP call adds a camera (was: SCP → patch CM → ssh systemctl → create Job)
 *   - No Kubernetes RBAC surface for camera management
 *   - No separate job-logs SSE stream — calls are synchronous (~10s)
 *   - Same API is used by the laptop infra dashboard (web/ at :5002) so the
 *     two consoles agree on state.
 *
 * Env contract:
 *   CAMERA_SIM_HOST          — EC2 public IP (required; no fallback)
 *   CAMERA_SIM_CONTROL_URL   — overrides the derived http://${HOST}:8080
 */

const DEFAULT_TIMEOUT_MS = 30_000;
const RESTART_TIMEOUT_MS = 90_000;

export interface CamsimControlCamera {
  name: string;
  source: string;
  description?: string;
  staged: boolean;
}

export class CamsimControlError extends Error {
  readonly status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.name = "CamsimControlError";
    this.status = status;
  }
}

function controlBaseUrl(): string {
  const override = process.env.CAMERA_SIM_CONTROL_URL;
  if (override) return override.replace(/\/$/, "");
  const host = process.env.CAMERA_SIM_HOST;
  if (!host || host === "<camera-sim-public-ip>") {
    throw new CamsimControlError(
      "CAMERA_SIM_HOST is not set on the console pod (or still holds the literal placeholder). " +
        "Set it to the camera-sim EC2's public IP in the console-env ConfigMap.",
      503,
    );
  }
  return `http://${host}:8080`;
}

export function controlPlaneHost(): string {
  const override = process.env.CAMERA_SIM_CONTROL_URL;
  if (override) {
    try {
      return new URL(override).hostname;
    } catch {
      // Fall through to HOST env.
    }
  }
  const host = process.env.CAMERA_SIM_HOST;
  if (!host || host === "<camera-sim-public-ip>") {
    throw new CamsimControlError(
      "CAMERA_SIM_HOST is not set on the console pod.",
      503,
    );
  }
  return host;
}

async function call<T>(
  path: string,
  init: RequestInit = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  const url = `${controlBaseUrl()}${path}`;
  let resp: Response;
  try {
    resp = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
  } catch (err) {
    throw new CamsimControlError(
      `Camera-sim control-plane unreachable at ${url}: ${
        err instanceof Error ? err.message : String(err)
      }. Check the EC2 is running and SG :8080 ingress includes the ARTESCA pub IP.`,
      502,
    );
  }
  if (!resp.ok) {
    let detail = "";
    try {
      const j = (await resp.json()) as { error?: string; hint?: string };
      detail = [j.error, j.hint].filter(Boolean).join(" — ");
    } catch {
      detail = await resp.text().catch(() => "");
    }
    throw new CamsimControlError(
      `Control-plane ${init.method ?? "GET"} ${path} returned HTTP ${resp.status}${
        detail ? `: ${detail.slice(0, 300)}` : ""
      }`,
      resp.status,
    );
  }
  return (await resp.json()) as T;
}

export async function camsimHealth(): Promise<{ ok: boolean; version: string }> {
  return call<{ ok: boolean; version: string }>("/health");
}

export async function camsimListCameras(): Promise<CamsimControlCamera[]> {
  const r = await call<{ cameras: CamsimControlCamera[] }>("/cameras");
  return r.cameras;
}

export async function camsimAddCamera(input: {
  name: string;
  source: string;
  description?: string;
}): Promise<{ camera: CamsimControlCamera; restart: { ok: boolean; output: string } }> {
  return call(
    "/cameras",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    },
    RESTART_TIMEOUT_MS,
  );
}

export async function camsimDeleteCamera(name: string): Promise<{
  deleted: string;
  remaining: number;
  restart: { ok: boolean; output: string };
}> {
  return call(
    `/cameras/${encodeURIComponent(name)}`,
    { method: "DELETE" },
    RESTART_TIMEOUT_MS,
  );
}

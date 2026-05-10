import "server-only";
import { CLUSTER } from "../cluster-refs";
import { createLogger } from "@/lib/logger";

const log = createLogger("mediamtx");

// mediamtx REST API is on port 9997 of the camera-sim host
// (k8s/nvidia-vss/pyramid-ingress/21-replay-server.yaml).  Override via MEDIAMTX_API_URL
// or set CAMERA_SIM_HOST to the EC2 public IP/DNS.
const MEDIAMTX_API = CLUSTER.mediamtx.apiUrl;

export interface MediamtxPath {
  name: string;
  ready: boolean;
  readyTime?: string;
  tracks?: string[];
  bytesReceived?: number;
  bytesSent?: number;
  readers?: Array<{ type: string; id: string }>;
  [key: string]: unknown;
}

export interface MediamtxPathsResponse {
  items: MediamtxPath[];
  pageCount?: number;
}

/** List all paths on mediamtx. Returns empty list if unreachable. */
export async function mediamtxListPaths(): Promise<{
  paths: MediamtxPath[];
  warning?: string;
}> {
  try {
    const resp = await fetch(`${MEDIAMTX_API}/v3/paths/list`, {
      next: { revalidate: 0 },
      signal: AbortSignal.timeout(5_000),
    });

    if (!resp.ok) {
      return {
        paths: [],
        warning: `mediamtx returned HTTP ${resp.status}`,
      };
    }

    const json = (await resp.json()) as MediamtxPathsResponse | MediamtxPath[];

    const paths = Array.isArray(json)
      ? json
      : (json as MediamtxPathsResponse).items ?? [];

    return { paths };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn("unreachable", { err });
    return { paths: [], warning: `mediamtx unreachable: ${msg}` };
  }
}

/** Get status for a single path. */
export async function mediamtxPathStatus(
  pathName: string
): Promise<{ path: MediamtxPath | null; warning?: string }> {
  try {
    const resp = await fetch(
      `${MEDIAMTX_API}/v3/paths/get/${encodeURIComponent(pathName)}`,
      {
        next: { revalidate: 0 },
        signal: AbortSignal.timeout(5_000),
      }
    );

    if (!resp.ok) {
      return {
        path: null,
        warning: `mediamtx path ${pathName} returned HTTP ${resp.status}`,
      };
    }

    const path = (await resp.json()) as MediamtxPath;
    return { path };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { path: null, warning: `mediamtx path query failed: ${msg}` };
  }
}

// Re-export base URL helper for use in other helpers
export { MEDIAMTX_API };

import "server-only";
import { execFile as execFileCb } from "child_process";
import { promisify } from "util";
import * as os from "os";
import * as path from "path";
import * as fs from "fs/promises";

const execFile = promisify(execFileCb);
const GCS_TIMEOUT_MS = 15_000;

const GCS_CONFIG_BUCKET =
  process.env.GCS_CONFIG_BUCKET ?? "scality-isv-labs-config";

// ─── Public interfaces ────────────────────────────────────────────────────────

export interface CameraEntry {
  id: string;
  rtspUrl: string;
  description?: string;
  role?: string;
}

export interface CameraList {
  schema: "isv-labs.cameras.v1";
  instance: string;
  updatedAt: string;
  updatedBy: string;
  cameras: CameraEntry[];
}

export type GcsHealthStatus =
  | "ok"
  | "no-credentials"
  | "no-gsutil"
  | "error";

export interface GcsHealthResult {
  status: GcsHealthStatus;
  detail?: string;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function gsObjectUrl(instance: string): string {
  return `gs://${GCS_CONFIG_BUCKET}/cameras/${instance}.json`;
}

function gsPromptUrl(instance: string): string {
  return `gs://${GCS_CONFIG_BUCKET}/prompt/${instance}.json`;
}

function gsScenariosUrl(instance: string): string {
  return `gs://${GCS_CONFIG_BUCKET}/scenarios/${instance}.json`;
}

/** Run a gsutil command with the configured credential env and a 15s timeout. */
async function runGsutil(
  args: string[],
  input?: string,
): Promise<{ stdout: string; stderr: string }> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
  };

  // execFile accepts AbortSignal via options.signal in Node 16+; we use a
  // timeout option instead for simplicity — maps to the same SIGTERM.
  try {
    const result = await execFile("gsutil", args, {
      env,
      timeout: GCS_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024, // 4 MB — generous for a camera list JSON
      // When writing, we write via a temp file, not stdin, so input is unused.
      ...(input !== undefined ? { input } : {}),
    });
    return { stdout: result.stdout, stderr: result.stderr };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: string | number; killed?: boolean };
    const stderr = e.stderr ?? "";
    const killed = e.killed ?? false;
    if (killed) {
      throw new GcsConfigError("gsutil timed out after 15 s", "timeout");
    }
    throw new GcsConfigError(
      `gsutil exited with code ${e.code}: ${stderr.slice(0, 500)}`,
      "gsutil-error",
    );
  }
}

// ─── Error class ──────────────────────────────────────────────────────────────

export class GcsConfigError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "GcsConfigError";
    this.code = code;
  }
}

// ─── Schema validation ────────────────────────────────────────────────────────

function isValidPromptConfig(obj: unknown): obj is PromptConfig {
  if (!obj || typeof obj !== "object") return false;
  const o = obj as Record<string, unknown>;
  if (o["schema"] !== "isv-labs.prompt.v1") return false;
  if (typeof o["instance"] !== "string") return false;
  if (typeof o["updatedAt"] !== "string") return false;
  if (typeof o["updatedBy"] !== "string") return false;
  if (typeof o["prompt"] !== "string") return false;
  return true;
}

function isValidScenariosConfig(obj: unknown): obj is ScenariosConfig {
  if (!obj || typeof obj !== "object") return false;
  const o = obj as Record<string, unknown>;
  if (o["schema"] !== "isv-labs.scenarios.v1") return false;
  if (typeof o["instance"] !== "string") return false;
  if (typeof o["updatedAt"] !== "string") return false;
  if (typeof o["updatedBy"] !== "string") return false;
  if (!Array.isArray(o["scenarios"])) return false;
  for (const s of o["scenarios"] as unknown[]) {
    if (!s || typeof s !== "object") return false;
    const sc = s as Record<string, unknown>;
    if (typeof sc["id"] !== "string") return false;
    if (typeof sc["name"] !== "string") return false;
  }
  return true;
}

function isValidCameraList(obj: unknown): obj is CameraList {
  if (!obj || typeof obj !== "object") return false;
  const o = obj as Record<string, unknown>;
  if (o["schema"] !== "isv-labs.cameras.v1") return false;
  if (typeof o["instance"] !== "string") return false;
  if (typeof o["updatedAt"] !== "string") return false;
  if (typeof o["updatedBy"] !== "string") return false;
  if (!Array.isArray(o["cameras"])) return false;
  for (const cam of o["cameras"] as unknown[]) {
    if (!cam || typeof cam !== "object") return false;
    const c = cam as Record<string, unknown>;
    if (typeof c["id"] !== "string") return false;
    if (typeof c["rtspUrl"] !== "string") return false;
  }
  return true;
}

// ─── Prompt interfaces ────────────────────────────────────────────────────────

export interface PromptConfig {
  schema: "isv-labs.prompt.v1";
  instance: string;
  updatedAt: string;
  updatedBy: string;
  prompt: string;
  model?: string;
}

// ─── Scenarios interfaces ─────────────────────────────────────────────────────

export interface ScenarioConfig {
  id: string;
  name: string;
  description?: string;
  severity: "low" | "medium" | "high" | "critical";
  channels: ("ui" | "slack")[];
  sensor_filter: string;
  keywords: string[];
  enabled: boolean;
  cooldown_seconds?: number;
}

export interface ScenariosConfig {
  schema: "isv-labs.scenarios.v1";
  instance: string;
  updatedAt: string;
  updatedBy: string;
  scenarios: ScenarioConfig[];
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Returns the camera list from GCS, or null if:
 * - The object does not exist (404-like errors from gsutil).
 * - GCS is unreachable (timeout, auth failure).
 * - The payload fails schema validation.
 *
 * Never throws — callers always fall back to VST.
 */
export async function gcsCamerasGet(
  instance: string,
): Promise<CameraList | null> {
  try {
    const { stdout } = await runGsutil(["cat", gsObjectUrl(instance)]);
    const obj: unknown = JSON.parse(stdout);
    if (!isValidCameraList(obj)) {
      console.warn(
        `[gcs-config] schema mismatch for ${instance}: ` +
          `expected isv-labs.cameras.v1, got schema=${
            obj && typeof obj === "object" ? (obj as Record<string, unknown>)["schema"] : "unknown"
          }`,
      );
      return null;
    }
    return obj;
  } catch (err) {
    if (err instanceof GcsConfigError) {
      // "No URLs matched" = object does not exist; that's expected on first run.
      const isNotFound =
        err.message.includes("No URLs matched") ||
        err.message.includes("404") ||
        err.message.includes("does not exist");
      if (!isNotFound) {
        console.warn(`[gcs-config] gcsCamerasGet(${instance}): ${err.message}`);
      }
      return null;
    }
    if (err instanceof SyntaxError) {
      console.warn(`[gcs-config] gcsCamerasGet(${instance}): invalid JSON in GCS object`);
      return null;
    }
    console.warn(
      `[gcs-config] gcsCamerasGet(${instance}): unexpected error: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
}

/**
 * Write the camera list to GCS via a temp file.  gsutil cp reads from a
 * local file — avoids any stdin/piping complexity.
 *
 * Stamps `updatedAt` on the object before writing.
 * Reads `updatedBy` from process.env.UPDATED_BY ?? 'unknown' (overridden by
 * the route layer before calling, e.g. from session.user.email).
 *
 * Throws GcsConfigError on failure — callers surface the message in the API
 * response but do NOT roll back the VST operation.
 */
export async function gcsCamerasPut(list: CameraList): Promise<void> {
  const stamped: CameraList = {
    ...list,
    updatedAt: new Date().toISOString(),
    updatedBy: process.env.UPDATED_BY ?? "unknown",
  };

  // Write to a temp file, then gsutil cp it.
  const tmpFile = path.join(os.tmpdir(), `gcs-cameras-${Date.now()}.json`);
  try {
    await fs.writeFile(tmpFile, JSON.stringify(stamped, null, 2), "utf-8");
    await runGsutil(["cp", tmpFile, gsObjectUrl(list.instance)]);
  } finally {
    await fs.unlink(tmpFile).catch(() => void 0);
  }
}

/**
 * Health check — returns the GCS availability status for display in the About
 * page and for the bootstrap logic to gate on.
 */
export async function gcsHealthCheck(): Promise<GcsHealthResult> {
  // 1. Check that gsutil exists.
  try {
    await execFile("gsutil", ["version"], { timeout: 5_000 });
  } catch (err) {
    const e = err as { code?: string | number };
    if (e.code === "ENOENT") {
      return { status: "no-gsutil", detail: "gsutil not found in PATH" };
    }
    // Any other error at version check = treat as no-gsutil.
    return {
      status: "no-gsutil",
      detail: `gsutil version check failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // 2. Check credentials by attempting a metadata fetch on the bucket.
  //    `gsutil ls gs://bucket` returns 0 if the bucket is accessible.
  try {
    await runGsutil(["ls", `gs://${GCS_CONFIG_BUCKET}/cameras/`]);
    return { status: "ok" };
  } catch (err) {
    if (err instanceof GcsConfigError) {
      // "AccessDeniedException" or similar = have gsutil but no valid creds.
      const noAuth =
        err.message.includes("AccessDeniedException") ||
        err.message.includes("401") ||
        err.message.includes("403") ||
        err.message.includes("credentials");
      if (noAuth) {
        return {
          status: "no-credentials",
          detail: "GCS credentials missing or insufficient (check GOOGLE_APPLICATION_CREDENTIALS)",
        };
      }
      // 404 on the path prefix is OK — bucket exists, no cameras yet.
      const notFound =
        err.message.includes("404") ||
        err.message.includes("No URLs matched") ||
        err.message.includes("BucketNotFoundException");
      if (notFound) {
        return {
          status: "ok",
          detail: "bucket reachable (cameras/ prefix not yet populated)",
        };
      }
      return { status: "error", detail: err.message.slice(0, 300) };
    }
    return {
      status: "error",
      detail: err instanceof Error ? err.message.slice(0, 300) : String(err),
    };
  }
}

// ─── Prompt helpers ───────────────────────────────────────────────────────────

/** Returns the prompt config from GCS, or null if missing / schema mismatch / unreachable. */
export async function gcsPromptGet(instance: string): Promise<PromptConfig | null> {
  try {
    const { stdout } = await runGsutil(["cat", gsPromptUrl(instance)]);
    const obj: unknown = JSON.parse(stdout);
    if (!isValidPromptConfig(obj)) {
      console.warn(
        `[gcs-config] schema mismatch for prompt/${instance}: ` +
          `expected isv-labs.prompt.v1, got schema=${
            obj && typeof obj === "object" ? (obj as Record<string, unknown>)["schema"] : "unknown"
          }`,
      );
      return null;
    }
    return obj;
  } catch (err) {
    if (err instanceof GcsConfigError) {
      const isNotFound =
        err.message.includes("No URLs matched") ||
        err.message.includes("404") ||
        err.message.includes("does not exist");
      if (!isNotFound) {
        console.warn(`[gcs-config] gcsPromptGet(${instance}): ${err.message}`);
      }
      return null;
    }
    if (err instanceof SyntaxError) {
      console.warn(`[gcs-config] gcsPromptGet(${instance}): invalid JSON in GCS object`);
      return null;
    }
    console.warn(
      `[gcs-config] gcsPromptGet(${instance}): unexpected error: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
}

/** Write the prompt config to GCS via a temp file. Stamps updatedAt. Throws GcsConfigError on failure. */
export async function gcsPromptPut(config: PromptConfig): Promise<void> {
  const stamped: PromptConfig = {
    ...config,
    updatedAt: new Date().toISOString(),
  };
  const tmpFile = path.join(os.tmpdir(), `gcs-prompt-${Date.now()}.json`);
  try {
    await fs.writeFile(tmpFile, JSON.stringify(stamped, null, 2), "utf-8");
    await runGsutil(["cp", tmpFile, gsPromptUrl(config.instance)]);
  } finally {
    await fs.unlink(tmpFile).catch(() => void 0);
  }
}

// ─── Scenarios helpers ────────────────────────────────────────────────────────

/** Returns the scenarios config from GCS, or null if missing / schema mismatch / unreachable. */
export async function gcsScenariosGet(instance: string): Promise<ScenariosConfig | null> {
  try {
    const { stdout } = await runGsutil(["cat", gsScenariosUrl(instance)]);
    const obj: unknown = JSON.parse(stdout);
    if (!isValidScenariosConfig(obj)) {
      console.warn(
        `[gcs-config] schema mismatch for scenarios/${instance}: ` +
          `expected isv-labs.scenarios.v1, got schema=${
            obj && typeof obj === "object" ? (obj as Record<string, unknown>)["schema"] : "unknown"
          }`,
      );
      return null;
    }
    return obj;
  } catch (err) {
    if (err instanceof GcsConfigError) {
      const isNotFound =
        err.message.includes("No URLs matched") ||
        err.message.includes("404") ||
        err.message.includes("does not exist");
      if (!isNotFound) {
        console.warn(`[gcs-config] gcsScenariosGet(${instance}): ${err.message}`);
      }
      return null;
    }
    if (err instanceof SyntaxError) {
      console.warn(`[gcs-config] gcsScenariosGet(${instance}): invalid JSON in GCS object`);
      return null;
    }
    console.warn(
      `[gcs-config] gcsScenariosGet(${instance}): unexpected error: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
}

/** Write the scenarios config to GCS via a temp file. Stamps updatedAt. Throws GcsConfigError on failure. */
export async function gcsScenariosPut(config: ScenariosConfig): Promise<void> {
  const stamped: ScenariosConfig = {
    ...config,
    updatedAt: new Date().toISOString(),
  };
  const tmpFile = path.join(os.tmpdir(), `gcs-scenarios-${Date.now()}.json`);
  try {
    await fs.writeFile(tmpFile, JSON.stringify(stamped, null, 2), "utf-8");
    await runGsutil(["cp", tmpFile, gsScenariosUrl(config.instance)]);
  } finally {
    await fs.unlink(tmpFile).catch(() => void 0);
  }
}

import "server-only";
import { createSign } from "crypto";
import { readFileSync } from "fs";
import { z } from "zod";
import { createLogger } from "@/lib/logger";

const log = createLogger("gcs-config");

const GCS_TIMEOUT_MS = 15_000;

const GCS_CONFIG_BUCKET =
  process.env.GCS_CONFIG_BUCKET ?? "scality-isv-labs-config";

// ─── Public interfaces ────────────────────────────────────────────────────────

export interface CameraRecordingEntry {
  enabled: boolean;
  policy: "always" | "event-only" | "off";
  retentionDays: number;
}

export interface CameraEntry {
  id: string;
  rtspUrl: string;
  description?: string;
  role?: string;
  /** Per-camera scenario overrides (v2+).  undefined = sensor_filter glob.
   *  Empty array = explicit suppression. */
  scenarioIds?: string[];
  /** Bound detection prompt-set id; absent => not driven through the realtime API. */
  promptId?: string;
  recording?: CameraRecordingEntry;
}

export interface CameraList {
  schema: "isv-labs.cameras.v1" | "isv-labs.cameras.v2";
  instance: string;
  updatedAt: string;
  updatedBy: string;
  cameras: CameraEntry[];
}

export type GcsHealthStatus =
  | "ok"
  | "no-credentials"
  | "no-gcloud"
  | "error";

export interface GcsHealthResult {
  status: GcsHealthStatus;
  detail?: string;
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

// ─── Service-account JWT auth ─────────────────────────────────────────────────

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  private_key_id?: string;
  token_uri?: string;
}

const ServiceAccountKeySchema = z.object({
  private_key: z.string().min(1),
  client_email: z.string().min(1),
  token_uri: z.string().optional(),
  private_key_id: z.string().optional(),
});

const TokenExchangeSchema = z.object({
  access_token: z.string(),
  expires_in: z.number(),
});

interface TokenCache {
  token: string;
  expiresAt: number; // epoch ms
}

let _tokenCache: TokenCache | null = null;

function loadKey(): ServiceAccountKey | null {
  const credFile = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!credFile) return null;
  try {
    const parsed = ServiceAccountKeySchema.safeParse(JSON.parse(readFileSync(credFile, "utf-8")));
    if (!parsed.success) {
      throw new Error("invalid service-account key: " + parsed.error.message);
    }
    return parsed.data as ServiceAccountKey;
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("invalid service-account key:")) throw err;
    return null;
  }
}

function mintJwt(key: ServiceAccountKey): string {
  const now = Math.floor(Date.now() / 1000);
  const tokenUri = key.token_uri ?? "https://oauth2.googleapis.com/token";

  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", typ: "JWT", kid: key.private_key_id ?? "" }),
  ).toString("base64url");

  const payload = Buffer.from(
    JSON.stringify({
      iss: key.client_email,
      scope: "https://www.googleapis.com/auth/devstorage.read_write",
      aud: tokenUri,
      exp: now + 3600,
      iat: now,
    }),
  ).toString("base64url");

  const signing = `${header}.${payload}`;
  const sign = createSign("RSA-SHA256");
  sign.update(signing);
  const sig = sign.sign(key.private_key, "base64url");
  return `${signing}.${sig}`;
}

async function getAccessToken(): Promise<string> {
  if (_tokenCache && _tokenCache.expiresAt - Date.now() > 5 * 60 * 1000) {
    return _tokenCache.token;
  }

  const key = loadKey();
  if (!key) {
    throw new GcsConfigError(
      "GOOGLE_APPLICATION_CREDENTIALS not set or unreadable",
      "no-credentials",
    );
  }

  const tokenUri = key.token_uri ?? "https://oauth2.googleapis.com/token";
  const resp = await timedFetch(tokenUri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: mintJwt(key),
    }).toString(),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new GcsConfigError(
      `Token exchange failed (${resp.status}): ${body.slice(0, 200)}`,
      "no-credentials",
    );
  }

  const rawData: unknown = await resp.json();
  const tokenResult = TokenExchangeSchema.safeParse(rawData);
  if (!tokenResult.success) {
    throw new Error("token exchange returned unexpected shape");
  }
  const ttlMs = tokenResult.data.expires_in * 1000;
  _tokenCache = { token: tokenResult.data.access_token, expiresAt: Date.now() + ttlMs };
  return tokenResult.data.access_token;
}

// ─── Internal GCS REST helpers ────────────────────────────────────────────────

function timedFetch(url: string, init?: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), GCS_TIMEOUT_MS);
  return fetch(url, { ...init, signal: ctrl.signal }).finally(() =>
    clearTimeout(timer),
  );
}

/** Read a GCS object, returning its text body. Throws GcsConfigError. */
async function gcsGet(bucket: string, object: string): Promise<string> {
  const token = await getAccessToken();
  const url = `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(object)}?alt=media`;
  const resp = await timedFetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (resp.status === 404) throw new GcsConfigError("NotFound", "not-found");
  if (resp.status === 401 || resp.status === 403) {
    throw new GcsConfigError(`Permission denied (${resp.status})`, "no-credentials");
  }
  if (!resp.ok) {
    const body = await resp.text();
    throw new GcsConfigError(
      `GCS GET failed (${resp.status}): ${body.slice(0, 200)}`,
      "gcs-error",
    );
  }
  return resp.text();
}

/** Write a GCS object (media upload). Throws GcsConfigError. */
async function gcsPut(bucket: string, object: string, content: string): Promise<void> {
  const token = await getAccessToken();
  const url = `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(bucket)}/o?uploadType=media&name=${encodeURIComponent(object)}`;
  const resp = await timedFetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: content,
  });
  if (resp.status === 401 || resp.status === 403) {
    throw new GcsConfigError(`Permission denied (${resp.status})`, "no-credentials");
  }
  if (!resp.ok) {
    const body = await resp.text();
    throw new GcsConfigError(
      `GCS PUT failed (${resp.status}): ${body.slice(0, 200)}`,
      "gcs-error",
    );
  }
}

/** Check whether any objects exist under a prefix. Throws GcsConfigError. */
async function gcsHasPrefix(bucket: string, prefix: string): Promise<boolean> {
  const token = await getAccessToken();
  const url = `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o?prefix=${encodeURIComponent(prefix)}&maxResults=1`;
  const resp = await timedFetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (resp.status === 401 || resp.status === 403) {
    throw new GcsConfigError(`Permission denied (${resp.status})`, "no-credentials");
  }
  if (!resp.ok) {
    const body = await resp.text();
    throw new GcsConfigError(
      `GCS list failed (${resp.status}): ${body.slice(0, 200)}`,
      "gcs-error",
    );
  }
  const data = (await resp.json()) as { items?: unknown[] };
  return (data.items?.length ?? 0) > 0;
}

// ─── Object URLs ──────────────────────────────────────────────────────────────

function camerasObject(instance: string) {
  return `cameras/${instance}.json`;
}

function promptObject(instance: string) {
  return `prompt/${instance}.json`;
}

function scenariosObject(instance: string) {
  return `scenarios/${instance}.json`;
}

// ─── Schema validation ────────────────────────────────────────────────────────

function isValidCameraList(obj: unknown): obj is CameraList {
  if (!obj || typeof obj !== "object") return false;
  const o = obj as Record<string, unknown>;
  if (o["schema"] !== "isv-labs.cameras.v1" && o["schema"] !== "isv-labs.cameras.v2") return false;
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

// ─── Prompt + Scenarios interfaces ───────────────────────────────────────────

export interface PromptConfig {
  schema: "isv-labs.prompt.v1";
  instance: string;
  updatedAt: string;
  updatedBy: string;
  prompt: string;
  model?: string;
}

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

// ─── Shared error-to-null helper ─────────────────────────────────────────────

function isNotFoundError(err: GcsConfigError): boolean {
  return (
    err.code === "not-found" ||
    err.message.includes("NotFound") ||
    err.message.includes("404") ||
    err.message.includes("does not exist")
  );
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Returns the camera list from GCS, or null if the object doesn't exist,
 * GCS is unreachable, or the payload fails schema validation.
 * Never throws.
 */
export async function gcsCamerasGet(
  instance: string,
): Promise<CameraList | null> {
  try {
    const text = await gcsGet(GCS_CONFIG_BUCKET, camerasObject(instance));
    const obj: unknown = JSON.parse(text);
    if (!isValidCameraList(obj)) {
      log.warn(`schema mismatch for ${instance}: expected isv-labs.cameras.v1 or v2, got schema=${obj && typeof obj === "object" ? (obj as Record<string, unknown>)["schema"] : "unknown"}`);
      return null;
    }
    return obj;
  } catch (err) {
    if (err instanceof GcsConfigError) {
      if (!isNotFoundError(err)) {
        log.warn(`gcsCamerasGet(${instance})`, { err });
      }
      return null;
    }
    if (err instanceof SyntaxError) {
      log.warn(`gcsCamerasGet(${instance}): invalid JSON in GCS object`);
      return null;
    }
    log.warn(`gcsCamerasGet(${instance}): unexpected error`, { err });
    return null;
  }
}

/**
 * Write the camera list to GCS. Stamps updatedAt before writing.
 * Throws GcsConfigError on failure.
 */
export async function gcsCamerasPut(list: CameraList): Promise<void> {
  const stamped: CameraList = {
    ...list,
    updatedAt: new Date().toISOString(),
    updatedBy: process.env.UPDATED_BY ?? "unknown",
  };
  await gcsPut(GCS_CONFIG_BUCKET, camerasObject(list.instance), JSON.stringify(stamped, null, 2));
}

/**
 * Health check — returns GCS availability for the About page and bootstrap logic.
 */
export async function gcsHealthCheck(): Promise<GcsHealthResult> {
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    return {
      status: "no-credentials",
      detail: "GOOGLE_APPLICATION_CREDENTIALS not set",
    };
  }

  try {
    await getAccessToken();
  } catch (err) {
    if (err instanceof GcsConfigError && err.code === "no-credentials") {
      return { status: "no-credentials", detail: err.message.slice(0, 300) };
    }
    return {
      status: "error",
      detail: err instanceof Error ? err.message.slice(0, 300) : String(err),
    };
  }

  try {
    await gcsHasPrefix(GCS_CONFIG_BUCKET, "cameras/");
    return { status: "ok" };
  } catch (err) {
    if (err instanceof GcsConfigError) {
      if (err.code === "no-credentials") {
        return { status: "no-credentials", detail: err.message.slice(0, 300) };
      }
      const notFound =
        err.message.includes("404") ||
        err.message.includes("NotFound") ||
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
    const text = await gcsGet(GCS_CONFIG_BUCKET, promptObject(instance));
    const obj: unknown = JSON.parse(text);
    if (!isValidPromptConfig(obj)) {
      log.warn(`schema mismatch for prompt/${instance}: expected isv-labs.prompt.v1, got schema=${obj && typeof obj === "object" ? (obj as Record<string, unknown>)["schema"] : "unknown"}`);
      return null;
    }
    return obj;
  } catch (err) {
    if (err instanceof GcsConfigError) {
      if (!isNotFoundError(err)) {
        log.warn(`gcsPromptGet(${instance})`, { err });
      }
      return null;
    }
    if (err instanceof SyntaxError) {
      log.warn(`gcsPromptGet(${instance}): invalid JSON in GCS object`);
      return null;
    }
    log.warn(`gcsPromptGet(${instance}): unexpected error`, { err });
    return null;
  }
}

/** Write the prompt config to GCS. Stamps updatedAt. Throws GcsConfigError on failure. */
export async function gcsPromptPut(config: PromptConfig): Promise<void> {
  const stamped: PromptConfig = {
    ...config,
    updatedAt: new Date().toISOString(),
  };
  await gcsPut(GCS_CONFIG_BUCKET, promptObject(config.instance), JSON.stringify(stamped, null, 2));
}

// ─── Scenarios helpers ────────────────────────────────────────────────────────

/** Returns the scenarios config from GCS, or null if missing / schema mismatch / unreachable. */
export async function gcsScenariosGet(instance: string): Promise<ScenariosConfig | null> {
  try {
    const text = await gcsGet(GCS_CONFIG_BUCKET, scenariosObject(instance));
    const obj: unknown = JSON.parse(text);
    if (!isValidScenariosConfig(obj)) {
      log.warn(`schema mismatch for scenarios/${instance}: expected isv-labs.scenarios.v1, got schema=${obj && typeof obj === "object" ? (obj as Record<string, unknown>)["schema"] : "unknown"}`);
      return null;
    }
    return obj;
  } catch (err) {
    if (err instanceof GcsConfigError) {
      if (!isNotFoundError(err)) {
        log.warn(`gcsScenariosGet(${instance})`, { err });
      }
      return null;
    }
    if (err instanceof SyntaxError) {
      log.warn(`gcsScenariosGet(${instance}): invalid JSON in GCS object`);
      return null;
    }
    log.warn(`gcsScenariosGet(${instance}): unexpected error`, { err });
    return null;
  }
}

/** Write the scenarios config to GCS. Stamps updatedAt. Throws GcsConfigError on failure. */
export async function gcsScenariosPut(config: ScenariosConfig): Promise<void> {
  const stamped: ScenariosConfig = {
    ...config,
    updatedAt: new Date().toISOString(),
  };
  await gcsPut(
    GCS_CONFIG_BUCKET,
    scenariosObject(config.instance),
    JSON.stringify(stamped, null, 2),
  );
}


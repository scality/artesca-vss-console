import "server-only";
import { HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { CLUSTER } from "../cluster-refs";
import { readConfigMapKey } from "@/lib/helpers/configmaps";
import { createLogger } from "@/lib/logger";

const log = createLogger("storage-preflight");

// Why this exists
// ---------------
// The recorder (vss-vios-streamprocessing) writes every camera's video to
// ARTESCA S3 using credentials + an endpoint baked into its OWN ConfigMap
// (vst_config.json cloud_storage_*), rendered at deploy time from the
// objectstore-creds Secret. Nothing re-validates that config afterwards.
//
// Observed failure (Pyramid, 2026-08-05): an ARTESCA reinstall moved the S3
// vhost from s3.artesca.isv-lab.local to s3.artesca.pyramid.local. The recorder
// kept the old hostname, which no longer resolved, so every recording session
// died with "Failed to configure MinIO storage writer" — visible only in pod
// logs. In the UI every camera showed a grey NOT RECORDING chip with no reason,
// and incidents had no video because clips are cut from those recordings. It
// had been broken for weeks.
//
// This probe reads the recorder's effective config and actually exercises it,
// so the failure is reported as a sentence instead of a missing badge.

export type StorageState = "ok" | "fail" | "unknown";

export interface StoragePreflight {
  state: StorageState;
  /** One-line operator-facing statement of what is wrong (absent when ok). */
  reason?: string;
  /** What to do about it (absent when ok). */
  fix?: string;
  /** Endpoint the RECORDER is configured to write to. */
  recorderEndpoint?: string;
  /** Endpoint the CONSOLE reads through — drift between the two is itself a bug. */
  consoleEndpoint?: string;
  bucket?: string;
  accessKeyId?: string;
  checkedAt: string;
}

interface RecorderStorageConfig {
  endpoint?: string;
  accessKey?: string;
  secretKey?: string;
  bucket?: string;
  region?: string;
  useSsl?: boolean;
  enabled?: boolean;
}

/** Collect every cloud_storage_* / enable_cloud_storage value in the document,
 *  at whatever depth it sits. On the Helm alerts profile they live under `data`,
 *  but the nesting is chart-version-dependent — a top-level-only read silently
 *  yields "storage disabled" for a recorder that is writing perfectly well,
 *  which is exactly the false alarm this module exists to prevent. */
export function extractStorageKeys(doc: unknown): Record<string, unknown> {
  const found: Record<string, unknown> = {};
  const visit = (node: unknown) => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (!node || typeof node !== "object") return;
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k === "enable_cloud_storage" || k.startsWith("cloud_storage")) {
        // First occurrence wins — shallowest, since this is breadth-agnostic
        // depth-first over a document with a single storage block.
        if (!(k in found)) found[k] = v;
      } else {
        visit(v);
      }
    }
  };
  visit(doc);
  return found;
}

/** Read cloud_storage_* out of the recorder's vst_config.json ConfigMap. */
async function readRecorderStorageConfig(): Promise<RecorderStorageConfig | undefined> {
  const { configMap, namespace, key } = CLUSTER.vst.recorderConfig;
  const cm = await readConfigMapKey(namespace, configMap, key).catch((err) => {
    log.warn("recorder config unreadable", { err: String(err) });
    return undefined;
  });
  if (!cm?.raw) return undefined;
  try {
    const keys = extractStorageKeys(JSON.parse(cm.raw));
    if (Object.keys(keys).length === 0) return undefined;
    const str = (k: string) =>
      typeof keys[k] === "string" ? (keys[k] as string) : undefined;
    return {
      endpoint: str("cloud_storage_endpoint"),
      accessKey: str("cloud_storage_access_key"),
      secretKey: str("cloud_storage_secret_key"),
      bucket: str("cloud_storage_bucket"),
      region: str("cloud_storage_region"),
      useSsl: keys.cloud_storage_use_ssl === true,
      enabled: keys.enable_cloud_storage === true,
    };
  } catch (err) {
    log.warn("recorder config unparseable", { err: String(err) });
    return undefined;
  }
}

/** Classify why a HeadBucket against the recorder's own config failed. The
 *  point is to name the cause — a DNS miss and a revoked key both surface as
 *  "not recording" today, but need completely different fixes. */
function classify(err: unknown, cfg: RecorderStorageConfig): { reason: string; fix: string } {
  const msg = err instanceof Error ? err.message : String(err);
  const name = (err as { name?: string })?.name ?? "";
  const status = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
  const host = hostOf(cfg.endpoint);

  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(msg)) {
    return {
      reason: `recorder S3 endpoint does not resolve: ${host}`,
      fix: "The ARTESCA S3 hostname changed (a reinstall moves the base domain). Update the objectstore-creds Secret + the recorder ConfigMap, then restart vss-vios-streamprocessing.",
    };
  }
  if (/ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|socket hang up|timeout/i.test(msg)) {
    return {
      reason: `recorder S3 endpoint unreachable: ${host}`,
      fix: "Check the ARTESCA S3 connector service is up and reachable from this namespace.",
    };
  }
  if (status === 403 || /InvalidAccessKeyId|SignatureDoesNotMatch|AccessDenied|Forbidden/i.test(name + msg)) {
    return {
      reason: `recorder S3 credentials rejected (access key ${cfg.accessKey ?? "?"})`,
      fix: "Mint a fresh ARTESCA S3 key, update the objectstore-creds Secret and the instance .objectstore.env, then restart vss-vios-streamprocessing.",
    };
  }
  if (status === 404 || /NoSuchBucket|NotFound/i.test(name + msg)) {
    return {
      reason: `recorder S3 bucket missing: ${cfg.bucket ?? "?"}`,
      fix: "Create the bucket on ARTESCA (scripts/setup-s3-bucket.sh) or point the recorder at the right one.",
    };
  }
  return {
    reason: `recorder cannot write to S3: ${msg}`,
    fix: "Inspect vss-vios-streamprocessing logs for the storage writer error.",
  };
}

function hostOf(endpoint?: string): string {
  if (!endpoint) return "(unset)";
  try {
    return new URL(endpoint).host;
  } catch {
    return endpoint;
  }
}

/**
 * Exercise the recorder's own S3 configuration and report, in one sentence,
 * why video is not being written. `unknown` (never a false green) when the
 * recorder config itself cannot be read.
 */
export async function collectStoragePreflight(): Promise<StoragePreflight> {
  const checkedAt = new Date().toISOString();
  const consoleEndpoint = CLUSTER.s3.endpoint || undefined;

  const cfg = await readRecorderStorageConfig();
  if (!cfg) {
    return {
      state: "unknown",
      reason: "recorder storage config could not be read",
      fix: `Check the ${CLUSTER.vst.recorderConfig.configMap} ConfigMap in ${CLUSTER.vst.recorderConfig.namespace} and the console's RBAC to read it.`,
      consoleEndpoint,
      checkedAt,
    };
  }

  const base = {
    recorderEndpoint: cfg.endpoint,
    consoleEndpoint,
    bucket: cfg.bucket,
    accessKeyId: cfg.accessKey,
    checkedAt,
  };

  if (cfg.enabled === false) {
    return {
      state: "fail",
      reason: "cloud storage is disabled on the recorder",
      fix: "Set enable_cloud_storage=true in the recorder ConfigMap and restart vss-vios-streamprocessing.",
      ...base,
    };
  }
  if (!cfg.endpoint || !cfg.accessKey || !cfg.secretKey || !cfg.bucket) {
    return {
      state: "fail",
      reason: "recorder S3 configuration is incomplete",
      fix: "Re-run the deploy so the vst-config patch Job renders cloud_storage_* from the objectstore-creds Secret.",
      ...base,
    };
  }

  // Exercise the recorder's exact credentials against its exact endpoint —
  // a config read alone would have passed all through the Pyramid outage.
  const client = new S3Client({
    endpoint: cfg.endpoint,
    region: cfg.region || "us-east-1",
    forcePathStyle: true,
    credentials: { accessKeyId: cfg.accessKey, secretAccessKey: cfg.secretKey },
    requestHandler: { requestTimeout: 8_000, connectionTimeout: 5_000 },
  });

  try {
    await client.send(new HeadBucketCommand({ Bucket: cfg.bucket }));
  } catch (err) {
    const { reason, fix } = classify(err, cfg);
    return { state: "fail", reason, fix, ...base };
  } finally {
    client.destroy();
  }

  return { state: "ok", ...base };
}

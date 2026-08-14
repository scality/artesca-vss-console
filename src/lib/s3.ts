// Centralized S3 client construction.
//
// Honors the unified OBJECTSTORE_* contract (set by
// scripts/install-objectstore/<mode>.sh and applied to the console
// namespace as the `objectstore-creds` Secret + console-env ConfigMap).
//
// Reads, in order of preference:
//   - OBJECTSTORE_ENDPOINT  (preferred) → falls back to S3_ENDPOINT
//   - bucket names come from CLUSTER.s3.buckets (cluster-refs.ts) —
//     recordings defaults to "nvidia-vss-recordings" (OBJECTSTORE_RECORDINGS_BUCKET)
//   - OBJECTSTORE_REGION    (preferred) → falls back to AWS_REGION → "us-west-2"
//   - OBJECTSTORE_ACCESS_KEY_ID + OBJECTSTORE_SECRET_ACCESS_KEY (comes from the
//     objectstore-creds Secret, remapped via secretKeyRef) → falls back to the
//     SDK's own credential chain, which on this pod finds nothing: no Secret
//     supplies AWS_ACCESS_KEY_ID and there is no instance profile. So an unset
//     OBJECTSTORE_* pair means unsigned requests, not wrong ones.
//
// forcePathStyle is auto-detected:
//   - AWS-native endpoints (s3.amazonaws.com, s3.<region>.amazonaws.com,
//     or empty endpoint → SDK default) → false (virtual-hosted-style; AWS
//     deprecated path-style for buckets created after 2020)
//   - Anything else (ARTESCA s3.<base-domain>, MinIO, BYO) → true

import { S3Client, type S3ClientConfig } from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { Agent } from "node:https";
import type { LookupFunction } from "node:net";
import { CLUSTER } from "@/lib/cluster-refs";

const AWS_HOST_PATTERN = /(^|\.)s3([.-][a-z0-9-]+)?\.amazonaws\.com$/i;

export function s3Endpoint(): string | undefined {
  const ep = process.env.OBJECTSTORE_ENDPOINT ?? process.env.S3_ENDPOINT ?? "";
  return ep ? ep : undefined;
}

/** Returns the bucket name for VST recordings. */
export function s3BucketForRecordings(): string {
  return CLUSTER.s3.buckets.recordings;
}

/** Returns the bucket name for materializer-produced alert clips. */
export function s3BucketForAlertClips(): string {
  return CLUSTER.s3.buckets.alertClips;
}

/**
 * Returns the canonical S3 key for an alert-clip MANIFEST. The video bytes
 * themselves live in the recordings bucket; the manifest at this key tells the
 * replay route how to fetch them from VST.
 *
 * Key format: `<sensorId>/<ts-rounded-to-10s>.json`
 * where the timestamp is UTC, rounded to the nearest 10-second boundary using
 * half-up rounding (`Math.round`), and colons are replaced with hyphens.
 *
 * This is byte-identical to the Python helper in `k8s/nvidia-vss/alerts/clip_key.py`
 * which uses `math.floor(x/10 + 0.5) * 10` — both round half-up.
 *
 * @param sensorId - The camera/sensor identifier (e.g. "cam-01").
 * @param tsIso    - ISO 8601 timestamp string (UTC or with offset).
 * @returns        S3 object key, e.g. "cam-01/2026-05-15T14-03-30.json".
 */
export function s3KeyForAlertClip(sensorId: string, tsIso: string): string {
  const epochMs = new Date(tsIso).getTime();
  const epochS = epochMs / 1000;
  const roundedS = Math.round(epochS / 10) * 10;
  const rounded = new Date(roundedS * 1000);

  // Format as ISO 8601 UTC with colons replaced by hyphens so the key is
  // filesystem-safe and matches the Python implementation exactly.
  const iso = rounded.toISOString(); // e.g. "2026-05-15T14:03:30.000Z"
  const withoutMs = iso.replace(/\.\d{3}Z$/, ""); // "2026-05-15T14:03:30"
  const safe = withoutMs.replace(/:/g, "-"); // "2026-05-15T14-03-30"

  return `${sensorId}/${safe}.json`;
}

export function s3Region(): string {
  return process.env.OBJECTSTORE_REGION ?? process.env.AWS_REGION ?? "us-west-2";
}

/**
 * Turn an opaque S3 SDK failure into an operator-actionable message.
 *
 * The classic case on a misconfigured endpoint: the host serves an HTML page
 * (the ARTESCA/MetalK8s UI, an ingress, or a redirect), so a GET like
 * ListObjectsV2 parses the body `<!doctype html>` as XML and dies with
 * "char 'd' is not expected.:1:3". A HEAD (HeadBucket) hides this — it only
 * reads the status code — so reachability can read "ok" while listing fails.
 * When we see that signature, say *why* and name the endpoint.
 */
export function describeS3Error(err: unknown): string {
  const raw = String(err);
  const ep = s3Endpoint() ?? "(SDK-default AWS endpoint)";
  if (/is not expected|Deserialization|non-whitespace|Unexpected (token|character)/i.test(raw)) {
    return `endpoint ${ep} returned a non-XML (HTML?) body — OBJECTSTORE_ENDPOINT likely points at a web UI / ingress, not the S3 API. [${raw}]`;
  }
  return `${raw} (endpoint ${ep})`;
}

/**
 * True when the configured endpoint is an AWS-native S3 endpoint (or
 * unset, meaning the SDK will compute one). False for ARTESCA / MinIO /
 * any custom endpoint — those need path-style addressing.
 */
export function isAwsNativeEndpoint(endpoint?: string): boolean {
  const ep = endpoint ?? s3Endpoint();
  if (!ep) return true;
  try {
    const u = new URL(ep);
    return AWS_HOST_PATTERN.test(u.hostname);
  } catch {
    return false;
  }
}

/**
 * Builds an https.Agent when the deployment needs to reach an ARTESCA S3
 * endpoint whose vhost FQDN (e.g. `s3.artesca.isv-lab.local`) isn't
 * publicly resolvable and/or is fronted by a self-signed cert. Returns
 * undefined when neither override is set, so AWS-native / in-cluster paths
 * use the SDK's default agent unchanged.
 *
 *   OBJECTSTORE_ENDPOINT_IP   pin the endpoint host's DNS resolution to this
 *                             IP (the signed Host header stays the FQDN, so
 *                             SigV4 still matches — only the TCP target moves).
 *   OBJECTSTORE_TLS_INSECURE  skip TLS cert verification (ARTESCA demo cert
 *                             is signed for *.<base-domain>, not the IP).
 */
function makeArtescaAgent(): Agent | undefined {
  const pinnedIp = process.env.OBJECTSTORE_ENDPOINT_IP?.trim();
  const insecure = /^(1|true|yes)$/i.test(process.env.OBJECTSTORE_TLS_INSECURE ?? "");
  if (!pinnedIp && !insecure) return undefined;

  const lookup: LookupFunction | undefined = pinnedIp
    ? (_hostname, options, cb) => {
        // dns.lookup is called either (host, cb) or (host, options, cb), and
        // with options.all the callback expects an array of {address,family}.
        const callback = (typeof options === "function" ? options : cb) as (
          ...args: unknown[]
        ) => void;
        const all = typeof options === "object" && options?.all;
        return all
          ? callback(null, [{ address: pinnedIp, family: 4 }])
          : callback(null, pinnedIp, 4);
      }
    : undefined;

  return new Agent({
    ...(insecure ? { rejectUnauthorized: false } : {}),
    ...(lookup ? { lookup } : {}),
  });
}

export function makeS3Client(): S3Client {
  const endpoint = s3Endpoint();
  const region = s3Region();
  const forcePathStyle = !isAwsNativeEndpoint(endpoint);
  const httpsAgent = makeArtescaAgent();

  const config: S3ClientConfig = {
    region,
    endpoint,
    forcePathStyle,
    requestHandler: new NodeHttpHandler({
      connectionTimeout: 3_000,
      requestTimeout: 8_000,
      ...(httpsAgent ? { httpsAgent } : {}),
    }),
  };

  // OBJECTSTORE_* comes from the objectstore-creds Secret, remapped so it cannot
  // be confused with any ambient AWS_ACCESS_KEY_ID the SDK's chain might find.
  const ak = process.env.OBJECTSTORE_ACCESS_KEY_ID;
  const sk = process.env.OBJECTSTORE_SECRET_ACCESS_KEY;
  if (ak && sk) {
    config.credentials = { accessKeyId: ak, secretAccessKey: sk };
  }
  // Otherwise leave credentials undefined → SDK falls back to the standard
  // AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY env vars (legacy artesca-only
  // path), instance profile, etc.

  return new S3Client(config);
}

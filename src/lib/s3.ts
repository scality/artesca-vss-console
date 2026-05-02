// Centralized S3 client construction.
//
// Honors the unified OBJECTSTORE_* contract (set by
// scripts/install-objectstore/<mode>.sh and applied to the console
// namespace as the `objectstore-creds` Secret + console-env ConfigMap).
//
// Reads, in order of preference:
//   - OBJECTSTORE_ENDPOINT  (preferred) → falls back to S3_ENDPOINT
//   - OBJECTSTORE_BUCKET    (preferred) → falls back to S3_BUCKET / VSS_VIDEO_BUCKET / "nvidia-vss-video"
//   - OBJECTSTORE_REGION    (preferred) → falls back to AWS_REGION → "us-west-2"
//   - OBJECTSTORE_ACCESS_KEY_ID + OBJECTSTORE_SECRET_ACCESS_KEY (preferred,
//     comes from the objectstore-creds Secret remapped via secretKeyRef)
//     → falls back to AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY (which on
//     the console pod come from the console-aws Secret — those creds only
//     have ec2:*SecurityGroupIngress perms in aws-s3 mode, so S3 calls will
//     403. Always populate OBJECTSTORE_* to make S3 work in aws-s3 mode.)
//
// forcePathStyle is auto-detected:
//   - AWS-native endpoints (s3.amazonaws.com, s3.<region>.amazonaws.com,
//     or empty endpoint → SDK default) → false (virtual-hosted-style; AWS
//     deprecated path-style for buckets created after 2020)
//   - Anything else (ARTESCA s3.<base-domain>, MinIO, BYO) → true

import { S3Client, type S3ClientConfig } from "@aws-sdk/client-s3";

const AWS_HOST_PATTERN = /(^|\.)s3([.-][a-z0-9-]+)?\.amazonaws\.com$/i;

export function s3Endpoint(): string | undefined {
  const ep = process.env.OBJECTSTORE_ENDPOINT ?? process.env.S3_ENDPOINT ?? "";
  return ep ? ep : undefined;
}

export function s3Bucket(): string {
  return (
    process.env.OBJECTSTORE_BUCKET ??
    process.env.S3_BUCKET ??
    process.env.VSS_VIDEO_BUCKET ??
    "nvidia-vss-video"
  );
}

export function s3Region(): string {
  return process.env.OBJECTSTORE_REGION ?? process.env.AWS_REGION ?? "us-west-2";
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

export function makeS3Client(): S3Client {
  const endpoint = s3Endpoint();
  const region = s3Region();
  const forcePathStyle = !isAwsNativeEndpoint(endpoint);

  const config: S3ClientConfig = {
    region,
    endpoint,
    forcePathStyle,
  };

  // Prefer explicit OBJECTSTORE_* creds (mounted from objectstore-creds
  // Secret with renamed keys) so we don't collide with the console-aws
  // Secret's AWS_ACCESS_KEY_ID (which is scoped to EC2 SG only).
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

import "server-only";

/**
 * evidence.ts — "immutable evidence" via ARTESCA S3 Object Lock (WORM).
 *
 * Seals an incident's clip into a dedicated Object-Lock-enabled bucket with a
 * retention period, so it cannot be deleted or altered until it expires — even
 * by an admin (COMPLIANCE) — the loss-prevention / legal-hold story. The
 * console can then *prove* immutability by attempting a version delete and
 * showing ARTESCA denies it (AccessDenied).
 *
 * Verified against ARTESCA 4.3: create-bucket-with-object-lock, put-with-
 * retention, and version-delete-denied all work.
 */
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import { makeS3Client } from "@/lib/s3";
import { resolveStreamId, buildVstClipUrl } from "@/lib/streams/vst-clip";

export const EVIDENCE_BUCKET = process.env.OBJECTSTORE_EVIDENCE_BUCKET ?? "nvidia-vss-evidence";
export const DEFAULT_RETENTION_DAYS = Number(process.env.EVIDENCE_RETENTION_DAYS ?? 365);
export type LockMode = "GOVERNANCE" | "COMPLIANCE";
const DEFAULT_MODE: LockMode = (process.env.EVIDENCE_LOCK_MODE as LockMode) ?? "COMPLIANCE";

let _client: S3Client | null = null;
function client(): S3Client {
  if (!_client) _client = makeS3Client();
  return _client;
}

let _bucketReady = false;
export async function ensureEvidenceBucket(): Promise<void> {
  if (_bucketReady) return;
  const c = client();
  try {
    await c.send(new HeadBucketCommand({ Bucket: EVIDENCE_BUCKET }));
    _bucketReady = true;
    return;
  } catch {
    /* not present — create it below */
  }
  try {
    await c.send(new CreateBucketCommand({ Bucket: EVIDENCE_BUCKET, ObjectLockEnabledForBucket: true }));
  } catch {
    /* race / already exists — PutObject will surface a real failure if broken */
  }
  _bucketReady = true;
}

function evidenceKey(sensor: string, ts: string): string {
  return `${sensor}/${ts.replace(/:/g, "-")}.mp4`;
}

export interface SealResult {
  bucket: string;
  key: string;
  versionId?: string;
  mode: LockMode;
  retainUntil: string;
  size: number;
}

export interface SealInput {
  sensor: string;
  ts: string;
  incidentId?: string;
  scenarioName?: string;
  retentionDays?: number;
  mode?: LockMode;
}

export async function sealClip(input: SealInput): Promise<SealResult> {
  await ensureEvidenceBucket();
  const streamId = await resolveStreamId(input.sensor);
  if (!streamId) throw new Error(`no active stream for sensor "${input.sensor}"`);
  const resp = await fetch(buildVstClipUrl(streamId, input.ts), { signal: AbortSignal.timeout(20_000) });
  if (!resp.ok) throw new Error(`clip fetch failed: HTTP ${resp.status}`);
  const bytes = new Uint8Array(await resp.arrayBuffer());
  if (!bytes.length) throw new Error("clip is empty (segment may not have finalized yet)");

  const days = input.retentionDays && input.retentionDays > 0 ? input.retentionDays : DEFAULT_RETENTION_DAYS;
  const mode = input.mode ?? DEFAULT_MODE;
  const retainUntil = new Date(Date.now() + days * 86_400_000);
  const key = evidenceKey(input.sensor, input.ts);

  const put = await client().send(
    new PutObjectCommand({
      Bucket: EVIDENCE_BUCKET,
      Key: key,
      Body: bytes,
      ContentType: "video/mp4",
      ObjectLockMode: mode,
      ObjectLockRetainUntilDate: retainUntil,
      Metadata: {
        sensor: input.sensor,
        ts: input.ts,
        incidentid: input.incidentId ?? "",
        scenario: input.scenarioName ?? "",
        sealedat: new Date().toISOString(),
      },
    }),
  );

  return {
    bucket: EVIDENCE_BUCKET,
    key,
    versionId: put.VersionId,
    mode,
    retainUntil: retainUntil.toISOString(),
    size: bytes.length,
  };
}

export interface EvidenceItem {
  key: string;
  size: number;
  lastModified: string;
  versionId?: string;
  mode?: string;
  retainUntil?: string;
  sensor?: string;
  ts?: string;
  scenario?: string;
  incidentId?: string;
}

export async function listEvidence(): Promise<EvidenceItem[]> {
  await ensureEvidenceBucket();
  const c = client();
  const resp = await c.send(new ListObjectsV2Command({ Bucket: EVIDENCE_BUCKET }));
  const items: EvidenceItem[] = [];
  for (const o of resp.Contents ?? []) {
    if (!o.Key) continue;
    const base: EvidenceItem = {
      key: o.Key,
      size: o.Size ?? 0,
      lastModified: o.LastModified?.toISOString() ?? "",
    };
    try {
      const h = await c.send(new HeadObjectCommand({ Bucket: EVIDENCE_BUCKET, Key: o.Key }));
      base.versionId = h.VersionId;
      base.mode = h.ObjectLockMode;
      base.retainUntil = h.ObjectLockRetainUntilDate?.toISOString();
      base.sensor = h.Metadata?.sensor;
      base.ts = h.Metadata?.ts;
      base.scenario = h.Metadata?.scenario;
      base.incidentId = h.Metadata?.incidentid;
    } catch {
      /* keep the listing-only fields */
    }
    items.push(base);
  }
  items.sort((a, b) => (b.lastModified || "").localeCompare(a.lastModified || ""));
  return items;
}

export interface VerifyResult {
  status: "immutable" | "deleted" | "inconclusive";
  error?: string;
}

/** True when the S3 error represents the object-lock refusing the delete. */
function isAccessDenied(e: unknown): boolean {
  if (!e || typeof e !== "object") return false;
  const err = e as {
    name?: string;
    Code?: string;
    $metadata?: { httpStatusCode?: number };
    message?: string;
  };
  if (err.name === "AccessDenied" || err.Code === "AccessDenied") return true;
  if (err.$metadata?.httpStatusCode === 403) return true;
  // Object-Lock-specific refusal message ARTESCA/S3 can surface instead of
  // (or alongside) a generic AccessDenied code.
  if (typeof err.message === "string" && /object.?lock/i.test(err.message) && /deni(ed|al)/i.test(err.message)) {
    return true;
  }
  return false;
}

/**
 * Prove immutability: attempt to permanently delete the locked version.
 *
 * Three distinguishable outcomes:
 *  - the delete succeeds            → "deleted"      (the lock is broken)
 *  - the delete is refused by S3    → "immutable"     (the lock held)
 *  - the delete throws for any other reason (network, creds, wrong bucket,
 *    NoSuchKey/NoSuchVersion, timeout, …) → "inconclusive" — we could NOT
 *    verify either way, and must never report that as a false "immutable".
 */
export async function verifyImmutable(key: string, versionId?: string): Promise<VerifyResult> {
  try {
    await client().send(new DeleteObjectCommand({ Bucket: EVIDENCE_BUCKET, Key: key, VersionId: versionId }));
    return { status: "deleted" };
  } catch (e) {
    const error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    if (isAccessDenied(e)) return { status: "immutable", error };
    return { status: "inconclusive", error };
  }
}

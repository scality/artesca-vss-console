import { EC2Client, DescribeSecurityGroupsCommand, AuthorizeSecurityGroupIngressCommand, RevokeSecurityGroupIngressCommand, type IpPermission } from "@aws-sdk/client-ec2";
import { ListObjectsV2Command } from "@aws-sdk/client-s3";
import { makeS3Client } from "@/lib/s3";

const _ec2Clients = new Map<string, EC2Client>();

function ec2Client(): EC2Client {
  const region =
    process.env.OBJECTSTORE_REGION ?? process.env.AWS_REGION ?? "us-west-2";
  if (!_ec2Clients.has(region)) {
    _ec2Clients.set(region, new EC2Client({ region }));
  }
  return _ec2Clients.get(region)!;
}

const _s3Clients = new Map<string, ReturnType<typeof makeS3Client>>();

function s3Client(): ReturnType<typeof makeS3Client> {
  const region =
    process.env.OBJECTSTORE_REGION ?? process.env.AWS_REGION ?? "us-west-2";
  if (!_s3Clients.has(region)) {
    _s3Clients.set(region, makeS3Client());
  }
  return _s3Clients.get(region)!;
}

export interface SgIngressRule {
  cidr: string;
  port: number;
  protocol: string;
}

export async function listSgIngress(
  sgId: string,
  port: number
): Promise<SgIngressRule[]> {
  const client = ec2Client();
  const resp = await client.send(
    new DescribeSecurityGroupsCommand({ GroupIds: [sgId] })
  );
  const sg = resp.SecurityGroups?.[0];
  if (!sg) return [];

  const rules: SgIngressRule[] = [];
  for (const perm of sg.IpPermissions ?? []) {
    if (perm.FromPort !== port && perm.ToPort !== port) continue;
    for (const range of perm.IpRanges ?? []) {
      if (range.CidrIp) {
        rules.push({
          cidr: range.CidrIp,
          port,
          protocol: perm.IpProtocol ?? "tcp",
        });
      }
    }
  }
  return rules;
}

export async function authorizeSgIngress(
  sgId: string,
  cidr: string,
  port: number
): Promise<void> {
  const client = ec2Client();
  const perm: IpPermission = {
    IpProtocol: "tcp",
    FromPort: port,
    ToPort: port,
    IpRanges: [{ CidrIp: cidr }],
  };
  await client.send(
    new AuthorizeSecurityGroupIngressCommand({
      GroupId: sgId,
      IpPermissions: [perm],
    })
  );
}

export async function revokeSgIngress(
  sgId: string,
  cidr: string,
  port: number
): Promise<void> {
  const client = ec2Client();
  const perm: IpPermission = {
    IpProtocol: "tcp",
    FromPort: port,
    ToPort: port,
    IpRanges: [{ CidrIp: cidr }],
  };
  await client.send(
    new RevokeSecurityGroupIngressCommand({
      GroupId: sgId,
      IpPermissions: [perm],
    })
  );
}

export interface S3Stats {
  bucket: string;
  objectCount: number;
  bytesTotal: number;
  // Bytes written in the last 24h (sum of obj.Size where LastModified >= now-24h).
  // Partial when `truncated` (page limit hit before exhausting the bucket).
  bytesLast24h: number;
  truncated?: boolean;
}

const S3_STATS_PAGE_LIMIT = 1000;

export async function s3Stats(bucket: string): Promise<S3Stats> {
  const client = s3Client();
  let objectCount = 0;
  let bytesTotal = 0;
  let bytesLast24h = 0;
  let continuationToken: string | undefined;
  let pages = 0;
  let truncated = false;
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;

  do {
    const resp = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        ContinuationToken: continuationToken,
      })
    );
    for (const obj of resp.Contents ?? []) {
      objectCount++;
      const size = obj.Size ?? 0;
      bytesTotal += size;
      if (obj.LastModified && obj.LastModified.getTime() >= cutoff) {
        bytesLast24h += size;
      }
    }
    continuationToken = resp.NextContinuationToken;
    pages++;
    if (pages >= S3_STATS_PAGE_LIMIT) {
      truncated = true;
      break;
    }
  } while (continuationToken);

  return { bucket, objectCount, bytesTotal, bytesLast24h, ...(truncated ? { truncated } : {}) };
}

export interface S3RecentObject {
  key: string;
  size: number;
  lastModified: string; // ISO 8601 (sorts lexicographically = chronologically)
}

export interface S3SubstrateStats extends S3Stats {
  /** The most-recently-written objects (by LastModified), for the "live accumulation" stream. */
  recent: S3RecentObject[];
}

/**
 * Like s3Stats, but in the same single pass also tracks the N most-recently
 * written objects — so the storage-substrate panel gets true "latest objects
 * landing in ARTESCA" without a second listing. Memory stays bounded by
 * trimming the running recent-set periodically.
 */
export async function s3SubstrateStats(bucket: string, recentLimit = 8): Promise<S3SubstrateStats> {
  const client = s3Client();
  let objectCount = 0;
  let bytesTotal = 0;
  let bytesLast24h = 0;
  let continuationToken: string | undefined;
  let pages = 0;
  let truncated = false;
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  let recent: S3RecentObject[] = [];
  const trim = () => {
    recent.sort((a, b) => b.lastModified.localeCompare(a.lastModified));
    if (recent.length > recentLimit) recent = recent.slice(0, recentLimit);
  };

  do {
    const resp = await client.send(
      new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: continuationToken }),
    );
    for (const obj of resp.Contents ?? []) {
      objectCount++;
      const size = obj.Size ?? 0;
      bytesTotal += size;
      const lm = obj.LastModified;
      if (lm && lm.getTime() >= cutoff) bytesLast24h += size;
      recent.push({ key: obj.Key ?? "", size, lastModified: lm ? lm.toISOString() : "" });
    }
    if (recent.length > recentLimit * 40) trim(); // keep memory bounded on huge buckets
    continuationToken = resp.NextContinuationToken;
    pages++;
    if (pages >= S3_STATS_PAGE_LIMIT) {
      truncated = true;
      break;
    }
  } while (continuationToken);

  trim();
  return {
    bucket,
    objectCount,
    bytesTotal,
    bytesLast24h,
    ...(truncated ? { truncated } : {}),
    recent,
  };
}

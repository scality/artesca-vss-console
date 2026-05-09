import { EC2Client, DescribeSecurityGroupsCommand, AuthorizeSecurityGroupIngressCommand, RevokeSecurityGroupIngressCommand, type IpPermission } from "@aws-sdk/client-ec2";
import { ListObjectsV2Command } from "@aws-sdk/client-s3";
import { makeS3Client } from "@/lib/s3";

const _ec2Clients = new Map<string, EC2Client>();

function ec2Client(): EC2Client {
  const region = process.env.AWS_REGION ?? "us-west-2";
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
  truncated?: boolean;
}

const S3_STATS_PAGE_LIMIT = 1000;

export async function s3Stats(bucket: string): Promise<S3Stats> {
  const client = s3Client();
  let objectCount = 0;
  let bytesTotal = 0;
  let continuationToken: string | undefined;
  let pages = 0;
  let truncated = false;

  do {
    const resp = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        ContinuationToken: continuationToken,
      })
    );
    for (const obj of resp.Contents ?? []) {
      objectCount++;
      bytesTotal += obj.Size ?? 0;
    }
    continuationToken = resp.NextContinuationToken;
    pages++;
    if (pages >= S3_STATS_PAGE_LIMIT) {
      truncated = true;
      break;
    }
  } while (continuationToken);

  return { bucket, objectCount, bytesTotal, ...(truncated ? { truncated } : {}) };
}

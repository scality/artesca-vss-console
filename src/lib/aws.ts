import { EC2Client, DescribeSecurityGroupsCommand, AuthorizeSecurityGroupIngressCommand, RevokeSecurityGroupIngressCommand, type IpPermission } from "@aws-sdk/client-ec2";
import { S3Client, ListObjectsV2Command } from "@aws-sdk/client-s3";

function ec2Client(): EC2Client {
  return new EC2Client({
    region: process.env.AWS_REGION ?? "us-west-2",
  });
}

function s3Client(): S3Client {
  return new S3Client({
    region: process.env.AWS_REGION ?? "us-west-2",
    endpoint: process.env.S3_ENDPOINT,
    forcePathStyle: !!process.env.S3_ENDPOINT,
  });
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
}

export async function s3Stats(bucket: string): Promise<S3Stats> {
  const client = s3Client();
  let objectCount = 0;
  let bytesTotal = 0;
  let continuationToken: string | undefined;

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
  } while (continuationToken);

  return { bucket, objectCount, bytesTotal };
}

/**
 * EC2 security-group management — lab-only, and absent unless configured.
 *
 * The console can open its own inbound port to a CIDR by writing an ingress
 * rule on the EC2 security group in front of a lab instance. A customer's
 * ARTESCA cluster has no EC2, so on one `sgManagementConfig()` returns null and
 * the routes and the /settings panel are not there at all — the feature is
 * missing rather than broken.
 *
 * This is deliberately separate from lib/aws.ts, which holds the S3-protocol
 * helpers: those speak S3 against the ARTESCA connector and reach no AWS
 * service, so they belong to the product and this file does not (ISVD-610).
 */

import {
  EC2Client,
  DescribeSecurityGroupsCommand,
  AuthorizeSecurityGroupIngressCommand,
  RevokeSecurityGroupIngressCommand,
  type IpPermission,
} from "@aws-sdk/client-ec2";

/**
 * The console's own inbound port — the only port these rules govern.
 *
 * Annotated with its literal type, not just inferred: `SgWhitelistEntry.port` is
 * `8800`, and an unannotated `const` widens to `number` inside an object literal.
 */
export const CONSOLE_INGRESS_PORT: 8800 = 8800;

export interface SgManagementConfig {
  sgId: string;
  region: string;
}

/**
 * This deployment's security-group configuration, or null when it manages none.
 *
 * Both halves are required and neither is guessed. A security-group id with no
 * region would otherwise resolve to whatever the SDK defaults to — a live AWS
 * account and region chosen by omission rather than by anyone.
 *
 * `AWS_REGION` is the only region source. `OBJECTSTORE_REGION` names the
 * signing region of the S3 endpoint the storage panels talk to; on an ARTESCA
 * cluster that has nothing to do with where an EC2 instance lives.
 *
 * The variable names are the ones the `console-aws` Secret carries
 * (k8s/10-secrets.yaml.example), which is what a deploy provisions.
 * tests/unit/ec2-sg-env-contract.test.ts holds this function to them.
 */
export function sgManagementConfig(): SgManagementConfig | null {
  const sgId = process.env.VSS_INSTANCE_SG_ID?.trim();
  const region = process.env.AWS_REGION?.trim();
  if (!sgId || !region) return null;
  return { sgId, region };
}

const _ec2Clients = new Map<string, EC2Client>();

function ec2Client(region: string): EC2Client {
  if (!_ec2Clients.has(region)) {
    _ec2Clients.set(region, new EC2Client({ region }));
  }
  return _ec2Clients.get(region)!;
}

export interface SgIngressRule {
  cidr: string;
  port: number;
  protocol: string;
}

// Each of these takes a resolved config rather than a bare id, so there is no
// way to reach the EC2 API without having passed the gate above.

export async function listSgIngress(
  cfg: SgManagementConfig,
  port: number
): Promise<SgIngressRule[]> {
  const resp = await ec2Client(cfg.region).send(
    new DescribeSecurityGroupsCommand({ GroupIds: [cfg.sgId] })
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

function ingressPermission(cidr: string, port: number): IpPermission {
  return {
    IpProtocol: "tcp",
    FromPort: port,
    ToPort: port,
    IpRanges: [{ CidrIp: cidr }],
  };
}

export async function authorizeSgIngress(
  cfg: SgManagementConfig,
  cidr: string,
  port: number
): Promise<void> {
  await ec2Client(cfg.region).send(
    new AuthorizeSecurityGroupIngressCommand({
      GroupId: cfg.sgId,
      IpPermissions: [ingressPermission(cidr, port)],
    })
  );
}

export async function revokeSgIngress(
  cfg: SgManagementConfig,
  cidr: string,
  port: number
): Promise<void> {
  await ec2Client(cfg.region).send(
    new RevokeSecurityGroupIngressCommand({
      GroupId: cfg.sgId,
      IpPermissions: [ingressPermission(cidr, port)],
    })
  );
}

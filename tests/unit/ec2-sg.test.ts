import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── Hoisted mock spies ────────────────────────────────────────────────────────
//
// vi.mock() factories are hoisted above the `const` declarations in this module,
// so the spies are created with vi.hoisted() to exist by the time a factory runs.

const { mockEc2Send, MockEC2Client } = vi.hoisted(() => {
  const mockEc2Send = vi.fn();
  const MockEC2Client = vi.fn().mockImplementation(function (_config: unknown) {
    return { send: mockEc2Send };
  });
  return { mockEc2Send, MockEC2Client };
});

vi.mock("@aws-sdk/client-ec2", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aws-sdk/client-ec2")>();
  return { ...actual, EC2Client: MockEC2Client };
});

// The real command classes, so `expect(cmd).toBeInstanceOf(...)` means something.
import {
  DescribeSecurityGroupsCommand,
  AuthorizeSecurityGroupIngressCommand,
  RevokeSecurityGroupIngressCommand,
} from "@aws-sdk/client-ec2";

import {
  sgManagementConfig,
  listSgIngress,
  authorizeSgIngress,
  revokeSgIngress,
  CONSOLE_INGRESS_PORT,
  type SgManagementConfig,
} from "@/lib/ec2-sg";

const CFG: SgManagementConfig = { sgId: "sg-abc", region: "eu-west-3" };

beforeEach(() => {
  vi.clearAllMocks();
  MockEC2Client.mockImplementation(function (_config: unknown) {
    return { send: mockEc2Send };
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ─── sgManagementConfig ────────────────────────────────────────────────────────
//
// The gate. A deployment with no EC2 in front of it must resolve to null so the
// routes and the /settings panel are absent, rather than present and unable to
// act.

describe("sgManagementConfig", () => {
  // `undefined` *removes* the variable; `""` would leave it present and empty.
  // The distinction is not cosmetic — a `?? "us-west-2"` fallback reintroduced
  // into the region read is invisible to an empty-string test, because `""`
  // satisfies `??` and is then caught by the falsiness check further down. That
  // mutation survived a full pass of this file until these became deletions.
  function clearEnv() {
    vi.stubEnv("VSS_INSTANCE_SG_ID", undefined);
    vi.stubEnv("AWS_REGION", undefined);
    vi.stubEnv("OBJECTSTORE_REGION", undefined);
  }

  it("resolves when both the group id and the region are set", () => {
    clearEnv();
    vi.stubEnv("VSS_INSTANCE_SG_ID", "sg-0123456789abcdef0");
    vi.stubEnv("AWS_REGION", "us-west-2");

    expect(sgManagementConfig()).toEqual({
      sgId: "sg-0123456789abcdef0",
      region: "us-west-2",
    });
  });

  it("is null with no group id — the customer-cluster case", () => {
    clearEnv();
    vi.stubEnv("AWS_REGION", "us-west-2");

    expect(sgManagementConfig()).toBeNull();
  });

  // A group id with no region would otherwise resolve to whichever region the
  // SDK defaults to: a live AWS account picked by omission rather than by
  // anyone. Refusing is the point of requiring both halves.
  it("is null with a group id but no region, rather than guessing one", () => {
    clearEnv();
    vi.stubEnv("VSS_INSTANCE_SG_ID", "sg-0123456789abcdef0");

    expect(sgManagementConfig()).toBeNull();
  });

  // OBJECTSTORE_REGION is the signing region of the S3 endpoint the storage
  // panels talk to. On an ARTESCA cluster it is set, and it says nothing about
  // where any EC2 instance lives — so reading it here would resolve a config
  // out of a value that has nothing to do with EC2.
  it("does not accept OBJECTSTORE_REGION as the EC2 region", () => {
    clearEnv();
    vi.stubEnv("VSS_INSTANCE_SG_ID", "sg-0123456789abcdef0");
    vi.stubEnv("OBJECTSTORE_REGION", "us-east-1");

    expect(sgManagementConfig()).toBeNull();
  });

  it("treats whitespace-only values as unset", () => {
    clearEnv();
    vi.stubEnv("VSS_INSTANCE_SG_ID", "   ");
    vi.stubEnv("AWS_REGION", "us-west-2");

    expect(sgManagementConfig()).toBeNull();
  });

  // The empty-string and absent cases are separate tests on purpose: a Secret
  // key present with an empty value and a Secret key that is not there at all
  // are both real deployment states, and only the second one exercises a
  // fallback on the read.
  it("is null when the region is present but empty", () => {
    clearEnv();
    vi.stubEnv("VSS_INSTANCE_SG_ID", "sg-0123456789abcdef0");
    vi.stubEnv("AWS_REGION", "");

    expect(sgManagementConfig()).toBeNull();
  });

  it("trims a value that arrives with surrounding whitespace", () => {
    clearEnv();
    vi.stubEnv("VSS_INSTANCE_SG_ID", " sg-trimmed \n");
    vi.stubEnv("AWS_REGION", " eu-west-3 ");

    expect(sgManagementConfig()).toEqual({ sgId: "sg-trimmed", region: "eu-west-3" });
  });
});

// ─── the EC2 client ────────────────────────────────────────────────────────────

describe("EC2Client construction", () => {
  it("is built for the region in the resolved config", async () => {
    mockEc2Send.mockResolvedValueOnce({ SecurityGroups: [] });

    await listSgIngress({ sgId: "sg-x", region: "ap-southeast-2" }, 443);

    expect(MockEC2Client).toHaveBeenCalledOnce();
    expect(MockEC2Client.mock.calls[0][0]).toMatchObject({ region: "ap-southeast-2" });
  });

  it("memoizes per region: two calls in one region build one client", async () => {
    mockEc2Send.mockResolvedValue({ SecurityGroups: [] });

    await listSgIngress({ sgId: "sg-memo-1", region: "eu-central-1" }, 443);
    await listSgIngress({ sgId: "sg-memo-2", region: "eu-central-1" }, 80);

    expect(MockEC2Client).toHaveBeenCalledOnce();
  });
});

// ─── listSgIngress ─────────────────────────────────────────────────────────────

describe("listSgIngress", () => {
  it("happy path: filters rules to the requested port", async () => {
    mockEc2Send.mockResolvedValueOnce({
      SecurityGroups: [
        {
          IpPermissions: [
            {
              FromPort: 443,
              ToPort: 443,
              IpProtocol: "tcp",
              IpRanges: [{ CidrIp: "10.0.0.1/32" }, { CidrIp: "10.0.0.2/32" }],
            },
            {
              FromPort: 80,
              ToPort: 80,
              IpProtocol: "tcp",
              IpRanges: [{ CidrIp: "10.0.0.3/32" }],
            },
          ],
        },
      ],
    });

    const rules = await listSgIngress(CFG, 443);

    expect(rules).toHaveLength(2);
    expect(rules[0]).toEqual({ cidr: "10.0.0.1/32", port: 443, protocol: "tcp" });
    expect(rules[1]).toEqual({ cidr: "10.0.0.2/32", port: 443, protocol: "tcp" });
    // Port-80 rules must NOT appear.
    expect(rules.find((r) => r.cidr === "10.0.0.3/32")).toBeUndefined();
  });

  it("empty: SDK returns no SecurityGroups → returns []", async () => {
    mockEc2Send.mockResolvedValueOnce({ SecurityGroups: [] });

    expect(await listSgIngress({ ...CFG, sgId: "sg-empty" }, 443)).toEqual([]);
  });

  it("multiple ports: only the requested port is returned", async () => {
    mockEc2Send.mockResolvedValueOnce({
      SecurityGroups: [
        {
          IpPermissions: [
            { FromPort: 22, ToPort: 22, IpProtocol: "tcp", IpRanges: [{ CidrIp: "1.2.3.4/32" }] },
            {
              FromPort: 8443,
              ToPort: 8443,
              IpProtocol: "tcp",
              IpRanges: [{ CidrIp: "5.6.7.8/32" }],
            },
          ],
        },
      ],
    });

    const rules = await listSgIngress({ ...CFG, sgId: "sg-multi" }, 22);

    expect(rules).toHaveLength(1);
    expect(rules[0].port).toBe(22);
    expect(rules[0].cidr).toBe("1.2.3.4/32");
  });

  it("handles missing IpRanges gracefully (no crash)", async () => {
    mockEc2Send.mockResolvedValueOnce({
      SecurityGroups: [
        { IpPermissions: [{ FromPort: 443, ToPort: 443, IpProtocol: "tcp" /* no IpRanges */ }] },
      ],
    });

    expect(await listSgIngress({ ...CFG, sgId: "sg-noranges" }, 443)).toEqual([]);
  });

  it("passes the config's group id to DescribeSecurityGroupsCommand", async () => {
    mockEc2Send.mockResolvedValueOnce({ SecurityGroups: [] });

    await listSgIngress({ ...CFG, sgId: "sg-test-id" }, 443);

    expect(mockEc2Send).toHaveBeenCalledOnce();
    const cmd = mockEc2Send.mock.calls[0][0];
    expect(cmd).toBeInstanceOf(DescribeSecurityGroupsCommand);
    expect(cmd.input.GroupIds).toEqual(["sg-test-id"]);
  });
});

// ─── authorizeSgIngress ────────────────────────────────────────────────────────

describe("authorizeSgIngress", () => {
  it("sends AuthorizeSecurityGroupIngressCommand with correct shape", async () => {
    mockEc2Send.mockResolvedValueOnce({});

    await authorizeSgIngress({ ...CFG, sgId: "sg-authorize" }, "203.0.113.5/32", 443);

    expect(mockEc2Send).toHaveBeenCalledOnce();
    const cmd = mockEc2Send.mock.calls[0][0];
    expect(cmd).toBeInstanceOf(AuthorizeSecurityGroupIngressCommand);

    const { GroupId, IpPermissions } = cmd.input;
    expect(GroupId).toBe("sg-authorize");
    expect(IpPermissions).toHaveLength(1);

    const perm = IpPermissions[0];
    expect(perm.IpProtocol).toBe("tcp");
    expect(perm.FromPort).toBe(443);
    expect(perm.ToPort).toBe(443);
    expect(perm.IpRanges).toHaveLength(1);
    expect(perm.IpRanges[0].CidrIp).toBe("203.0.113.5/32");
  });
});

// ─── revokeSgIngress ──────────────────────────────────────────────────────────

describe("revokeSgIngress", () => {
  it("sends RevokeSecurityGroupIngressCommand with correct shape", async () => {
    mockEc2Send.mockResolvedValueOnce({});

    await revokeSgIngress({ ...CFG, sgId: "sg-revoke" }, "198.51.100.0/24", 8443);

    expect(mockEc2Send).toHaveBeenCalledOnce();
    const cmd = mockEc2Send.mock.calls[0][0];
    expect(cmd).toBeInstanceOf(RevokeSecurityGroupIngressCommand);

    const { GroupId, IpPermissions } = cmd.input;
    expect(GroupId).toBe("sg-revoke");
    expect(IpPermissions).toHaveLength(1);

    const perm = IpPermissions[0];
    expect(perm.IpProtocol).toBe("tcp");
    expect(perm.FromPort).toBe(8443);
    expect(perm.ToPort).toBe(8443);
    expect(perm.IpRanges[0].CidrIp).toBe("198.51.100.0/24");
  });
});

describe("CONSOLE_INGRESS_PORT", () => {
  it("is the port the console serves on", () => {
    expect(CONSOLE_INGRESS_PORT).toBe(8800);
  });
});

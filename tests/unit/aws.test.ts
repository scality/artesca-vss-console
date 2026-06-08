import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── Hoisted mock spies ────────────────────────────────────────────────────────
//
// vi.mock() factories are hoisted to the top of the file by vitest's transform,
// BEFORE any `const` declarations in this module are initialised. We therefore
// create the spies with vi.hoisted() so they exist by the time the factory runs.

const { mockEc2Send, MockEC2Client, mockS3Send, mockMakeS3Client } =
  vi.hoisted(() => {
    const mockEc2Send = vi.fn();
    const MockEC2Client = vi.fn().mockImplementation(function (_config: unknown) {
      return { send: mockEc2Send };
    });
    const mockS3Send = vi.fn();
    const mockMakeS3Client = vi
      .fn()
      .mockReturnValue({ send: mockS3Send });
    return { mockEc2Send, MockEC2Client, mockS3Send, mockMakeS3Client };
  });

// ─── EC2 mock ──────────────────────────────────────────────────────────────────

vi.mock("@aws-sdk/client-ec2", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@aws-sdk/client-ec2")>();
  return {
    ...actual,
    EC2Client: MockEC2Client,
  };
});

// ─── S3 mock ───────────────────────────────────────────────────────────────────
//
// aws.ts calls makeS3Client() from @/lib/s3 rather than constructing S3Client
// directly, so we mock that helper module.

vi.mock("@/lib/s3", () => ({
  makeS3Client: mockMakeS3Client,
}));

// ─── SDK command classes ────────────────────────────────────────────────────────
// We still use the real command classes (only the clients are mocked) so we
// can assert `expect(cmd).toBeInstanceOf(...)`.

import {
  DescribeSecurityGroupsCommand,
  AuthorizeSecurityGroupIngressCommand,
  RevokeSecurityGroupIngressCommand,
} from "@aws-sdk/client-ec2";
import { ListObjectsV2Command } from "@aws-sdk/client-s3";

// ─── Module under test ─────────────────────────────────────────────────────────

import {
  listSgIngress,
  authorizeSgIngress,
  revokeSgIngress,
  s3Stats,
} from "@/lib/aws";

// ─── Lifecycle ─────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  // Re-apply default implementations after clearAllMocks resets them.
  MockEC2Client.mockImplementation(function (_config: unknown) {
    return { send: mockEc2Send };
  });
  mockMakeS3Client.mockReturnValue({ send: mockS3Send });
});

afterEach(() => {
  vi.unstubAllEnvs();
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
              IpRanges: [
                { CidrIp: "10.0.0.1/32" },
                { CidrIp: "10.0.0.2/32" },
              ],
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

    const rules = await listSgIngress("sg-abc", 443);

    expect(rules).toHaveLength(2);
    expect(rules[0]).toEqual({ cidr: "10.0.0.1/32", port: 443, protocol: "tcp" });
    expect(rules[1]).toEqual({ cidr: "10.0.0.2/32", port: 443, protocol: "tcp" });
    // Port-80 rules must NOT appear.
    expect(rules.find((r) => r.cidr === "10.0.0.3/32")).toBeUndefined();
  });

  it("empty: SDK returns no SecurityGroups → returns []", async () => {
    mockEc2Send.mockResolvedValueOnce({ SecurityGroups: [] });

    const rules = await listSgIngress("sg-empty", 443);

    expect(rules).toEqual([]);
  });

  it("multiple ports: only the requested port is returned", async () => {
    mockEc2Send.mockResolvedValueOnce({
      SecurityGroups: [
        {
          IpPermissions: [
            {
              FromPort: 22,
              ToPort: 22,
              IpProtocol: "tcp",
              IpRanges: [{ CidrIp: "1.2.3.4/32" }],
            },
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

    const rules = await listSgIngress("sg-multi", 22);

    expect(rules).toHaveLength(1);
    expect(rules[0].port).toBe(22);
    expect(rules[0].cidr).toBe("1.2.3.4/32");
  });

  it("handles missing IpRanges gracefully (no crash)", async () => {
    mockEc2Send.mockResolvedValueOnce({
      SecurityGroups: [
        {
          IpPermissions: [
            { FromPort: 443, ToPort: 443, IpProtocol: "tcp" /* no IpRanges */ },
          ],
        },
      ],
    });

    const rules = await listSgIngress("sg-noranges", 443);

    expect(rules).toEqual([]);
  });

  it("passes the correct GroupId to DescribeSecurityGroupsCommand", async () => {
    mockEc2Send.mockResolvedValueOnce({ SecurityGroups: [] });

    await listSgIngress("sg-test-id", 443);

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

    await authorizeSgIngress("sg-authorize", "203.0.113.5/32", 443);

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

    await revokeSgIngress("sg-revoke", "198.51.100.0/24", 8443);

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

// ─── s3Stats ──────────────────────────────────────────────────────────────────

describe("s3Stats", () => {
  it("single page: aggregates objectCount + bytesTotal correctly", async () => {
    mockS3Send.mockResolvedValueOnce({
      Contents: [{ Size: 1024 }, { Size: 2048 }, { Size: 512 }],
      NextContinuationToken: undefined,
    });

    const result = await s3Stats("my-bucket");

    expect(result.bucket).toBe("my-bucket");
    expect(result.objectCount).toBe(3);
    expect(result.bytesTotal).toBe(3584);
    expect(result.truncated).toBeFalsy();
  });

  it("multi-page: walks all pages and aggregates totals", async () => {
    mockS3Send
      .mockResolvedValueOnce({
        Contents: [{ Size: 100 }, { Size: 200 }],
        NextContinuationToken: "token-page-2",
      })
      .mockResolvedValueOnce({
        Contents: [{ Size: 300 }],
        NextContinuationToken: undefined,
      });

    const result = await s3Stats("paged-bucket");

    expect(result.objectCount).toBe(3);
    expect(result.bytesTotal).toBe(600);
    expect(result.truncated).toBeFalsy();

    // Confirm the second call passed the continuation token.
    const secondCall = mockS3Send.mock.calls[1][0];
    expect(secondCall).toBeInstanceOf(ListObjectsV2Command);
    expect(secondCall.input.ContinuationToken).toBe("token-page-2");
  });

  it("short walk (3 pages): truncated is NOT set", async () => {
    mockS3Send
      .mockResolvedValueOnce({
        Contents: [{ Size: 10 }],
        NextContinuationToken: "tok-2",
      })
      .mockResolvedValueOnce({
        Contents: [{ Size: 20 }],
        NextContinuationToken: "tok-3",
      })
      .mockResolvedValueOnce({
        Contents: [{ Size: 30 }],
        NextContinuationToken: undefined,
      });

    const result = await s3Stats("short-walk-bucket");

    expect(result.objectCount).toBe(3);
    expect(result.bytesTotal).toBe(60);
    expect(result.truncated).toBeFalsy();
  });

  it("empty bucket: objectCount=0, bytesTotal=0, no truncated flag", async () => {
    mockS3Send.mockResolvedValueOnce({
      Contents: undefined,
      NextContinuationToken: undefined,
    });

    const result = await s3Stats("empty-bucket");

    expect(result.objectCount).toBe(0);
    expect(result.bytesTotal).toBe(0);
    expect(result.truncated).toBeFalsy();
  });

  it("objects missing Size field default to 0 bytes", async () => {
    mockS3Send.mockResolvedValueOnce({
      Contents: [{ Size: undefined }, { Size: 500 }],
      NextContinuationToken: undefined,
    });

    const result = await s3Stats("partial-sizes-bucket");

    expect(result.objectCount).toBe(2);
    expect(result.bytesTotal).toBe(500);
  });

  it("passes the Bucket name into ListObjectsV2Command", async () => {
    mockS3Send.mockResolvedValueOnce({
      Contents: [],
      NextContinuationToken: undefined,
    });

    await s3Stats("specific-bucket");

    const cmd = mockS3Send.mock.calls[0][0];
    expect(cmd).toBeInstanceOf(ListObjectsV2Command);
    expect(cmd.input.Bucket).toBe("specific-bucket");
  });
});

// ─── Region resolution + memoization ──────────────────────────────────────────
//
// These tests re-import the module from scratch so the module-level Maps
// (_ec2Clients, _s3Clients) are empty at the start of each test.
// The MockEC2Client spy is shared because vi.mock() is module-level.

describe("EC2Client region resolution", () => {
  afterEach(() => {
    vi.resetModules();
  });

  it("uses OBJECTSTORE_REGION when set", async () => {
    vi.resetModules();
    delete process.env.OBJECTSTORE_REGION;
    delete process.env.AWS_REGION;
    vi.stubEnv("OBJECTSTORE_REGION", "us-east-2");
    vi.stubEnv("AWS_REGION", "eu-west-1"); // should be ignored

    MockEC2Client.mockClear();
    const freshSend = vi.fn().mockResolvedValue({ SecurityGroups: [] });
    MockEC2Client.mockImplementation(function () { return { send: freshSend }; });

    const { listSgIngress: listFresh } = await import("@/lib/aws");
    await listFresh("sg-x", 443);

    expect(MockEC2Client).toHaveBeenCalledOnce();
    expect(MockEC2Client.mock.calls[0][0]).toMatchObject({ region: "us-east-2" });
  });

  it("falls back to AWS_REGION when OBJECTSTORE_REGION is absent", async () => {
    vi.resetModules();
    delete process.env.OBJECTSTORE_REGION;
    vi.stubEnv("AWS_REGION", "us-east-1");

    MockEC2Client.mockClear();
    const freshSend = vi.fn().mockResolvedValue({ SecurityGroups: [] });
    MockEC2Client.mockImplementation(function () { return { send: freshSend }; });

    const { listSgIngress: listFresh } = await import("@/lib/aws");
    await listFresh("sg-y", 443);

    expect(MockEC2Client).toHaveBeenCalledOnce();
    expect(MockEC2Client.mock.calls[0][0]).toMatchObject({ region: "us-east-1" });
  });

  it("defaults to us-west-2 when neither env var is set", async () => {
    vi.resetModules();
    const savedObjectstore = process.env.OBJECTSTORE_REGION;
    const savedAws = process.env.AWS_REGION;
    delete process.env.OBJECTSTORE_REGION;
    delete process.env.AWS_REGION;

    MockEC2Client.mockClear();
    const freshSend = vi.fn().mockResolvedValue({ SecurityGroups: [] });
    MockEC2Client.mockImplementation(function () { return { send: freshSend }; });

    try {
      const { listSgIngress: listFresh } = await import("@/lib/aws");
      await listFresh("sg-z", 443);

      expect(MockEC2Client).toHaveBeenCalledOnce();
      expect(MockEC2Client.mock.calls[0][0]).toMatchObject({ region: "us-west-2" });
    } finally {
      if (savedObjectstore !== undefined)
        process.env.OBJECTSTORE_REGION = savedObjectstore;
      if (savedAws !== undefined) process.env.AWS_REGION = savedAws;
    }
  });

  it("memoizes: consecutive calls in the same region reuse the same EC2Client instance", async () => {
    vi.resetModules();
    const savedObjectstore = process.env.OBJECTSTORE_REGION;
    const savedAws = process.env.AWS_REGION;
    delete process.env.OBJECTSTORE_REGION;
    delete process.env.AWS_REGION;

    MockEC2Client.mockClear();
    const freshSend = vi.fn().mockResolvedValue({ SecurityGroups: [] });
    MockEC2Client.mockImplementation(function () { return { send: freshSend }; });

    try {
      const { listSgIngress: listFresh } = await import("@/lib/aws");

      // Two calls to the same default region.
      await listFresh("sg-memo-1", 443);
      await listFresh("sg-memo-2", 80);

      // Constructor called only once despite two listSgIngress calls.
      expect(MockEC2Client).toHaveBeenCalledOnce();
    } finally {
      if (savedObjectstore !== undefined)
        process.env.OBJECTSTORE_REGION = savedObjectstore;
      if (savedAws !== undefined) process.env.AWS_REGION = savedAws;
    }
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Regression guard for a false green that hid a multi-week outage.
 *
 * The preflight exercises the recorder's real credentials with a HeadBucket
 * call. HeadBucket is a READ. Hyperdrive refuses WRITES at its fill guard while
 * continuing to serve reads perfectly, so on pyramid-showroom this probe
 * reported "ok" for weeks while every recording upload failed with 503 and not
 * one segment was stored.
 *
 * Reachability is not writability. These tests pin that distinction.
 */

const headBucket = vi.fn(async () => ({}));
const readCapacity = vi.fn();

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    send = headBucket;
  },
  HeadBucketCommand: class {
    constructor(public input: unknown) {}
  },
}));

vi.mock("@/lib/helpers/configmaps", () => ({
  readConfigMapKey: async () => ({
    raw: JSON.stringify({
      data: {
        enable_cloud_storage: true,
        cloud_storage_endpoint: "http://artesca-data-connector-s3api.zenko.svc.cluster.local",
        cloud_storage_access_key: "AKIAEXAMPLE0000000000",
        cloud_storage_secret_key: "s".repeat(40),
        cloud_storage_bucket: "nvidia-vss-recordings",
        cloud_storage_use_ssl: false,
      },
    }),
  }),
}));

vi.mock("@/lib/helpers/artesca-capacity", () => ({
  readArtescaCapacity: readCapacity,
}));

async function preflight() {
  vi.resetModules();
  const mod = await import("@/lib/diagnostics/storage-preflight");
  return mod.collectStoragePreflight();
}

function capacity(fill: number, armed = true) {
  return {
    fillPercent: fill,
    writeProtectionArmed: armed,
    criticalPercent: 95,
    earlyPercent: 80,
    writesRefused: armed && fill >= 95,
    warning: fill >= 80 && fill < 95,
    checkedAt: new Date().toISOString(),
  };
}

describe("storage preflight vs the ARTESCA write guard", () => {
  beforeEach(() => {
    headBucket.mockClear();
    readCapacity.mockReset();
  });

  it("does NOT report ok when the bucket reads fine but ARTESCA refuses writes", async () => {
    readCapacity.mockResolvedValue(capacity(95.01474620595619));
    const r = await preflight();
    expect(headBucket).toHaveBeenCalled(); // the read genuinely succeeded
    expect(r.state).toBe("fail");
    expect(r.reason).toMatch(/refusing writes/i);
    expect(r.reason).toMatch(/95\.01/);
  });

  it("flags the early-warning band before writes are refused", async () => {
    readCapacity.mockResolvedValue(capacity(83.54));
    const r = await preflight();
    expect(r.state).toBe("fail");
    expect(r.reason).toMatch(/early-warning/i);
  });

  it("reports ok when the cluster is armed but comfortably below the guard", async () => {
    // The healthy steady state on ARTESCA 4.3: guard armed, plenty of room.
    readCapacity.mockResolvedValue(capacity(2.105294441440142));
    const r = await preflight();
    expect(r.state).toBe("ok");
  });

  it("stays ok when hyperdrive metrics are unreachable, since the write path just proved itself", async () => {
    readCapacity.mockResolvedValue(null);
    const r = await preflight();
    expect(r.state).toBe("ok");
  });

  it("still fails on a genuine bucket error, before capacity is ever consulted", async () => {
    headBucket.mockRejectedValueOnce(Object.assign(new Error("NoSuchBucket"), { name: "NoSuchBucket" }));
    readCapacity.mockResolvedValue(capacity(2));
    const r = await preflight();
    expect(r.state).toBe("fail");
    expect(readCapacity).not.toHaveBeenCalled();
  });
});

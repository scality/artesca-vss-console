import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Retention reporting must distinguish three states, because conflating the
 * first two is what let pyramid-showroom fill to hyperdrive's 95% write guard
 * unnoticed: the recordings bucket held 394,815 objects and 6.99 TiB with no
 * lifecycle rule at all, and nothing anywhere said so.
 *
 *   configured: true   → an enabled expiry exists; objects are reclaimed
 *   configured: false  → NO rule; nothing is EVER reclaimed (must not read as "unlimited")
 *   objectLock: true   → deletes refused regardless of any lifecycle rule
 */

const send = vi.fn();
vi.mock("@/lib/s3", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  makeS3Client: () => ({ send }),
}));

function isLifecycle(cmd: unknown) {
  return cmd?.constructor?.name?.includes("Lifecycle") ?? false;
}

async function readRetention(bucket: string) {
  const mod = await import("@/lib/storage-substrate");
  return mod.readRetention(bucket);
}

describe("readRetention", () => {
  beforeEach(() => {
    send.mockReset();
    vi.resetModules(); // the module caches per-bucket; a fresh module = a cold cache
  });

  it("reports an absent lifecycle rule as not-configured, not as unlimited retention", async () => {
    send.mockImplementation((cmd: unknown) => {
      throw new Error(
        isLifecycle(cmd) ? "NoSuchLifecycleConfiguration" : "ObjectLockConfigurationNotFoundError",
      );
    });
    const r = await readRetention("nvidia-vss-recordings");
    expect(r).toEqual({ configured: false, expiresDays: null, objectLock: false });
  });

  it("reports the shortest ENABLED expiry, ignoring disabled rules", async () => {
    send.mockImplementation((cmd: unknown) => {
      if (isLifecycle(cmd)) {
        return Promise.resolve({
          Rules: [
            { Status: "Enabled", Expiration: { Days: 90 } },
            { Status: "Enabled", Expiration: { Days: 14 } },
            { Status: "Disabled", Expiration: { Days: 1 } },
          ],
        });
      }
      throw new Error("ObjectLockConfigurationNotFoundError");
    });
    const r = await readRetention("nvidia-vss-recordings");
    expect(r.configured).toBe(true);
    expect(r.expiresDays).toBe(14);
  });

  it("surfaces Object Lock independently of any lifecycle rule", async () => {
    send.mockImplementation((cmd: unknown) => {
      if (isLifecycle(cmd)) throw new Error("NoSuchLifecycleConfiguration");
      return Promise.resolve({ ObjectLockConfiguration: { ObjectLockEnabled: "Enabled" } });
    });
    const r = await readRetention("nvidia-vss-evidence");
    expect(r).toEqual({ configured: false, expiresDays: null, objectLock: true });
  });

  it("a rule with no Expiration.Days does not count as configured", async () => {
    send.mockImplementation((cmd: unknown) => {
      if (isLifecycle(cmd)) {
        return Promise.resolve({
          Rules: [{ Status: "Enabled", NoncurrentVersionExpiration: { NoncurrentDays: 7 } }],
        });
      }
      throw new Error("ObjectLockConfigurationNotFoundError");
    });
    const r = await readRetention("nvidia-vss-alert-clips");
    expect(r.configured).toBe(false);
    expect(r.expiresDays).toBeNull();
  });
});

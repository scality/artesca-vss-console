import { describe, it, expect } from "vitest";
import { extractStorageKeys } from "./storage-preflight";

// The recorder's vst_config.json nests cloud_storage_* under `data` on the Helm
// alerts profile. Reading only the top level reported "cloud storage is
// disabled" for a recorder that was writing fine — a false alarm on every
// camera at once, which is worse than the missing badge this module replaced.

describe("extractStorageKeys", () => {
  it("finds the keys nested under data (Helm alerts profile shape)", () => {
    const doc = {
      network: { http_port: 8080 },
      data: {
        enable_cloud_storage: true,
        cloud_storage_type: "minio",
        cloud_storage_endpoint: "http://artesca-data-connector-s3api.zenko.svc.cluster.local:80",
        cloud_storage_access_key: "AKID",
        cloud_storage_secret_key: "SECRET",
        cloud_storage_bucket: "nvidia-vss-recordings",
        cloud_storage_use_ssl: false,
      },
      security: {},
    };
    const k = extractStorageKeys(doc);
    expect(k.enable_cloud_storage).toBe(true);
    expect(k.cloud_storage_bucket).toBe("nvidia-vss-recordings");
    expect(k.cloud_storage_endpoint).toMatch(/artesca-data-connector/);
  });

  it("still finds them at the top level", () => {
    const k = extractStorageKeys({
      enable_cloud_storage: true,
      cloud_storage_bucket: "b",
      cloud_storage_endpoint: "http://x",
    });
    expect(k.enable_cloud_storage).toBe(true);
    expect(k.cloud_storage_bucket).toBe("b");
  });

  it("returns nothing when the document has no storage block", () => {
    expect(extractStorageKeys({ network: { a: 1 }, data: { other: true } })).toEqual({});
  });

  it("tolerates arrays and nulls in the document", () => {
    const k = extractStorageKeys({
      list: [null, { deep: { cloud_storage_bucket: "found" } }],
    });
    expect(k.cloud_storage_bucket).toBe("found");
  });
});

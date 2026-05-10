import { describe, it, expect, vi, beforeEach } from "vitest";
import { stringify as yamlStringify } from "yaml";

// ── Module mocks ──────────────────────────────────────────────────────────────

const mockReadNamespacedConfigMap = vi.fn();
const mockPatchNamespacedConfigMap = vi.fn();

vi.mock("@/lib/k8s", () => ({
  coreV1: vi.fn(() => ({
    readNamespacedConfigMap: mockReadNamespacedConfigMap,
    patchNamespacedConfigMap: mockPatchNamespacedConfigMap,
    replaceNamespacedConfigMap: vi.fn(),
    createNamespacedConfigMap: vi.fn(),
  })),
}));

import {
  readConfigMapKey,
  patchConfigMapKey,
  patchConfigMapRawKey,
  replaceConfigMapData,
} from "@/lib/helpers/configmaps";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeConfigMap(data: Record<string, string>, resourceVersion = "42") {
  return {
    metadata: { resourceVersion },
    data,
  };
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  mockReadNamespacedConfigMap.mockReset();
  mockPatchNamespacedConfigMap.mockReset().mockResolvedValue({});
});

// ── readConfigMapKey ──────────────────────────────────────────────────────────

describe("readConfigMapKey", () => {
  it("happy path: returns parsed value, raw string, and resourceVersion", async () => {
    const yamlValue = yamlStringify({ foo: "bar", count: 3 });
    mockReadNamespacedConfigMap.mockResolvedValue(
      makeConfigMap({ "mykey.yaml": yamlValue }, "99"),
    );

    const result = await readConfigMapKey("default", "my-cm", "mykey.yaml");

    expect(result.value).toEqual({ foo: "bar", count: 3 });
    expect(result.raw).toBe(yamlValue);
    expect(result.resourceVersion).toBe("99");
    expect(mockReadNamespacedConfigMap).toHaveBeenCalledWith({
      name: "my-cm",
      namespace: "default",
    });
  });

  it("missing key returns empty string raw and null-ish parsed value", async () => {
    mockReadNamespacedConfigMap.mockResolvedValue(makeConfigMap({}));

    const result = await readConfigMapKey("ns", "cm", "absent-key");

    // yaml.parse("") returns undefined — the helper casts to T
    expect(result.raw).toBe("");
    expect(result.resourceVersion).toBe("42");
  });

  it("resourceVersion is undefined when metadata is absent", async () => {
    mockReadNamespacedConfigMap.mockResolvedValue({ data: { k: "v: 1\n" } });

    const result = await readConfigMapKey("ns", "cm", "k");

    expect(result.resourceVersion).toBeUndefined();
  });

  it("propagates K8s API error (e.g. 404 from read)", async () => {
    const err = Object.assign(new Error("Not Found"), { statusCode: 404 });
    mockReadNamespacedConfigMap.mockRejectedValueOnce(err);

    await expect(readConfigMapKey("ns", "missing-cm", "k")).rejects.toThrow("Not Found");
  });
});

// ── patchConfigMapKey ─────────────────────────────────────────────────────────

describe("patchConfigMapKey", () => {
  it("serialises value as YAML and calls patchNamespacedConfigMap with correct body", async () => {
    const value = { cameras: ["cam-01", "cam-02"] };

    await patchConfigMapKey("pyramid-ingress", "cameras", "cameras.yaml", value);

    expect(mockPatchNamespacedConfigMap).toHaveBeenCalledOnce();
    const [callArg] = mockPatchNamespacedConfigMap.mock.calls[0];
    expect(callArg.name).toBe("cameras");
    expect(callArg.namespace).toBe("pyramid-ingress");
    expect(callArg.body.data["cameras.yaml"]).toBe(yamlStringify(value));
    expect(callArg.body.metadata).toBeUndefined();
  });

  it("includes resourceVersion in metadata when provided (optimistic concurrency)", async () => {
    await patchConfigMapKey("ns", "cm", "key", { x: 1 }, "77");

    const [callArg] = mockPatchNamespacedConfigMap.mock.calls[0];
    expect(callArg.body.metadata).toEqual({ resourceVersion: "77" });
  });

  it("omits metadata block when resourceVersion is undefined", async () => {
    await patchConfigMapKey("ns", "cm", "key", {});

    const [callArg] = mockPatchNamespacedConfigMap.mock.calls[0];
    expect(callArg.body.metadata).toBeUndefined();
  });

  it("propagates K8s API error (e.g. 409 conflict)", async () => {
    const err = Object.assign(new Error("Conflict"), { statusCode: 409 });
    mockPatchNamespacedConfigMap.mockRejectedValueOnce(err);

    await expect(patchConfigMapKey("ns", "cm", "k", {}, "old-rv")).rejects.toThrow("Conflict");
  });
});

// ── patchConfigMapRawKey ──────────────────────────────────────────────────────

describe("patchConfigMapRawKey", () => {
  it("writes the raw string directly without YAML serialisation", async () => {
    const rawValue = "RTVI_VLM_SYSTEM_PROMPT=You are a retail analyst.\n";

    await patchConfigMapRawKey("rtvi", "rtvi-runtime-env", "PROMPT", rawValue);

    const [callArg] = mockPatchNamespacedConfigMap.mock.calls[0];
    expect(callArg.body.data["PROMPT"]).toBe(rawValue);
    expect(callArg.body.metadata).toBeUndefined();
  });

  it("includes resourceVersion when provided", async () => {
    await patchConfigMapRawKey("ns", "cm", "k", "v", "10");

    const [callArg] = mockPatchNamespacedConfigMap.mock.calls[0];
    expect(callArg.body.metadata).toEqual({ resourceVersion: "10" });
  });
});

// ── replaceConfigMapData ──────────────────────────────────────────────────────

describe("replaceConfigMapData", () => {
  it("passes the full data record as-is to patchNamespacedConfigMap", async () => {
    const data = { "a.yaml": "a: 1\n", "b.yaml": "b: 2\n" };

    await replaceConfigMapData("ns", "cm", data);

    const [callArg] = mockPatchNamespacedConfigMap.mock.calls[0];
    expect(callArg.body.data).toEqual(data);
    expect(callArg.body.metadata).toBeUndefined();
  });

  it("includes resourceVersion when provided", async () => {
    await replaceConfigMapData("ns", "cm", { k: "v" }, "55");

    const [callArg] = mockPatchNamespacedConfigMap.mock.calls[0];
    expect(callArg.body.metadata).toEqual({ resourceVersion: "55" });
  });
});

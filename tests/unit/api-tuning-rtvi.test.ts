import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Module mocks — declared before any imports that trigger the modules ──────

vi.mock("@/lib/auth", () => ({
  auth: vi.fn().mockResolvedValue({ user: { name: "operator", email: "operator@test.com" } }),
}));

vi.mock("@/lib/kiosk-server", () => ({
  rejectIfKiosk: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/k8s", () => ({
  coreV1: vi.fn(() => ({
    readNamespacedConfigMap: vi.fn(),
    patchNamespacedConfigMap: vi.fn(),
    replaceNamespacedConfigMap: vi.fn(),
  })),
  rolloutRestart: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/helpers/configmaps", () => ({
  readConfigMapKey: vi.fn(),
  patchConfigMapKey: vi.fn().mockResolvedValue(undefined),
  patchConfigMapRawKey: vi.fn().mockResolvedValue(undefined),
  replaceConfigMapData: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/helpers/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/errors", () => ({
  extractK8sError: vi.fn((err: unknown) => {
    if (err !== null && typeof err === "object") {
      const e = err as { code?: number; message?: string };
      return { status: e.code ?? 500, message: e.message ?? "kubernetes error" };
    }
    return { status: 500, message: String(err) };
  }),
}));

vi.mock("@/lib/helpers/docker-sock", () => ({
  dockerSock: vi.fn().mockResolvedValue({}),
  inspectContainer: vi.fn().mockResolvedValue(null),
  dockerRecreateWithEnv: vi.fn().mockResolvedValue({ id: "deadbeef1234" }),
  DOCKER_TUNING_DIR: "/tmp/test-tuning",
}));

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { rejectIfKiosk } from "@/lib/kiosk-server";
import { coreV1, rolloutRestart } from "@/lib/k8s";
import { patchConfigMapRawKey } from "@/lib/helpers/configmaps";
import { auditLog } from "@/lib/helpers/audit";

import { GET, PATCH } from "@/app/api/tuning/rtvi/route";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeRequest(method: string, body?: unknown): NextRequest {
  return new Request("http://localhost/api/tuning/rtvi", {
    method,
    ...(body !== undefined
      ? {
          body: JSON.stringify(body),
          headers: { "content-type": "application/json" },
        }
      : {}),
  }) as unknown as NextRequest;
}

// ── Setup ────────────────────────────────────────────────────────────────────

let mockCoreV1Api: {
  readNamespacedConfigMap: ReturnType<typeof vi.fn>;
  patchNamespacedConfigMap: ReturnType<typeof vi.fn>;
  replaceNamespacedConfigMap: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  mockCoreV1Api = {
    readNamespacedConfigMap: vi.fn().mockResolvedValue({
      metadata: { resourceVersion: "77" },
      data: {
        NIM_MAX_NUM_SEQS: "8",
        VLM_NIM_KVCACHE_PERCENT: "0.75",
        NIM_MAX_MODEL_LEN: "16384",
      },
    }),
    patchNamespacedConfigMap: vi.fn().mockResolvedValue({}),
    replaceNamespacedConfigMap: vi.fn().mockResolvedValue({}),
  };

  vi.mocked(auth).mockReset().mockResolvedValue({
    user: { name: "operator", email: "operator@test.com" },
  } as never);
  vi.mocked(rejectIfKiosk).mockReset().mockResolvedValue(null);
  vi.mocked(coreV1).mockReset().mockReturnValue(mockCoreV1Api as never);
  vi.mocked(rolloutRestart).mockReset().mockResolvedValue(undefined);
  vi.mocked(patchConfigMapRawKey).mockReset().mockResolvedValue(undefined);
  vi.mocked(auditLog).mockReset().mockResolvedValue(undefined);

  delete process.env.CONSOLE_RUNTIME;
});

// ── GET ──────────────────────────────────────────────────────────────────────

describe("GET /api/tuning/rtvi", () => {
  it("auth missing → 401", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);

    const res = await GET();

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toMatch(/unauthorized/i);
  });

  it("happy path: ConfigMap present → returns parsed maxNumSeqs, kvCachePct, maxModelLen", async () => {
    mockCoreV1Api.readNamespacedConfigMap.mockResolvedValue({
      metadata: { resourceVersion: "77" },
      data: {
        NIM_MAX_NUM_SEQS: "8",
        VLM_NIM_KVCACHE_PERCENT: "0.75",
        NIM_MAX_MODEL_LEN: "16384",
      },
    });
    vi.mocked(coreV1).mockReturnValue(mockCoreV1Api as never);

    const res = await GET();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.maxNumSeqs).toBe(8);
    expect(body.kvCachePct).toBe(0.75);
    expect(body.maxModelLen).toBe(16384);
  });

  it("ConfigMap data keys absent → returns RTVI defaults (4, 0.8, 32768)", async () => {
    mockCoreV1Api.readNamespacedConfigMap.mockResolvedValue({
      metadata: { resourceVersion: "1" },
      data: {},
    });
    vi.mocked(coreV1).mockReturnValue(mockCoreV1Api as never);

    const res = await GET();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.maxNumSeqs).toBe(4);
    expect(body.kvCachePct).toBe(0.8);
    expect(body.maxModelLen).toBe(32768);
  });

  it("ConfigMap read fails → returns error status from extractK8sError", async () => {
    mockCoreV1Api.readNamespacedConfigMap.mockRejectedValue(
      Object.assign(new Error("not found"), { code: 404 }),
    );
    vi.mocked(coreV1).mockReturnValue(mockCoreV1Api as never);

    const res = await GET();

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBeDefined();
    expect(body.k8sCode).toBe(404);
  });

  it("ConfigMap data has empty string for numeric keys → falls back to defaults", async () => {
    mockCoreV1Api.readNamespacedConfigMap.mockResolvedValue({
      metadata: { resourceVersion: "2" },
      data: {
        NIM_MAX_NUM_SEQS: "",
        VLM_NIM_KVCACHE_PERCENT: "",
        NIM_MAX_MODEL_LEN: "",
      },
    });
    vi.mocked(coreV1).mockReturnValue(mockCoreV1Api as never);

    const res = await GET();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.maxNumSeqs).toBe(4);
    expect(body.kvCachePct).toBe(0.8);
    expect(body.maxModelLen).toBe(32768);
  });
});

// ── PATCH ─────────────────────────────────────────────────────────────────────

describe("PATCH /api/tuning/rtvi", () => {
  it("auth missing → 401, no K8s calls", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);

    const req = makeRequest("PATCH", { maxNumSeqs: 8 });
    const res = await PATCH(req);

    expect(res.status).toBe(401);
    expect(patchConfigMapRawKey).not.toHaveBeenCalled();
  });

  it("kiosk mode → 403, no K8s calls", async () => {
    vi.mocked(rejectIfKiosk).mockResolvedValue(
      NextResponse.json({ error: "kiosk mode is read-only" }, { status: 403 }),
    );

    const req = makeRequest("PATCH", { maxNumSeqs: 8 });
    const res = await PATCH(req);

    expect(res.status).toBe(403);
    expect(patchConfigMapRawKey).not.toHaveBeenCalled();
  });

  it("invalid body: empty object (no fields) → 400 (refine fails), no K8s calls", async () => {
    const req = makeRequest("PATCH", {});
    const res = await PATCH(req);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBeDefined();
    expect(patchConfigMapRawKey).not.toHaveBeenCalled();
  });

  it("invalid body: maxNumSeqs not positive integer (0) → 400", async () => {
    const req = makeRequest("PATCH", { maxNumSeqs: 0 });
    const res = await PATCH(req);

    expect(res.status).toBe(400);
    expect(patchConfigMapRawKey).not.toHaveBeenCalled();
  });

  it("invalid body: kvCachePercent out of range (>1) → 400", async () => {
    const req = makeRequest("PATCH", { kvCachePercent: 1.5 });
    const res = await PATCH(req);

    expect(res.status).toBe(400);
    expect(patchConfigMapRawKey).not.toHaveBeenCalled();
  });

  it("happy path: valid maxNumSeqs → ConfigMap patched, NIM StatefulSet restarted, audit logged, 200 ok:true", async () => {
    const req = makeRequest("PATCH", { maxNumSeqs: 16 });
    const res = await PATCH(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.applied).toBeDefined();
    expect(body.restarted).toMatch(/cosmos-reason2-8b/);

    expect(patchConfigMapRawKey).toHaveBeenCalledWith(
      "rtvi",
      "rtvi-runtime-env",
      "NIM_MAX_NUM_SEQS",
      "16",
    );
    expect(rolloutRestart).toHaveBeenCalledWith("StatefulSet", "rtvi", "cosmos-reason2-8b");
    expect(auditLog).toHaveBeenCalledWith(
      "tuning-rtvi",
      expect.stringContaining("cosmos-reason2-8b"),
      expect.objectContaining({ patches: expect.objectContaining({ NIM_MAX_NUM_SEQS: "16" }) }),
    );
  });

  it("ConfigMap patch fails → error status from extractK8sError, audit not called", async () => {
    vi.mocked(patchConfigMapRawKey).mockRejectedValue(
      Object.assign(new Error("k8s write error"), { code: 500 }),
    );

    const req = makeRequest("PATCH", { maxNumSeqs: 4 });
    const res = await PATCH(req);

    expect(res.status).toBe(500);
    expect(auditLog).not.toHaveBeenCalled();
  });

  it("rollout restart fails → 502, audit not called", async () => {
    vi.mocked(rolloutRestart).mockRejectedValue(new Error("NIM restart failed"));

    const req = makeRequest("PATCH", { maxNumSeqs: 4 });
    const res = await PATCH(req);

    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toMatch(/rollout restart failed/i);
    expect(auditLog).not.toHaveBeenCalled();
  });
});

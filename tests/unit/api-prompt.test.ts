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
  watchedNamespaces: vi.fn(() => ["pyramid-ingress", "alerts", "rtvi"]),
}));

vi.mock("@/lib/helpers/gcs-config", () => ({
  gcsPromptGet: vi.fn().mockResolvedValue(null),
  gcsPromptPut: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/helpers/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));

// patchConfigMapRawKey is called directly by the prompt route.
vi.mock("@/lib/helpers/configmaps", () => ({
  readConfigMapKey: vi.fn(),
  patchConfigMapKey: vi.fn().mockResolvedValue(undefined),
  patchConfigMapRawKey: vi.fn().mockResolvedValue(undefined),
  replaceConfigMapData: vi.fn().mockResolvedValue(undefined),
}));

// Docker-sock used only in docker mode.
vi.mock("@/lib/helpers/docker-sock", () => ({
  dockerSock: vi.fn().mockResolvedValue({}),
  inspectContainer: vi.fn().mockResolvedValue({
    Config: { Env: ["VLM_SYSTEM_PROMPT=default prompt", "VIA_VLM_OPENAI_MODEL_DEPLOYMENT_NAME=cosmos-model"] },
  }),
  dockerRecreateWithEnv: vi.fn().mockResolvedValue({ id: "abc123def456" }),
}));

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { rejectIfKiosk } from "@/lib/kiosk-server";
import { coreV1, rolloutRestart } from "@/lib/k8s";
import { gcsPromptGet, gcsPromptPut } from "@/lib/helpers/gcs-config";
import { patchConfigMapRawKey } from "@/lib/helpers/configmaps";
import { auditLog } from "@/lib/helpers/audit";

import { GET, PATCH } from "@/app/api/prompt/route";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeRequest(method: string, body?: unknown): NextRequest {
  return new Request("http://localhost/api/prompt", {
    method,
    ...(body !== undefined
      ? {
          body: JSON.stringify(body),
          headers: { "content-type": "application/json" },
        }
      : {}),
  }) as unknown as NextRequest;
}

const VALID_PROMPT_BODY = {
  prompt: "You are an AI camera operator for a retail store. Detect theft and suspicious behavior.",
};

// ── Setup ────────────────────────────────────────────────────────────────────

let mockCoreV1Api: {
  readNamespacedConfigMap: ReturnType<typeof vi.fn>;
  patchNamespacedConfigMap: ReturnType<typeof vi.fn>;
  replaceNamespacedConfigMap: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  mockCoreV1Api = {
    readNamespacedConfigMap: vi.fn().mockResolvedValue({
      metadata: { resourceVersion: "99999" },
      data: {
        RTVI_VLM_SYSTEM_PROMPT: "existing prompt text",
        RTVI_VLM_OPENAI_MODEL_DEPLOYMENT_NAME: "cosmos-model",
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
  vi.mocked(gcsPromptGet).mockReset().mockResolvedValue(null);
  vi.mocked(gcsPromptPut).mockReset().mockResolvedValue(undefined);
  vi.mocked(patchConfigMapRawKey).mockReset().mockResolvedValue(undefined);
  vi.mocked(auditLog).mockReset().mockResolvedValue(undefined);

  delete process.env.VSS_INSTANCE_NAME;
  delete process.env.CONSOLE_RUNTIME;
});

// ── GET ──────────────────────────────────────────────────────────────────────

describe("GET /api/prompt", () => {
  it("auth missing → 401", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);

    const res = await GET();

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toMatch(/unauthorized/i);
  });

  it("happy path: ConfigMap readable → returns prompt and model from ConfigMap", async () => {
    mockCoreV1Api.readNamespacedConfigMap.mockResolvedValue({
      metadata: { resourceVersion: "99999" },
      data: {
        RTVI_VLM_SYSTEM_PROMPT: "existing prompt text",
        RTVI_VLM_OPENAI_MODEL_DEPLOYMENT_NAME: "cosmos-model",
      },
    });
    vi.mocked(coreV1).mockReturnValue(mockCoreV1Api as never);

    const res = await GET();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.prompt).toBe("existing prompt text");
    expect(body.model).toBe("cosmos-model");
    expect(body.resourceVersion).toBe("99999");
    expect(body.gcs.available).toBe(false);
  });

  it("ConfigMap read fails → 502 with empty prompt and warning, no stack leak", async () => {
    mockCoreV1Api.readNamespacedConfigMap.mockRejectedValue(new Error("k8s connection refused"));
    vi.mocked(coreV1).mockReturnValue(mockCoreV1Api as never);

    const res = await GET();

    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.prompt).toBe("");
    expect(body.warnings).toBeDefined();
    expect(body.warnings.length).toBeGreaterThan(0);
    // No raw stack trace in the response
    const bodyText = JSON.stringify(body);
    expect(bodyText).not.toContain("at Object.");
  });

  it("ConfigMap readable but prompt empty, no VSS_INSTANCE_NAME → gcs.available is false", async () => {
    // VSS_INSTANCE_NAME is a const captured at module load time (empty string in tests).
    // GCS fetch is skipped → gcs.available is always false when VSS_INSTANCE_NAME is empty.
    mockCoreV1Api.readNamespacedConfigMap.mockResolvedValue({
      metadata: { resourceVersion: "1" },
      data: { RTVI_VLM_SYSTEM_PROMPT: "" },
    });
    vi.mocked(coreV1).mockReturnValue(mockCoreV1Api as never);

    const res = await GET();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.prompt).toBe("");
    expect(body.gcs.available).toBe(false);
  });

  it("both ConfigMap and GCS fail → 502 with safe error message", async () => {
    mockCoreV1Api.readNamespacedConfigMap.mockRejectedValue(new Error("k8s error"));
    vi.mocked(coreV1).mockReturnValue(mockCoreV1Api as never);
    process.env.VSS_INSTANCE_NAME = "test-instance";
    vi.mocked(gcsPromptGet).mockRejectedValue(new Error("gcs error"));

    const res = await GET();

    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.prompt).toBe("");
    expect(body.gcs.available).toBe(false);
  });
});

// ── PATCH ─────────────────────────────────────────────────────────────────────

describe("PATCH /api/prompt", () => {
  it("auth missing → 401", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);

    const req = makeRequest("PATCH", VALID_PROMPT_BODY);
    const res = await PATCH(req);

    expect(res.status).toBe(401);
    expect(patchConfigMapRawKey).not.toHaveBeenCalled();
  });

  it("kiosk mode: rejectIfKiosk returns 403 → short-circuits, no K8s/GCS calls", async () => {
    const kioskResponse = NextResponse.json({ error: "kiosk mode is read-only" }, { status: 403 });
    vi.mocked(rejectIfKiosk).mockResolvedValue(kioskResponse);

    const req = makeRequest("PATCH", VALID_PROMPT_BODY);
    const res = await PATCH(req);

    expect(res.status).toBe(403);
    expect(patchConfigMapRawKey).not.toHaveBeenCalled();
    expect(gcsPromptPut).not.toHaveBeenCalled();
  });

  it("invalid body: empty prompt (min(1) fails) → 400, no K8s/GCS calls", async () => {
    const req = makeRequest("PATCH", { prompt: "" });
    const res = await PATCH(req);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBeDefined();
    expect(patchConfigMapRawKey).not.toHaveBeenCalled();
    expect(gcsPromptPut).not.toHaveBeenCalled();
  });

  it("invalid body: missing prompt field → 400", async () => {
    const req = makeRequest("PATCH", { model: "cosmos-model" });
    const res = await PATCH(req);

    expect(res.status).toBe(400);
    expect(patchConfigMapRawKey).not.toHaveBeenCalled();
  });

  it("happy path: valid body → ConfigMap patched, rollout restarted, audit logged, 200 with ok:true", async () => {
    const req = makeRequest("PATCH", VALID_PROMPT_BODY);
    const res = await PATCH(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    // Prompt key patched
    expect(patchConfigMapRawKey).toHaveBeenCalledWith(
      expect.any(String), // namespace
      expect.any(String), // configMap name
      "RTVI_VLM_SYSTEM_PROMPT",
      VALID_PROMPT_BODY.prompt,
      expect.anything(), // resourceVersion (could be undefined)
    );
    expect(rolloutRestart).toHaveBeenCalledWith("Deployment", expect.any(String), expect.any(String));
    expect(auditLog).toHaveBeenCalledWith(
      "prompt-update",
      expect.stringContaining("configmap"),
      expect.objectContaining({ promptLength: VALID_PROMPT_BODY.prompt.length }),
    );
  });

  it("valid body with model field → model key also patched, NIM StatefulSet restart attempted", async () => {
    const req = makeRequest("PATCH", { ...VALID_PROMPT_BODY, model: "new-nim-model" });
    const res = await PATCH(req);

    expect(res.status).toBe(200);
    // Both prompt and model keys are patched
    expect(patchConfigMapRawKey).toHaveBeenCalledTimes(2);
    expect(patchConfigMapRawKey).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      "RTVI_VLM_OPENAI_MODEL_DEPLOYMENT_NAME",
      "new-nim-model",
    );
    // StatefulSet restart attempted for NIM
    expect(rolloutRestart).toHaveBeenCalledWith("StatefulSet", expect.any(String), expect.any(String));
  });

  it("ConfigMap patch fails (non-409) → 502; GCS NOT pushed, audit NOT called", async () => {
    vi.mocked(patchConfigMapRawKey).mockRejectedValue(
      Object.assign(new Error("k8s patch error"), { code: 500 }),
    );

    const req = makeRequest("PATCH", VALID_PROMPT_BODY);
    const res = await PATCH(req);

    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toMatch(/configmap patch failed/i);
    expect(gcsPromptPut).not.toHaveBeenCalled();
    expect(auditLog).not.toHaveBeenCalled();
  });

  it("ConfigMap patch returns 409 conflict → 409 with reload message; GCS NOT pushed", async () => {
    vi.mocked(patchConfigMapRawKey).mockRejectedValue(
      Object.assign(new Error("conflict"), { code: 409 }),
    );

    const req = makeRequest("PATCH", VALID_PROMPT_BODY);
    const res = await PATCH(req);

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/reload/i);
    expect(gcsPromptPut).not.toHaveBeenCalled();
  });

  it("GCS push skipped when VSS_INSTANCE_NAME empty → 200 with no gcsWarnings; gcsPromptPut not called", async () => {
    // VSS_INSTANCE_NAME is captured as a const at module load → always "" in tests.
    // Without it set, the GCS write branch is skipped entirely.
    const req = makeRequest("PATCH", VALID_PROMPT_BODY);
    const res = await PATCH(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    // No GCS write attempted when instance name is empty
    expect(gcsPromptPut).not.toHaveBeenCalled();
    expect(body.gcsWarnings).toBeUndefined();
  });
});

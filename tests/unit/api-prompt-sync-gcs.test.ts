import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Module mocks — declared before any imports that trigger the modules ──────

vi.mock("@/lib/auth", () => ({
  auth: vi.fn().mockResolvedValue({ user: { name: "operator", email: "operator@test.com" } }),
}));

vi.mock("@/lib/helpers/prompt-apply", () => ({
  readPromptLive: vi.fn().mockResolvedValue("You are an AI operator."),
  applyPromptLive: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/helpers/gcs-config", () => ({
  gcsPromptPut: vi.fn().mockResolvedValue(undefined),
  gcsPromptGet: vi.fn().mockResolvedValue(null),
}));


// configmaps is transitively imported by prompt-apply in k8s mode — stub it.
vi.mock("@/lib/helpers/configmaps", () => ({
  readConfigMapKey: vi.fn(),
  patchConfigMapKey: vi.fn().mockResolvedValue(undefined),
  patchConfigMapRawKey: vi.fn().mockResolvedValue(undefined),
  replaceConfigMapData: vi.fn().mockResolvedValue(undefined),
}));

// cluster-refs pulls next/headers via a transitive chain — already stubbed in
// tests/setup.ts, but k8s client factories need a dummy stub too.
vi.mock("@/lib/k8s", () => ({
  coreV1: vi.fn(() => ({ readNamespacedConfigMap: vi.fn() })),
  rolloutRestart: vi.fn().mockResolvedValue(undefined),
}));

import { auth } from "@/lib/auth";
import { readPromptLive } from "@/lib/helpers/prompt-apply";
import { gcsPromptPut } from "@/lib/helpers/gcs-config";

import { POST } from "@/app/api/prompt/sync-gcs/route";

// ── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.mocked(auth).mockReset().mockResolvedValue({
    user: { name: "operator", email: "operator@test.com" },
  } as never);
  vi.mocked(readPromptLive).mockReset().mockResolvedValue("You are an AI operator.");
  vi.mocked(gcsPromptPut).mockReset().mockResolvedValue(undefined);

  delete process.env.VSS_INSTANCE_NAME;
});

// ── POST /api/prompt/sync-gcs ────────────────────────────────────────────────

describe("POST /api/prompt/sync-gcs", () => {
  it("auth missing → 401, no read or GCS calls", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);

    const res = await POST();

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toMatch(/unauthorized/i);
    expect(readPromptLive).not.toHaveBeenCalled();
    expect(gcsPromptPut).not.toHaveBeenCalled();
  });

  it("VSS_INSTANCE_NAME not set → 400, no read or GCS calls", async () => {
    // The module const is captured at import time; it is "" in the test environment.
    const res = await POST();

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/VSS_INSTANCE_NAME/);
    expect(readPromptLive).not.toHaveBeenCalled();
    expect(gcsPromptPut).not.toHaveBeenCalled();
  });

  it("readPromptLive throws → 502 with extracted message", async () => {
    // This branch requires VSS_INSTANCE_NAME to be set at module load time, so
    // we cannot reach it via the top-level module (captured const = ""). Verify
    // the guard ordering: 400 exits before readPromptLive is ever called.
    vi.mocked(readPromptLive).mockRejectedValue(new Error("docker socket unreachable"));

    const res = await POST();

    expect(res.status).toBe(400); // exits at instance-name guard
    expect(readPromptLive).not.toHaveBeenCalled();
  });

  it("gcsPromptPut throws → exits at instance-name guard in default test env", async () => {
    vi.mocked(gcsPromptPut).mockRejectedValue(new Error("GCS write timeout"));

    const res = await POST();

    expect(res.status).toBe(400);
    expect(gcsPromptPut).not.toHaveBeenCalled();
  });
});

// ── Integration-style tests with module re-import ─────────────────────────────
//
// VSS_INSTANCE_NAME is a top-level const. Use vi.resetModules() + dynamic import
// to exercise the branches that require a non-empty instance name.

describe("POST /api/prompt/sync-gcs — with VSS_INSTANCE_NAME set", () => {
  it("happy path: readPromptLive returns → gcsPromptPut called → 200 with ok:true + promptLength", async () => {
    process.env.VSS_INSTANCE_NAME = "test-instance";

    vi.resetModules();
    vi.doMock("@/lib/auth", () => ({
      auth: vi.fn().mockResolvedValue({ user: { name: "op", email: "op@test.com" } }),
    }));
    vi.doMock("@/lib/helpers/prompt-apply", () => ({
      readPromptLive: vi.fn().mockResolvedValue("Detect suspicious behaviour."),
      applyPromptLive: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock("@/lib/helpers/gcs-config", () => ({
      gcsPromptPut: vi.fn().mockResolvedValue(undefined),
      gcsPromptGet: vi.fn().mockResolvedValue(null),
    }));
    vi.doMock("@/lib/helpers/docker-sock", () => ({
      dockerSock: vi.fn().mockResolvedValue({}),
      dockerRecreateWithEnv: vi.fn().mockResolvedValue({ id: "abc" }),
    }));
    vi.doMock("@/lib/helpers/configmaps", () => ({
      readConfigMapKey: vi.fn(),
      patchConfigMapRawKey: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock("@/lib/k8s", () => ({
      coreV1: vi.fn(() => ({ readNamespacedConfigMap: vi.fn() })),
      rolloutRestart: vi.fn().mockResolvedValue(undefined),
    }));

    const { POST: POST2 } = await import("@/app/api/prompt/sync-gcs/route");
    const { gcsPromptPut: put2 } = await import("@/lib/helpers/gcs-config");

    const res = await POST2();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.instance).toBe("test-instance");
    expect(body.promptLength).toBe("Detect suspicious behaviour.".length);
    expect(put2).toHaveBeenCalledOnce();
    expect(put2).toHaveBeenCalledWith(
      expect.objectContaining({
        schema: "isv-labs.prompt.v1",
        instance: "test-instance",
        prompt: "Detect suspicious behaviour.",
      }),
    );

    delete process.env.VSS_INSTANCE_NAME;
    vi.resetModules();
  });

  it("readPromptLive throws → 502 with extracted error message", async () => {
    process.env.VSS_INSTANCE_NAME = "test-instance";

    vi.resetModules();
    vi.doMock("@/lib/auth", () => ({
      auth: vi.fn().mockResolvedValue({ user: { name: "op", email: "op@test.com" } }),
    }));
    vi.doMock("@/lib/helpers/prompt-apply", () => ({
      readPromptLive: vi.fn().mockRejectedValue(new Error("docker socket unreachable")),
      applyPromptLive: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock("@/lib/helpers/gcs-config", () => ({
      gcsPromptPut: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock("@/lib/helpers/docker-sock", () => ({
      dockerSock: vi.fn().mockResolvedValue({}),
      dockerRecreateWithEnv: vi.fn().mockResolvedValue({ id: "abc" }),
    }));
    vi.doMock("@/lib/helpers/configmaps", () => ({
      readConfigMapKey: vi.fn(),
      patchConfigMapRawKey: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock("@/lib/k8s", () => ({
      coreV1: vi.fn(() => ({ readNamespacedConfigMap: vi.fn() })),
      rolloutRestart: vi.fn().mockResolvedValue(undefined),
    }));

    const { POST: POST2 } = await import("@/app/api/prompt/sync-gcs/route");

    const res = await POST2();

    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toMatch(/Failed to read live prompt/);
    expect(body.error).toContain("docker socket unreachable");

    delete process.env.VSS_INSTANCE_NAME;
    vi.resetModules();
  });

  it("gcsPromptPut throws → 502 with GCS write error", async () => {
    process.env.VSS_INSTANCE_NAME = "test-instance";

    vi.resetModules();
    vi.doMock("@/lib/auth", () => ({
      auth: vi.fn().mockResolvedValue({ user: { name: "op", email: "op@test.com" } }),
    }));
    vi.doMock("@/lib/helpers/prompt-apply", () => ({
      readPromptLive: vi.fn().mockResolvedValue("A prompt."),
      applyPromptLive: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock("@/lib/helpers/gcs-config", () => ({
      gcsPromptPut: vi.fn().mockRejectedValue(new Error("GCS quota exceeded")),
    }));
    vi.doMock("@/lib/helpers/docker-sock", () => ({
      dockerSock: vi.fn().mockResolvedValue({}),
      dockerRecreateWithEnv: vi.fn().mockResolvedValue({ id: "abc" }),
    }));
    vi.doMock("@/lib/helpers/configmaps", () => ({
      readConfigMapKey: vi.fn(),
      patchConfigMapRawKey: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock("@/lib/k8s", () => ({
      coreV1: vi.fn(() => ({ readNamespacedConfigMap: vi.fn() })),
      rolloutRestart: vi.fn().mockResolvedValue(undefined),
    }));

    const { POST: POST2 } = await import("@/app/api/prompt/sync-gcs/route");

    const res = await POST2();

    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toMatch(/GCS write failed/);
    expect(body.error).toContain("GCS quota exceeded");

    delete process.env.VSS_INSTANCE_NAME;
    vi.resetModules();
  });
});

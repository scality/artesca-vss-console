import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Module mocks — declared before any imports that trigger the modules ──────

vi.mock("@/lib/auth", () => ({
  auth: vi.fn().mockResolvedValue({ user: { name: "operator", email: "operator@test.com" } }),
}));

vi.mock("@/lib/helpers/gcs-config", () => ({
  gcsScenariosPut: vi.fn().mockResolvedValue(undefined),
  gcsScenariosGet: vi.fn().mockResolvedValue(null),
}));

// readConfigMapKey is called in k8s mode (CONSOLE_RUNTIME !== "docker").
vi.mock("@/lib/helpers/configmaps", () => ({
  readConfigMapKey: vi.fn().mockResolvedValue({
    value: {
      scenarios: [
        {
          id: "theft",
          name: "Theft Detection",
          severity: "high",
          channels: ["ui"],
          keywords: ["steal", "pocket"],
          enabled: true,
        },
      ],
    },
  }),
  patchConfigMapKey: vi.fn().mockResolvedValue(undefined),
  patchConfigMapRawKey: vi.fn().mockResolvedValue(undefined),
  replaceConfigMapData: vi.fn().mockResolvedValue(undefined),
}));

// k8s is transitively imported through cluster-refs / configmaps — stub it out.
vi.mock("@/lib/k8s", () => ({
  coreV1: vi.fn(() => ({ readNamespacedConfigMap: vi.fn() })),
  rolloutRestart: vi.fn().mockResolvedValue(undefined),
}));

// fs/promises is used in docker mode only.
vi.mock("fs/promises", () => ({
  default: {
    readFile: vi.fn().mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" })),
    writeFile: vi.fn().mockResolvedValue(undefined),
    mkdir: vi.fn().mockResolvedValue(undefined),
  },
}));

import { auth } from "@/lib/auth";
import { gcsScenariosPut } from "@/lib/helpers/gcs-config";
import { readConfigMapKey } from "@/lib/helpers/configmaps";

import { POST } from "@/app/api/scenarios/sync-gcs/route";

// ── Helpers ──────────────────────────────────────────────────────────────────

const SCENARIO_CM_VALUE = {
  scenarios: [
    {
      id: "theft",
      name: "Theft Detection",
      severity: "high",
      channels: ["ui"],
      keywords: ["steal", "pocket"],
      enabled: true,
    },
    {
      id: "slip",
      name: "Slip and Fall",
      severity: "medium",
      channels: ["ui", "slack"],
      keywords: ["fall", "slip"],
      enabled: true,
    },
  ],
};

// ── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.mocked(auth).mockReset().mockResolvedValue({
    user: { name: "operator", email: "operator@test.com" },
  } as never);
  vi.mocked(gcsScenariosPut).mockReset().mockResolvedValue(undefined);
  vi.mocked(readConfigMapKey).mockReset().mockResolvedValue({ value: SCENARIO_CM_VALUE } as never);

  delete process.env.VSS_INSTANCE_NAME;
  delete process.env.CONSOLE_RUNTIME;
});

// ── POST /api/scenarios/sync-gcs ─────────────────────────────────────────────

describe("POST /api/scenarios/sync-gcs", () => {
  it("auth missing → 401, no ConfigMap or GCS calls", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);

    const res = await POST();

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toMatch(/unauthorized/i);
    expect(readConfigMapKey).not.toHaveBeenCalled();
    expect(gcsScenariosPut).not.toHaveBeenCalled();
  });

  it("VSS_INSTANCE_NAME not set → 400, no ConfigMap or GCS calls", async () => {
    // The module const is captured at import time; it is "" in the test environment.
    const res = await POST();

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/VSS_INSTANCE_NAME/);
    expect(readConfigMapKey).not.toHaveBeenCalled();
    expect(gcsScenariosPut).not.toHaveBeenCalled();
  });

  it("readConfigMapKey throws → exits at instance-name guard in default test env", async () => {
    vi.mocked(readConfigMapKey).mockRejectedValue(new Error("k8s connection refused"));

    const res = await POST();

    // Exits at 400 (instance name guard) before reaching the ConfigMap read.
    expect(res.status).toBe(400);
    expect(readConfigMapKey).not.toHaveBeenCalled();
  });

  it("gcsScenariosPut throws → exits at instance-name guard in default test env", async () => {
    vi.mocked(gcsScenariosPut).mockRejectedValue(new Error("GCS write error"));

    const res = await POST();

    expect(res.status).toBe(400);
    expect(gcsScenariosPut).not.toHaveBeenCalled();
  });
});

// ── Integration-style tests with module re-import ─────────────────────────────
//
// VSS_INSTANCE_NAME is a top-level const. Use vi.resetModules() + dynamic import
// to exercise the branches that require a non-empty instance name.

describe("POST /api/scenarios/sync-gcs — with VSS_INSTANCE_NAME set", () => {
  it("happy path (k8s mode): ConfigMap read → gcsScenariosPut → 200 with ok:true + synced count", async () => {
    process.env.VSS_INSTANCE_NAME = "test-instance";

    vi.resetModules();
    vi.doMock("@/lib/auth", () => ({
      auth: vi.fn().mockResolvedValue({ user: { name: "op", email: "op@test.com" } }),
    }));
    vi.doMock("@/lib/helpers/configmaps", () => ({
      readConfigMapKey: vi.fn().mockResolvedValue({ value: SCENARIO_CM_VALUE }),
      patchConfigMapKey: vi.fn().mockResolvedValue(undefined),
      patchConfigMapRawKey: vi.fn().mockResolvedValue(undefined),
      replaceConfigMapData: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock("@/lib/helpers/gcs-config", () => ({
      gcsScenariosPut: vi.fn().mockResolvedValue(undefined),
      gcsScenariosGet: vi.fn().mockResolvedValue(null),
    }));
    vi.doMock("@/lib/k8s", () => ({
      coreV1: vi.fn(() => ({ readNamespacedConfigMap: vi.fn() })),
      rolloutRestart: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock("fs/promises", () => ({
      default: {
        readFile: vi.fn().mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" })),
        mkdir: vi.fn().mockResolvedValue(undefined),
      },
    }));

    const { POST: POST2 } = await import("@/app/api/scenarios/sync-gcs/route");
    const { gcsScenariosPut: put2 } = await import("@/lib/helpers/gcs-config");

    const res = await POST2();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.instance).toBe("test-instance");
    expect(body.synced).toBe(2);
    expect(put2).toHaveBeenCalledOnce();
    expect(put2).toHaveBeenCalledWith(
      expect.objectContaining({
        schema: "isv-labs.scenarios.v1",
        instance: "test-instance",
        scenarios: expect.arrayContaining([
          expect.objectContaining({ id: "theft" }),
          expect.objectContaining({ id: "slip" }),
        ]),
      }),
    );

    delete process.env.VSS_INSTANCE_NAME;
    vi.resetModules();
  });

  it("ConfigMap read fails → 502 with extracted error message", async () => {
    process.env.VSS_INSTANCE_NAME = "test-instance";

    vi.resetModules();
    vi.doMock("@/lib/auth", () => ({
      auth: vi.fn().mockResolvedValue({ user: { name: "op", email: "op@test.com" } }),
    }));
    vi.doMock("@/lib/helpers/configmaps", () => ({
      readConfigMapKey: vi.fn().mockRejectedValue(new Error("k8s connection refused")),
      patchConfigMapKey: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock("@/lib/helpers/gcs-config", () => ({
      gcsScenariosPut: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock("@/lib/k8s", () => ({
      coreV1: vi.fn(() => ({ readNamespacedConfigMap: vi.fn() })),
      rolloutRestart: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock("fs/promises", () => ({
      default: {
        readFile: vi.fn().mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" })),
        mkdir: vi.fn().mockResolvedValue(undefined),
      },
    }));

    const { POST: POST2 } = await import("@/app/api/scenarios/sync-gcs/route");

    const res = await POST2();

    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toMatch(/Failed to read scenarios ConfigMap/);
    expect(body.error).toContain("k8s connection refused");

    delete process.env.VSS_INSTANCE_NAME;
    vi.resetModules();
  });

  it("gcsScenariosPut throws → 502 with GCS write error", async () => {
    process.env.VSS_INSTANCE_NAME = "test-instance";

    vi.resetModules();
    vi.doMock("@/lib/auth", () => ({
      auth: vi.fn().mockResolvedValue({ user: { name: "op", email: "op@test.com" } }),
    }));
    vi.doMock("@/lib/helpers/configmaps", () => ({
      readConfigMapKey: vi.fn().mockResolvedValue({ value: SCENARIO_CM_VALUE }),
      patchConfigMapKey: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock("@/lib/helpers/gcs-config", () => ({
      gcsScenariosPut: vi.fn().mockRejectedValue(new Error("GCS auth failure")),
    }));
    vi.doMock("@/lib/k8s", () => ({
      coreV1: vi.fn(() => ({ readNamespacedConfigMap: vi.fn() })),
      rolloutRestart: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock("fs/promises", () => ({
      default: {
        readFile: vi.fn().mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" })),
        mkdir: vi.fn().mockResolvedValue(undefined),
      },
    }));

    const { POST: POST2 } = await import("@/app/api/scenarios/sync-gcs/route");

    const res = await POST2();

    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toMatch(/GCS write failed/);
    expect(body.error).toContain("GCS auth failure");

    delete process.env.VSS_INSTANCE_NAME;
    vi.resetModules();
  });

  it("docker mode: scenarios.json missing → 404 with explanation", async () => {
    process.env.VSS_INSTANCE_NAME = "test-instance";
    process.env.CONSOLE_RUNTIME = "docker";

    vi.resetModules();
    vi.doMock("@/lib/auth", () => ({
      auth: vi.fn().mockResolvedValue({ user: { name: "op", email: "op@test.com" } }),
    }));
    vi.doMock("@/lib/helpers/gcs-config", () => ({
      gcsScenariosPut: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock("@/lib/helpers/configmaps", () => ({
      readConfigMapKey: vi.fn(),
    }));
    vi.doMock("@/lib/k8s", () => ({
      coreV1: vi.fn(() => ({ readNamespacedConfigMap: vi.fn() })),
    }));
    vi.doMock("fs/promises", () => ({
      default: {
        readFile: vi.fn().mockRejectedValue(Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" })),
        mkdir: vi.fn().mockResolvedValue(undefined),
      },
    }));

    const { POST: POST2 } = await import("@/app/api/scenarios/sync-gcs/route");

    const res = await POST2();

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toMatch(/No local scenarios found/);

    delete process.env.VSS_INSTANCE_NAME;
    delete process.env.CONSOLE_RUNTIME;
    vi.resetModules();
  });
});

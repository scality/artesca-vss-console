import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Module mocks — declared before any imports that trigger the modules ──────

vi.mock("@/lib/auth", () => ({
  auth: vi.fn().mockResolvedValue({ user: { name: "operator", email: "operator@test.com" } }),
}));

vi.mock("@/lib/kiosk-server", () => ({
  rejectIfKiosk: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/k8s", () => ({
  appsV1: vi.fn(() => ({
    patchNamespacedDeployment: vi.fn().mockResolvedValue({}),
    readNamespacedDeployment: vi.fn().mockResolvedValue({
      spec: {
        replicas: 1,
        template: {
          spec: {
            containers: [
              {
                name: "demo-producer",
                env: [
                  { name: "TICK_SECONDS", value: "5" },
                  { name: "MATCH_PROBABILITY", value: "0.5" },
                ],
              },
            ],
          },
        },
      },
    }),
  })),
}));

vi.mock("@/lib/errors", () => ({
  extractK8sError: vi.fn((err) => ({
    status: (err as { code?: number })?.code ?? 500,
    message: String(err),
  })),
}));

vi.mock("@/lib/helpers/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));

// docker-sock is imported at module level — stub so we don't hit a real socket.
vi.mock("@/lib/helpers/docker-sock", () => ({
  dockerSock: vi.fn().mockResolvedValue({}),
  dockerRecreateWithEnv: vi.fn().mockResolvedValue({ id: "abc123" }),
  inspectContainer: vi.fn().mockResolvedValue(null),
}));

// cluster-refs uses "server-only" — provide a minimal stub.
vi.mock("@/lib/cluster-refs", () => ({
  CLUSTER: {
    demoData: {
      namespace: "demo-data",
      deployment: "demo-producer",
      envConfigMap: "demo-producer-env",
      tickSecondsEnv: "TICK_SECONDS",
      matchProbabilityEnv: "MATCH_PROBABILITY",
      dockerContainer: "demo-producer",
    },
  },
}));

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { rejectIfKiosk } from "@/lib/kiosk-server";
import { appsV1 } from "@/lib/k8s";
import { auditLog } from "@/lib/helpers/audit";

import { PATCH } from "@/app/api/demo-data/route";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeRequest(body: unknown): NextRequest {
  return new Request("http://localhost/api/demo-data", {
    method: "PATCH",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  }) as unknown as NextRequest;
}

// ── Setup ────────────────────────────────────────────────────────────────────

let mockAppsV1Api: {
  patchNamespacedDeployment: ReturnType<typeof vi.fn>;
  readNamespacedDeployment: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  mockAppsV1Api = {
    patchNamespacedDeployment: vi.fn().mockResolvedValue({}),
    readNamespacedDeployment: vi.fn().mockResolvedValue({
      spec: {
        replicas: 1,
        template: {
          spec: {
            containers: [
              {
                name: "demo-producer",
                env: [
                  { name: "TICK_SECONDS", value: "5" },
                  { name: "MATCH_PROBABILITY", value: "0.5" },
                ],
              },
            ],
          },
        },
      },
    }),
  };

  vi.mocked(auth).mockReset().mockResolvedValue({
    user: { name: "operator", email: "operator@test.com" },
  } as never);
  vi.mocked(rejectIfKiosk).mockReset().mockResolvedValue(null);
  vi.mocked(appsV1).mockReset().mockReturnValue(mockAppsV1Api as never);
  vi.mocked(auditLog).mockReset().mockResolvedValue(undefined);

  delete process.env.CONSOLE_RUNTIME;
});

// ── PATCH ─────────────────────────────────────────────────────────────────────

describe("PATCH /api/demo-data", () => {
  it("auth missing → 401, no K8s calls", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);

    const req = makeRequest({ enabled: true });
    const res = await PATCH(req);

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toMatch(/unauthorized/i);
    expect(mockAppsV1Api.patchNamespacedDeployment).not.toHaveBeenCalled();
  });

  it("kiosk reject: rejectIfKiosk returns 403 → short-circuits, no K8s calls", async () => {
    vi.mocked(rejectIfKiosk).mockResolvedValue(
      NextResponse.json({ error: "kiosk mode is read-only" }, { status: 403 }),
    );

    const req = makeRequest({ enabled: true });
    const res = await PATCH(req);

    expect(res.status).toBe(403);
    expect(mockAppsV1Api.patchNamespacedDeployment).not.toHaveBeenCalled();
    expect(auditLog).not.toHaveBeenCalled();
  });

  it("invalid body (zod): no fields provided → 400", async () => {
    const req = makeRequest({});
    const res = await PATCH(req);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBeDefined();
    expect(mockAppsV1Api.patchNamespacedDeployment).not.toHaveBeenCalled();
  });

  it("invalid body (zod): matchProbability out of range → 400", async () => {
    const req = makeRequest({ matchProbability: 1.5 });
    const res = await PATCH(req);

    expect(res.status).toBe(400);
    expect(mockAppsV1Api.patchNamespacedDeployment).not.toHaveBeenCalled();
  });

  it("PATCH happy path: enabled=true → scales deployment to 1, audit logged, ok:true", async () => {
    const req = makeRequest({ enabled: true });
    const res = await PATCH(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.enabled).toBe(true);

    expect(mockAppsV1Api.patchNamespacedDeployment).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({ spec: expect.objectContaining({ replicas: 1 }) }),
      }),
    );
    expect(auditLog).toHaveBeenCalledWith(
      "demo-data-update",
      expect.stringContaining("demo-producer"),
      expect.objectContaining({ enabled: true }),
    );
  });

  it("PATCH happy path: tickRate + matchProbability → reads deployment, patches env, audit logged", async () => {
    const req = makeRequest({ tickRate: 10, matchProbability: 0.8 });
    const res = await PATCH(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.tickRate).toBe(10);
    expect(body.matchProbability).toBe(0.8);

    // Should read current deployment env then patch with new values
    expect(mockAppsV1Api.readNamespacedDeployment).toHaveBeenCalledOnce();
    expect(mockAppsV1Api.patchNamespacedDeployment).toHaveBeenCalledOnce();

    const patchCall = mockAppsV1Api.patchNamespacedDeployment.mock.calls[0][0];
    const containers = patchCall.body.spec.template.spec.containers;
    const tickEnv = containers[0].env.find((e: { name: string }) => e.name === "TICK_SECONDS");
    const probEnv = containers[0].env.find((e: { name: string }) => e.name === "MATCH_PROBABILITY");
    expect(tickEnv?.value).toBe("10");
    expect(probEnv?.value).toBe("0.8");
  });

  it("K8s patchNamespacedDeployment fails → propagates error status", async () => {
    mockAppsV1Api.patchNamespacedDeployment.mockRejectedValueOnce(
      Object.assign(new Error("forbidden"), { code: 403 }),
    );
    vi.mocked(appsV1).mockReturnValue(mockAppsV1Api as never);

    const req = makeRequest({ enabled: false });
    const res = await PATCH(req);

    // extractK8sError returns the code (403 in this case via mock)
    expect([403, 500]).toContain(res.status);
    const body = await res.json();
    expect(body.error).toBeDefined();
    expect(auditLog).not.toHaveBeenCalled();
  });
});

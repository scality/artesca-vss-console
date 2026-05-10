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
    readNamespacedDeployment: vi.fn().mockResolvedValue({
      spec: {
        replicas: 0,
        template: {
          spec: {
            containers: [
              {
                name: "demo-data-producer",
                env: [{ name: "MATCH_PROBABILITY", value: "0.1" }],
              },
            ],
          },
        },
      },
    }),
    patchNamespacedDeployment: vi.fn().mockResolvedValue({}),
  })),
}));

vi.mock("@/lib/errors", () => ({
  extractK8sError: vi.fn((err) => ({
    status: (err as { code?: number })?.code ?? 500,
    message: err instanceof Error ? err.message : String(err),
  })),
}));

vi.mock("@/lib/helpers/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));

// docker-sock imported at module level in rehearsal route.
vi.mock("@/lib/helpers/docker-sock", () => ({
  dockerSock: vi.fn().mockResolvedValue({}),
  dockerRecreateWithEnv: vi.fn().mockResolvedValue({ id: "abc123" }),
  inspectContainer: vi.fn().mockResolvedValue({
    Config: { Env: ["MATCH_PROBABILITY=0.1", "TICK_SECONDS=5"] },
  }),
}));

// cluster-refs uses "server-only" — stub it.
vi.mock("@/lib/cluster-refs", () => ({
  CLUSTER: {
    demoData: {
      namespace: "demo-data",
      deployment: "demo-producer",
      matchProbabilityEnv: "MATCH_PROBABILITY",
      dockerContainer: "demo-producer",
    },
  },
}));

import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { rejectIfKiosk } from "@/lib/kiosk-server";
import { appsV1 } from "@/lib/k8s";
import { auditLog } from "@/lib/helpers/audit";

import { POST } from "@/app/api/demo-data/rehearsal/route";

// ── Setup ────────────────────────────────────────────────────────────────────

let mockAppsV1Api: {
  readNamespacedDeployment: ReturnType<typeof vi.fn>;
  patchNamespacedDeployment: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  mockAppsV1Api = {
    readNamespacedDeployment: vi.fn().mockResolvedValue({
      spec: {
        replicas: 0,
        template: {
          spec: {
            containers: [
              {
                name: "demo-data-producer",
                env: [{ name: "MATCH_PROBABILITY", value: "0.1" }],
              },
            ],
          },
        },
      },
    }),
    patchNamespacedDeployment: vi.fn().mockResolvedValue({}),
  };

  vi.mocked(auth).mockReset().mockResolvedValue({
    user: { name: "operator", email: "operator@test.com" },
  } as never);
  vi.mocked(rejectIfKiosk).mockReset().mockResolvedValue(null);
  vi.mocked(appsV1).mockReset().mockReturnValue(mockAppsV1Api as never);
  vi.mocked(auditLog).mockReset().mockResolvedValue(undefined);

  delete process.env.CONSOLE_RUNTIME;
});

// ── POST ──────────────────────────────────────────────────────────────────────

describe("POST /api/demo-data/rehearsal", () => {
  it("auth missing → 401, no K8s calls", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);

    const res = await POST();

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toMatch(/unauthorized/i);
    expect(mockAppsV1Api.patchNamespacedDeployment).not.toHaveBeenCalled();
  });

  it("kiosk reject: rejectIfKiosk returns 403 → short-circuits, no K8s calls", async () => {
    vi.mocked(rejectIfKiosk).mockResolvedValue(
      NextResponse.json({ error: "kiosk mode is read-only" }, { status: 403 }),
    );

    const res = await POST();

    expect(res.status).toBe(403);
    expect(mockAppsV1Api.patchNamespacedDeployment).not.toHaveBeenCalled();
    expect(auditLog).not.toHaveBeenCalled();
  });

  it("POST happy path (k8s mode): scales deployment to 1 with REHEARSAL_MATCH_PROBABILITY, returns startedAt + ok:true", async () => {
    const res = await POST();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.startedAt).toBeDefined();
    expect(body.restoreAfterMs).toBeGreaterThan(0);
    expect(body.matchProbability).toBe("0.95");

    // Should have patched deployment to scale up with high match probability
    expect(mockAppsV1Api.patchNamespacedDeployment).toHaveBeenCalledOnce();
    const patchCall = mockAppsV1Api.patchNamespacedDeployment.mock.calls[0][0];
    expect(patchCall.body.spec.replicas).toBe(1);
    const envEntry = patchCall.body.spec.template.spec.containers[0].env.find(
      (e: { name: string }) => e.name === "MATCH_PROBABILITY",
    );
    expect(envEntry?.value).toBe("0.95");

    // Audit logged
    expect(auditLog).toHaveBeenCalledWith(
      "rehearsal-start",
      expect.stringContaining("demo-data"),
      expect.objectContaining({ matchProbability: "0.95" }),
    );
  });

  it("K8s patch fails → 5xx error returned, no audit logged", async () => {
    mockAppsV1Api.patchNamespacedDeployment.mockRejectedValueOnce(
      Object.assign(new Error("k8s unavailable"), { code: 503 }),
    );
    vi.mocked(appsV1).mockReturnValue(mockAppsV1Api as never);

    const res = await POST();

    expect(res.status).toBeGreaterThanOrEqual(500);
    const body = await res.json();
    expect(body.error).toBeDefined();
    expect(auditLog).not.toHaveBeenCalled();
  });

  it.todo(
    "rehearsal is idempotent / no guard against concurrent runs — the route fires-and-forgets the restore setTimeout; testing the background restore chain would require fake timers and is brittle given the module-level REHEARSAL_DURATION_MS constant",
  );
});

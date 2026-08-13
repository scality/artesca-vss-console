import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Module mocks — declared before any import that triggers the modules ────────

vi.mock("@/lib/auth", () => ({
  auth: vi.fn().mockResolvedValue({ user: { name: "operator" } }),
}));

vi.mock("@/lib/kiosk-server", () => ({
  rejectIfKiosk: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/k8s", () => ({
  coreV1: vi.fn(() => ({
    readNamespacedSecret: vi.fn(),
    patchNamespacedSecret: vi.fn(),
    replaceNamespacedSecret: vi.fn(),
  })),
  appsV1: vi.fn(() => ({
    patchNamespacedDeployment: vi.fn(),
  })),
  rolloutRestart: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/errors", () => ({
  extractK8sError: vi.fn((err) => ({ status: 500, message: String(err) })),
}));

vi.mock("@/lib/helpers/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));


// cluster-refs uses "server-only" — stub it so tests don't fail outside Next.js
vi.mock("@/lib/cluster-refs", () => {
  const RESTARTABLE: Record<string, { namespace: string; kind: string; name: string }> = {
    "rtvi-vlm": { namespace: "rtvi", kind: "Deployment", name: "rtvi-vlm" },
    "alert-worker": { namespace: "alerts", kind: "Deployment", name: "alert-worker" },
    "cosmos-reason2-8b": { namespace: "rtvi", kind: "StatefulSet", name: "cosmos-reason2-8b" },
  };
  return {
    CLUSTER: {
      restartable: RESTARTABLE,
      alertsTuning: { cooldownKey: "COOLDOWN_SECONDS", slackConfiguredKey: "SLACK_CONFIGURED" },
      rtvi: { nimMaxNumSeqsKey: "MAX_NUM_SEQS", nimKvCacheKey: "KV_CACHE_PERCENT", nimMaxModelLenKey: "MAX_MODEL_LEN" },
    },
    RESTARTABLE,
  };
});

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { rejectIfKiosk } from "@/lib/kiosk-server";
import { rolloutRestart } from "@/lib/k8s";
import { extractK8sError } from "@/lib/errors";
import { auditLog } from "@/lib/helpers/audit";

import { POST } from "@/app/api/restart/[component]/route";

// ── Helpers ────────────────────────────────────────────────────────────────────

function makePostRequest(component: string): [Request, { params: Promise<{ component: string }> }] {
  const req = new Request(`http://localhost/api/restart/${component}`, {
    method: "POST",
  }) as unknown as NextRequest;
  return [req, { params: Promise.resolve({ component }) }];
}

// ── Setup ──────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.mocked(auth).mockReset().mockResolvedValue({ user: { name: "operator" } } as never);
  vi.mocked(rejectIfKiosk).mockReset().mockResolvedValue(null);
  vi.mocked(rolloutRestart).mockReset().mockResolvedValue(undefined);
  vi.mocked(auditLog).mockReset().mockResolvedValue(undefined);
  vi.mocked(extractK8sError).mockReset().mockImplementation((err) => ({
    status: 500,
    message: String(err),
  }));
  // Ensure K8s mode
});

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("POST /api/restart/[component]", () => {
  it("happy path: POST /api/restart/rtvi-vlm calls rolloutRestart with correct args, audits, returns 200", async () => {
    const [req, ctx] = makePostRequest("rtvi-vlm");
    const res = await POST(req, ctx);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.restartedAt).toBeDefined();

    expect(rolloutRestart).toHaveBeenCalledOnce();
    expect(rolloutRestart).toHaveBeenCalledWith("Deployment", "rtvi", "rtvi-vlm");

    expect(auditLog).toHaveBeenCalledOnce();
    expect(auditLog).toHaveBeenCalledWith(
      "restart",
      "rtvi/deployment/rtvi-vlm",
      expect.objectContaining({ component: "rtvi-vlm" })
    );
  });

  it("unknown component returns 400 with error message containing the component name", async () => {
    const [req, ctx] = makePostRequest("foo");
    const res = await POST(req, ctx);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/foo/);
    expect(rolloutRestart).not.toHaveBeenCalled();
  });

  it("kiosk mode: rejectIfKiosk returns 403 → handler short-circuits, no rolloutRestart call", async () => {
    const kioskResponse = NextResponse.json({ error: "kiosk mode is read-only" }, { status: 403 });
    vi.mocked(rejectIfKiosk).mockResolvedValue(kioskResponse);

    const [req, ctx] = makePostRequest("rtvi-vlm");
    const res = await POST(req, ctx);

    expect(res.status).toBe(403);
    expect(rolloutRestart).not.toHaveBeenCalled();
  });

  it("missing auth: auth() returns null → 401, no rolloutRestart call", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);

    const [req, ctx] = makePostRequest("rtvi-vlm");
    const res = await POST(req, ctx);

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toMatch(/unauthorized/i);
    expect(rolloutRestart).not.toHaveBeenCalled();
  });

  it("K8s error: extractK8sError result propagated as status + message", async () => {
    vi.mocked(rolloutRestart).mockRejectedValue(new Error("api server down"));
    vi.mocked(extractK8sError).mockReturnValue({ status: 503, message: "api server down" });

    const [req, ctx] = makePostRequest("rtvi-vlm");
    const res = await POST(req, ctx);

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe("api server down");
    expect(body.k8sCode).toBe(503);
    expect(auditLog).not.toHaveBeenCalled();
  });
});

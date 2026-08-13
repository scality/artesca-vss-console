import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Module mocks — declared before any import that triggers the modules ──────

vi.mock("@/lib/auth", () => ({
  auth: vi.fn().mockResolvedValue({ user: { name: "operator" } }),
}));

vi.mock("@/lib/k8s", () => ({
  coreV1: vi.fn(() => ({
    listNamespacedEvent: vi.fn().mockResolvedValue({ items: [] }),
    listNode: vi.fn().mockResolvedValue({ items: [] }),
  })),
  appsV1: vi.fn(() => ({})),
  watchedNamespaces: vi.fn(() => ["vst", "rtvi", "agent", "alerts", "pyramid-ingress"]),
  listAllPodsInNs: vi.fn().mockResolvedValue([]),
}));

// sshExec is used by every "via: ssh" and "via: ssh-nvidia-smi" diagnostic.
vi.mock("@/lib/ssh", () => ({
  sshExec: vi.fn().mockResolvedValue({ stdout: "ok", stderr: "", code: 0 }),
}));

// auditLog is called at the end of every successful POST.
vi.mock("@/lib/helpers/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));


// ── Imports ──────────────────────────────────────────────────────────────────

import { auth } from "@/lib/auth";
import { sshExec } from "@/lib/ssh";
import { auditLog } from "@/lib/helpers/audit";
import { coreV1 } from "@/lib/k8s";
import { POST } from "@/app/api/diagnostics/[test]/route";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makePostRequest(test: string) {
  return {
    request: new Request(`http://localhost/api/diagnostics/${test}`, { method: "POST" }),
    ctx: { params: Promise.resolve({ test }) },
  };
}

// ── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.mocked(auth).mockReset().mockResolvedValue({ user: { name: "operator" } } as never);
  vi.mocked(sshExec).mockReset().mockResolvedValue({ stdout: "ok", stderr: "", code: 0 });
  vi.mocked(auditLog).mockReset().mockResolvedValue(undefined);

  // Reset coreV1 factory to return fresh mocks each test
  const freshCoreApi = {
    listNamespacedEvent: vi.fn().mockResolvedValue({ items: [] }),
    listNode: vi.fn().mockResolvedValue({ items: [] }),
  };
  vi.mocked(coreV1).mockReturnValue(freshCoreApi as never);

  // Ensure k8s branch (not docker) runs
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("POST /api/diagnostics/[test]", () => {
  it("auth missing: returns 401 without running any diagnostic", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);

    const { request, ctx } = makePostRequest("validate-manifests");
    const res = await POST(request, ctx);

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toMatch(/unauthorized/i);
    expect(sshExec).not.toHaveBeenCalled();
  });

  it("unknown test name: returns 400 with helpful error listing available tests", async () => {
    const { request, ctx } = makePostRequest("nonexistent-test");
    const res = await POST(request, ctx);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/unknown test/i);
    // The response should list known test names
    expect(body.error).toMatch(/validate-manifests/);
    expect(sshExec).not.toHaveBeenCalled();
    expect(auditLog).not.toHaveBeenCalled();
  });

  it("known ssh test (validate-manifests) happy path: runs sshExec, returns result + calls auditLog", async () => {
    vi.mocked(sshExec).mockResolvedValue({
      stdout: "All manifests valid",
      stderr: "",
      code: 0,
    });

    const { request, ctx } = makePostRequest("validate-manifests");
    const res = await POST(request, ctx);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.test).toBe("validate-manifests");
    expect(body.exitCode).toBe(0);
    expect(body.stdout).toBe("All manifests valid");
    expect(body.stderr).toBe("");
    expect(body.startedAt).toBeDefined();

    expect(sshExec).toHaveBeenCalledOnce();
    expect(auditLog).toHaveBeenCalledOnce();
    expect(auditLog).toHaveBeenCalledWith(
      "diagnostic-run",
      "diagnostic/validate-manifests",
      expect.objectContaining({ test: "validate-manifests", exitCode: 0 })
    );
  });

  it("k8s-api-events (get-events) happy path: calls coreV1().listNamespacedEvent for each namespace, returns aggregated stdout", async () => {
    const freshCoreApi = {
      listNamespacedEvent: vi.fn().mockResolvedValue({
        items: [
          {
            reason: "Created",
            message: "pod created",
            involvedObject: { name: "sensor-ms-abc" },
            count: 1,
            lastTimestamp: "2026-05-09T10:00:00.000Z",
          },
        ],
      }),
      listNode: vi.fn().mockResolvedValue({ items: [] }),
    };
    vi.mocked(coreV1).mockReturnValue(freshCoreApi as never);

    const { request, ctx } = makePostRequest("get-events");
    const res = await POST(request, ctx);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.test).toBe("get-events");
    expect(body.exitCode).toBe(0);
    // At least one event line from one of the namespaces
    expect(body.stdout).toContain("Created");
    expect(auditLog).toHaveBeenCalledOnce();
  });

  it("sshExec throws: returns 200 with exitCode=1 and error captured in stderr, still calls auditLog", async () => {
    vi.mocked(sshExec).mockRejectedValue(new Error("SSH connection refused"));

    const { request, ctx } = makePostRequest("validate-manifests");
    const res = await POST(request, ctx);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.exitCode).toBe(1);
    expect(body.stderr).toMatch(/SSH connection refused/);
    // auditLog is still called — it runs in finally-like position after the try/catch
    expect(auditLog).toHaveBeenCalledOnce();
    expect(auditLog).toHaveBeenCalledWith(
      "diagnostic-run",
      "diagnostic/validate-manifests",
      expect.objectContaining({ exitCode: 1 })
    );
  });

  it("nvidia-smi diagnostic: delegates to sshExec with 'nvidia-smi 2>&1'", async () => {
    vi.mocked(sshExec).mockResolvedValue({
      stdout: "GPU 0: NVIDIA L40S",
      stderr: "",
      code: 0,
    });

    const { request, ctx } = makePostRequest("nvidia-smi");
    const res = await POST(request, ctx);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.test).toBe("nvidia-smi");
    expect(body.stdout).toBe("GPU 0: NVIDIA L40S");
    expect(sshExec).toHaveBeenCalledWith("nvidia-smi 2>&1");
  });
});

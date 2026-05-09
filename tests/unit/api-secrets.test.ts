import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Module mocks ───────────────────────────────────────────────────────────────

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

vi.mock("@/lib/db", () => ({
  saveProfile: vi.fn(),
  loadProfile: vi.fn(),
  listProfiles: vi.fn(() => []),
  appendAuditLog: vi.fn(),
  markRotated: vi.fn(),
  getRotationAge: vi.fn().mockReturnValue(null),
}));

vi.mock("@/lib/helpers/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));

// docker-sock stubs
vi.mock("@/lib/helpers/docker-sock", () => ({
  dockerSock: vi.fn().mockResolvedValue(undefined),
  inspectContainer: vi.fn().mockResolvedValue(null),
  listComposeContainers: vi.fn().mockResolvedValue([]),
  DOCKER_TUNING_DIR: "/tmp/docker-tuning",
  dockerRecreateWithEnv: vi.fn().mockResolvedValue(undefined),
  runOneShotGpuContainer: vi.fn().mockResolvedValue(undefined),
  streamDockerLogs: vi.fn(),
  execInContainer: vi.fn().mockResolvedValue(undefined),
}));

// fs/promises: most tests use K8s mode — default to no-ops; individual tests
// override specific methods.
vi.mock("fs/promises", () => ({
  default: {
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" })),
    access: vi.fn().mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" })),
  },
}));

// bcryptjs — mock so we don't pay the real bcrypt cost and can assert the value.
vi.mock("bcryptjs", () => ({
  default: { hash: vi.fn().mockResolvedValue("$2b$12$hashed-password") },
  hash: vi.fn().mockResolvedValue("$2b$12$hashed-password"),
}));

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { rejectIfKiosk } from "@/lib/kiosk-server";
import { auditLog } from "@/lib/helpers/audit";
import { markRotated, getRotationAge } from "@/lib/db";
import { coreV1, rolloutRestart } from "@/lib/k8s";
import { extractK8sError } from "@/lib/errors";

import { GET, PATCH } from "@/app/api/secrets/[key]/route";

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeGetRequest(key: string): [NextRequest, { params: Promise<{ key: string }> }] {
  const req = new Request(`http://localhost/api/secrets/${key}`) as unknown as NextRequest;
  return [req, { params: Promise.resolve({ key }) }];
}

function makePatchRequest(key: string, body: unknown): [NextRequest, { params: Promise<{ key: string }> }] {
  const req = new Request(`http://localhost/api/secrets/${key}`, {
    method: "PATCH",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  }) as unknown as NextRequest;
  return [req, { params: Promise.resolve({ key }) }];
}

// A minimal K8s Secret response with required fields present.
function makeK8sSecret(dataKeys: Record<string, string>, createdAt?: string) {
  return {
    data: Object.fromEntries(
      Object.entries(dataKeys).map(([k, v]) => [k, Buffer.from(v).toString("base64")])
    ),
    metadata: {
      creationTimestamp: createdAt ?? new Date(Date.now() - 60_000).toISOString(),
    },
  };
}

// Helper: get the readNamespacedSecret mock from the coreV1() factory.
function getReadMock() {
  return vi.mocked(coreV1)().readNamespacedSecret as ReturnType<typeof vi.fn>;
}

function getPatchMock() {
  return vi.mocked(coreV1)().patchNamespacedSecret as ReturnType<typeof vi.fn>;
}

// ── Setup ──────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.mocked(auth).mockReset().mockResolvedValue({ user: { name: "operator" } } as never);
  vi.mocked(rejectIfKiosk).mockReset().mockResolvedValue(null);
  vi.mocked(auditLog).mockReset().mockResolvedValue(undefined);
  vi.mocked(markRotated).mockReset();
  vi.mocked(getRotationAge).mockReset().mockReturnValue(null);
  vi.mocked(rolloutRestart).mockReset().mockResolvedValue(undefined);
  vi.mocked(extractK8sError).mockReset().mockImplementation((err) => ({ status: 500, message: String(err) }));

  // Reset the coreV1 factory — each call re-creates the inner fns.
  vi.mocked(coreV1).mockReset().mockImplementation(() => ({
    readNamespacedSecret: vi.fn().mockResolvedValue(undefined),
    patchNamespacedSecret: vi.fn().mockResolvedValue(undefined),
    replaceNamespacedSecret: vi.fn().mockResolvedValue(undefined),
  }) as never);

  // Default to K8s mode
  delete process.env.CONSOLE_RUNTIME;
  delete process.env.CONSOLE_DATA_DIR;
});

// ── GET ────────────────────────────────────────────────────────────────────────

describe("GET /api/secrets/[key]", () => {
  it("happy path: existing secret → configured:true, ageMs is a number", async () => {
    const createdAt = new Date(Date.now() - 120_000).toISOString();
    vi.mocked(coreV1).mockImplementation(() => ({
      readNamespacedSecret: vi.fn().mockResolvedValue(makeK8sSecret({ NGC_API_KEY: "mykey" }, createdAt)),
      patchNamespacedSecret: vi.fn().mockResolvedValue(undefined),
      replaceNamespacedSecret: vi.fn().mockResolvedValue(undefined),
    }) as never);

    const [req, ctx] = makeGetRequest("ngc-key");
    const res = await GET(req, ctx);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.configured).toBe(true);
    expect(typeof body.ageMs).toBe("number");
    expect(body.ageMs).toBeGreaterThan(0);
  });

  it("secret missing (K8s 404): configured:false, ageMs null", async () => {
    // extractK8sError returns 404 — route treats this as "not configured", not an error.
    vi.mocked(extractK8sError).mockReturnValue({ status: 404, message: "not found" });
    vi.mocked(coreV1).mockImplementation(() => ({
      readNamespacedSecret: vi.fn().mockRejectedValue(Object.assign(new Error("not found"), { statusCode: 404 })),
      patchNamespacedSecret: vi.fn().mockResolvedValue(undefined),
      replaceNamespacedSecret: vi.fn().mockResolvedValue(undefined),
    }) as never);

    const [req, ctx] = makeGetRequest("ngc-key");
    const res = await GET(req, ctx);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.configured).toBe(false);
    expect(body.ageMs).toBeNull();
  });

  it("unknown key → 400", async () => {
    const [req, ctx] = makeGetRequest("not-a-real-key");
    const res = await GET(req, ctx);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/unknown secret key/i);
  });

  it("auth missing → 401", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);

    const [req, ctx] = makeGetRequest("ngc-key");
    const res = await GET(req, ctx);

    expect(res.status).toBe(401);
  });
});

// ── PATCH ──────────────────────────────────────────────────────────────────────

describe("PATCH /api/secrets/[key]", () => {
  it("happy path K8s mode: patchNamespacedSecret called with base64-encoded value, markRotated called, audit logged, 200", async () => {
    const mockPatch = vi.fn().mockResolvedValue(undefined);
    vi.mocked(coreV1).mockImplementation(() => ({
      readNamespacedSecret: vi.fn().mockResolvedValue(undefined),
      patchNamespacedSecret: mockPatch,
      replaceNamespacedSecret: vi.fn().mockResolvedValue(undefined),
    }) as never);

    const [req, ctx] = makePatchRequest("ngc-key", { value: "super-secret-ngc-key" });
    const res = await PATCH(req, ctx);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.rotatedAt).toBeDefined();

    // Value should be base64-encoded before being passed to K8s
    expect(mockPatch).toHaveBeenCalledOnce();
    const callArg = mockPatch.mock.calls[0][0];
    expect(callArg.namespace).toBe("rtvi");
    expect(callArg.name).toBe("ngc-secret");
    expect(callArg.body.data["NGC_API_KEY"]).toBe(
      Buffer.from("super-secret-ngc-key").toString("base64")
    );

    expect(markRotated).toHaveBeenCalledWith("ngc-key");
    expect(auditLog).toHaveBeenCalledOnce();
    expect(auditLog).toHaveBeenCalledWith(
      "secret-rotate",
      "rtvi/secret/ngc-secret",
      expect.objectContaining({ key: "ngc-key" })
    );
  });

  it("happy path docker mode: vi.resetModules + re-import with CONSOLE_RUNTIME=docker → writes to file, no k8s call, markRotated called", async () => {
    // DOCKER_MODE is evaluated once at module load time. We must reset the module
    // cache and re-import the route with CONSOLE_RUNTIME set so DOCKER_MODE=true.
    process.env.CONSOLE_RUNTIME = "docker";
    process.env.CONSOLE_DATA_DIR = "/data";

    const fs = (await import("fs/promises")).default;
    vi.mocked(fs.mkdir).mockResolvedValue(undefined);
    vi.mocked(fs.writeFile).mockResolvedValue(undefined);

    // Reset module cache so next import re-evaluates module-level constants.
    vi.resetModules();

    // Re-import the route after all mocks are already registered with vi.mock
    // (vi.mock calls are hoisted and persist across resetModules).
    const { PATCH: PATCHdocker } = await import("@/app/api/secrets/[key]/route");

    // Track K8s patch calls on the fresh coreV1 instance
    const { coreV1: freshCoreV1 } = await import("@/lib/k8s");
    const freshPatch = vi.mocked(freshCoreV1)().patchNamespacedSecret as ReturnType<typeof vi.fn>;

    const [req, ctx] = makePatchRequest("slack-webhook-url", { value: "https://hooks.slack.com/xxx" });
    const res = await PATCHdocker(req, ctx);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    // File should have been written
    expect(fs.writeFile).toHaveBeenCalled();
    const writeCall = vi.mocked(fs.writeFile).mock.calls.find(
      ([p]) => String(p).includes("slack-webhook-url")
    );
    expect(writeCall).toBeDefined();
    expect(writeCall![1]).toBe("https://hooks.slack.com/xxx");

    expect(markRotated).toHaveBeenCalledWith("slack-webhook-url");

    // Restore for subsequent tests
    delete process.env.CONSOLE_RUNTIME;
    vi.resetModules();
  });

  it("bcrypt password key: value is hashed before storage (K8s mode)", async () => {
    const mockPatch = vi.fn().mockResolvedValue(undefined);
    vi.mocked(coreV1).mockImplementation(() => ({
      readNamespacedSecret: vi.fn().mockResolvedValue(undefined),
      patchNamespacedSecret: mockPatch,
      replaceNamespacedSecret: vi.fn().mockResolvedValue(undefined),
    }) as never);

    const [req, ctx] = makePatchRequest("console-auth-password", { value: "MyPlainPassword123" });
    const res = await PATCH(req, ctx);

    expect(res.status).toBe(200);

    // The stored value should be the bcrypt hash, not the plain password
    expect(mockPatch).toHaveBeenCalledOnce();
    const callArg = mockPatch.mock.calls[0][0];
    const storedEncoded: string = callArg.body.data["CONSOLE_PASSWORD_HASH"];
    const stored = Buffer.from(storedEncoded, "base64").toString("utf-8");
    // Our mock bcryptjs always returns "$2b$12$hashed-password"
    expect(stored).toBe("$2b$12$hashed-password");
    expect(stored).not.toBe("MyPlainPassword123");
  });

  it("invalid body: 400 from zod validation", async () => {
    const mockPatch = vi.fn().mockResolvedValue(undefined);
    vi.mocked(coreV1).mockImplementation(() => ({
      readNamespacedSecret: vi.fn().mockResolvedValue(undefined),
      patchNamespacedSecret: mockPatch,
      replaceNamespacedSecret: vi.fn().mockResolvedValue(undefined),
    }) as never);

    const [req, ctx] = makePatchRequest("ngc-key", { value: "" }); // empty string fails min(1)
    const res = await PATCH(req, ctx);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/validation failed/i);
    expect(mockPatch).not.toHaveBeenCalled();
  });

  it("kiosk mode: rejectIfKiosk returns 403 → short-circuits, no K8s call", async () => {
    const kioskResponse = NextResponse.json({ error: "kiosk mode is read-only" }, { status: 403 });
    vi.mocked(rejectIfKiosk).mockResolvedValue(kioskResponse);

    const mockPatch = vi.fn().mockResolvedValue(undefined);
    vi.mocked(coreV1).mockImplementation(() => ({
      readNamespacedSecret: vi.fn().mockResolvedValue(undefined),
      patchNamespacedSecret: mockPatch,
      replaceNamespacedSecret: vi.fn().mockResolvedValue(undefined),
    }) as never);

    const [req, ctx] = makePatchRequest("ngc-key", { value: "some-key" });
    const res = await PATCH(req, ctx);

    expect(res.status).toBe(403);
    expect(mockPatch).not.toHaveBeenCalled();
  });

  it("unknown key → 400", async () => {
    const mockPatch = vi.fn().mockResolvedValue(undefined);
    vi.mocked(coreV1).mockImplementation(() => ({
      readNamespacedSecret: vi.fn().mockResolvedValue(undefined),
      patchNamespacedSecret: mockPatch,
      replaceNamespacedSecret: vi.fn().mockResolvedValue(undefined),
    }) as never);

    const [req, ctx] = makePatchRequest("not-a-real-key", { value: "something" });
    const res = await PATCH(req, ctx);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/unknown secret key/i);
    expect(mockPatch).not.toHaveBeenCalled();
  });

  it("auth missing → 401", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);

    const [req, ctx] = makePatchRequest("ngc-key", { value: "some-key" });
    const res = await PATCH(req, ctx);

    expect(res.status).toBe(401);
  });
});

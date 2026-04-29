import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock child_process.execFile before importing the module under test.
vi.mock("child_process", () => ({
  execFile: vi.fn(),
}));

// Mock fs/promises (temp file write/unlink in gcsCamerasPut).
// Note: vi.resetAllMocks() in beforeEach clears implementations but leaves the mock in
// place; we re-apply the default implementations per describe block below.
vi.mock("fs/promises", () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
  unlink: vi.fn().mockResolvedValue(undefined),
}));

// server-only is already stubbed by tests/setup.ts.

import * as childProcess from "child_process";
import * as fsMod from "fs/promises";
import {
  gcsCamerasGet,
  gcsCamerasPut,
  gcsHealthCheck,
  gcsPromptGet,
  gcsPromptPut,
  gcsScenariosGet,
  gcsScenariosPut,
  type CameraList,
  type PromptConfig,
  type ScenariosConfig,
} from "@/lib/helpers/gcs-config";

// Helper: mock execFile to resolve with stdout/stderr
function mockExecFileSuccess(stdout: string, stderr = "") {
  (childProcess.execFile as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    (_cmd: string, _args: string[], _opts: unknown, callback: (err: null, result: { stdout: string; stderr: string }) => void) => {
      callback(null, { stdout, stderr });
    },
  );
}

function mockExecFileError(code: number | string, stderr = "some error") {
  (childProcess.execFile as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    (_cmd: string, _args: string[], _opts: unknown, callback: (err: Error & { code?: number | string; stderr?: string; killed?: boolean }) => void) => {
      const err = Object.assign(new Error("execFile error"), { code, stderr, killed: false });
      callback(err);
    },
  );
}

function mockExecFileNotFound() {
  (childProcess.execFile as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    (_cmd: string, _args: string[], _opts: unknown, callback: (err: Error & { code?: string }) => void) => {
      const err = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      callback(err);
    },
  );
}

/** Restore the fs/promises mocks to their default resolved-undefined behavior. */
function resetFsMocks() {
  (fsMod.writeFile as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
  (fsMod.unlink as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
}

const VALID_CAMERA_LIST: CameraList = {
  schema: "isv-labs.cameras.v1",
  instance: "vss-brev-1",
  updatedAt: "2026-04-28T22:00:00Z",
  updatedBy: "stephane.richard@scality.com",
  cameras: [
    { id: "checkout-1", rtspUrl: "rtsp://1.2.3.4:8554/checkout-1", description: "Self-checkout" },
    { id: "aisle-1", rtspUrl: "rtsp://1.2.3.4:8554/aisle-1" },
  ],
};

beforeEach(() => {
  vi.resetAllMocks();
  // Re-apply fs defaults after every reset.
  resetFsMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// --- gcsCamerasGet ---

describe("gcsCamerasGet", () => {
  it("returns null when the object does not exist (No URLs matched)", async () => {
    mockExecFileError(1, "CommandException: No URLs matched");
    const result = await gcsCamerasGet("vss-brev-1");
    expect(result).toBeNull();
  });

  it("returns null when GCS times out (killed=true)", async () => {
    (childProcess.execFile as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, callback: (err: Error & { killed?: boolean }) => void) => {
        const err = Object.assign(new Error("timed out"), { killed: true });
        callback(err);
      },
    );
    const result = await gcsCamerasGet("vss-brev-1");
    expect(result).toBeNull();
  });

  it("returns parsed CameraList when the object exists", async () => {
    mockExecFileSuccess(JSON.stringify(VALID_CAMERA_LIST));
    const result = await gcsCamerasGet("vss-brev-1");
    expect(result).not.toBeNull();
    expect(result?.schema).toBe("isv-labs.cameras.v1");
    expect(result?.cameras).toHaveLength(2);
    expect(result?.cameras[0].id).toBe("checkout-1");
  });

  it("returns null and logs warning on wrong schema (v0)", async () => {
    const badSchema = { ...VALID_CAMERA_LIST, schema: "isv-labs.cameras.v0" };
    mockExecFileSuccess(JSON.stringify(badSchema));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => void 0);
    const result = await gcsCamerasGet("vss-brev-1");
    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("schema mismatch"));
  });

  it("returns null on unknown schema (v2)", async () => {
    const v2 = { ...VALID_CAMERA_LIST, schema: "isv-labs.cameras.v2" };
    mockExecFileSuccess(JSON.stringify(v2));
    vi.spyOn(console, "warn").mockImplementation(() => void 0);
    expect(await gcsCamerasGet("vss-brev-1")).toBeNull();
  });

  it("returns null when cameras field is missing", async () => {
    const { cameras: _c, ...noCams } = VALID_CAMERA_LIST;
    mockExecFileSuccess(JSON.stringify(noCams));
    vi.spyOn(console, "warn").mockImplementation(() => void 0);
    expect(await gcsCamerasGet("vss-brev-1")).toBeNull();
  });

  it("returns null on invalid JSON", async () => {
    mockExecFileSuccess("not valid json {{{");
    vi.spyOn(console, "warn").mockImplementation(() => void 0);
    expect(await gcsCamerasGet("vss-brev-1")).toBeNull();
  });

  it("invokes gsutil cat with the correct GCS URL", async () => {
    mockExecFileSuccess(JSON.stringify(VALID_CAMERA_LIST));
    await gcsCamerasGet("vss-my-instance");
    const calls = (childProcess.execFile as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const [cmd, args] = calls[0] as [string, string[]];
    expect(cmd).toBe("gsutil");
    expect(args[0]).toBe("cat");
    expect(args[1]).toContain("cameras/vss-my-instance.json");
  });
});

// --- gcsCamerasPut ---

describe("gcsCamerasPut", () => {
  it("invokes gsutil cp with the correct destination URL", async () => {
    mockExecFileSuccess("");
    await gcsCamerasPut(VALID_CAMERA_LIST);
    const calls = (childProcess.execFile as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const [cmd, args] = calls[0] as [string, string[]];
    expect(cmd).toBe("gsutil");
    expect(args[0]).toBe("cp");
    expect(args[2]).toContain("cameras/vss-brev-1.json");
  });

  it("stamps updatedAt before writing (not the original input value)", async () => {
    const inputTs = "2020-01-01T00:00:00Z";
    const before = new Date().toISOString();
    (fsMod.writeFile as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (_path: string, content: string) => {
        const obj = JSON.parse(content as string) as CameraList;
        expect(obj.updatedAt >= before).toBe(true);
        expect(obj.updatedAt).not.toBe(inputTs);
        return Promise.resolve();
      },
    );
    mockExecFileSuccess("");
    await gcsCamerasPut({ ...VALID_CAMERA_LIST, updatedAt: inputTs });
  });

  it("throws on gsutil failure", async () => {
    mockExecFileError(1, "AccessDeniedException: 403");
    await expect(gcsCamerasPut(VALID_CAMERA_LIST)).rejects.toThrow();
  });
});

// --- gcsHealthCheck ---

describe("gcsHealthCheck", () => {
  it("returns no-gsutil when gsutil is not in PATH", async () => {
    mockExecFileNotFound();
    const result = await gcsHealthCheck();
    expect(result.status).toBe("no-gsutil");
  });

  it("returns no-credentials on AccessDeniedException from gsutil ls", async () => {
    let callCount = 0;
    (childProcess.execFile as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, callback: (err: null | (Error & { code?: number; stderr?: string; killed?: boolean }), result?: { stdout: string; stderr: string }) => void) => {
        callCount++;
        if (callCount === 1) {
          callback(null, { stdout: "gsutil version: 5.x", stderr: "" });
        } else {
          const err = Object.assign(new Error("exec error"), {
            code: 1,
            stderr: "AccessDeniedException: 403 Forbidden",
            killed: false,
          });
          callback(err);
        }
      },
    );
    const result = await gcsHealthCheck();
    expect(result.status).toBe("no-credentials");
  });

  it("returns ok when gsutil ls succeeds", async () => {
    mockExecFileSuccess("gs://scality-isv-labs-config/cameras/");
    const result = await gcsHealthCheck();
    expect(result.status).toBe("ok");
  });
});

// ─── gcsPromptGet ─────────────────────────────────────────────────────────────

const VALID_PROMPT_CONFIG: PromptConfig = {
  schema: "isv-labs.prompt.v1",
  instance: "vss-brev-1",
  updatedAt: "2026-04-28T22:00:00Z",
  updatedBy: "stephane.richard@scality.com",
  prompt: "You are a retail surveillance assistant. Detect theft.",
  model: "cosmos-reason1-7b",
};

describe("gcsPromptGet", () => {
  it("returns null when the object does not exist (No URLs matched)", async () => {
    mockExecFileError(1, "CommandException: No URLs matched");
    expect(await gcsPromptGet("vss-brev-1")).toBeNull();
  });

  it("returns parsed PromptConfig when the object exists", async () => {
    mockExecFileSuccess(JSON.stringify(VALID_PROMPT_CONFIG));
    const result = await gcsPromptGet("vss-brev-1");
    expect(result).not.toBeNull();
    expect(result?.schema).toBe("isv-labs.prompt.v1");
    expect(result?.prompt).toBe(VALID_PROMPT_CONFIG.prompt);
  });

  it("returns null on schema mismatch (wrong schema string)", async () => {
    const bad = { ...VALID_PROMPT_CONFIG, schema: "isv-labs.prompt.v0" };
    mockExecFileSuccess(JSON.stringify(bad));
    vi.spyOn(console, "warn").mockImplementation(() => void 0);
    const result = await gcsPromptGet("vss-brev-1");
    expect(result).toBeNull();
  });

  it("returns null on invalid JSON", async () => {
    mockExecFileSuccess("not valid json {{{");
    vi.spyOn(console, "warn").mockImplementation(() => void 0);
    expect(await gcsPromptGet("vss-brev-1")).toBeNull();
  });

  it("invokes gsutil cat with the correct GCS URL", async () => {
    mockExecFileSuccess(JSON.stringify(VALID_PROMPT_CONFIG));
    await gcsPromptGet("my-instance");
    const calls = (childProcess.execFile as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const [cmd, args] = calls[0] as [string, string[]];
    expect(cmd).toBe("gsutil");
    expect(args[0]).toBe("cat");
    expect(args[1]).toContain("prompt/my-instance.json");
  });
});

// ─── gcsPromptPut ─────────────────────────────────────────────────────────────

describe("gcsPromptPut", () => {
  it("invokes gsutil cp with the correct destination URL", async () => {
    mockExecFileSuccess("");
    await gcsPromptPut(VALID_PROMPT_CONFIG);
    const calls = (childProcess.execFile as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const [cmd, args] = calls[0] as [string, string[]];
    expect(cmd).toBe("gsutil");
    expect(args[0]).toBe("cp");
    expect(args[2]).toContain("prompt/vss-brev-1.json");
  });

  it("stamps updatedAt before writing", async () => {
    const inputTs = "2020-01-01T00:00:00Z";
    const before = new Date().toISOString();
    (fsMod.writeFile as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (_path: string, content: string) => {
        const obj = JSON.parse(content as string) as PromptConfig;
        expect(obj.updatedAt >= before).toBe(true);
        expect(obj.updatedAt).not.toBe(inputTs);
        return Promise.resolve();
      },
    );
    mockExecFileSuccess("");
    await gcsPromptPut({ ...VALID_PROMPT_CONFIG, updatedAt: inputTs });
  });

  it("throws on gsutil failure", async () => {
    mockExecFileError(1, "AccessDeniedException: 403");
    await expect(gcsPromptPut(VALID_PROMPT_CONFIG)).rejects.toThrow();
  });
});

// ─── gcsScenariosGet ──────────────────────────────────────────────────────────

const VALID_SCENARIOS_CONFIG: ScenariosConfig = {
  schema: "isv-labs.scenarios.v1",
  instance: "vss-brev-1",
  updatedAt: "2026-04-28T22:00:00Z",
  updatedBy: "stephane.richard@scality.com",
  scenarios: [
    {
      id: "theft-1",
      name: "Theft Detection",
      severity: "high",
      channels: ["ui", "slack"],
      sensor_filter: "*",
      keywords: ["steal", "conceal"],
      enabled: true,
    },
  ],
};

describe("gcsScenariosGet", () => {
  it("returns null when the object does not exist (No URLs matched)", async () => {
    mockExecFileError(1, "CommandException: No URLs matched");
    expect(await gcsScenariosGet("vss-brev-1")).toBeNull();
  });

  it("returns parsed ScenariosConfig when the object exists", async () => {
    mockExecFileSuccess(JSON.stringify(VALID_SCENARIOS_CONFIG));
    const result = await gcsScenariosGet("vss-brev-1");
    expect(result).not.toBeNull();
    expect(result?.schema).toBe("isv-labs.scenarios.v1");
    expect(result?.scenarios).toHaveLength(1);
    expect(result?.scenarios[0].id).toBe("theft-1");
  });

  it("returns null on schema mismatch", async () => {
    const bad = { ...VALID_SCENARIOS_CONFIG, schema: "isv-labs.scenarios.v0" };
    mockExecFileSuccess(JSON.stringify(bad));
    vi.spyOn(console, "warn").mockImplementation(() => void 0);
    expect(await gcsScenariosGet("vss-brev-1")).toBeNull();
  });

  it("returns null on invalid JSON", async () => {
    mockExecFileSuccess("not valid json {{{");
    vi.spyOn(console, "warn").mockImplementation(() => void 0);
    expect(await gcsScenariosGet("vss-brev-1")).toBeNull();
  });

  it("invokes gsutil cat with the correct GCS URL", async () => {
    mockExecFileSuccess(JSON.stringify(VALID_SCENARIOS_CONFIG));
    await gcsScenariosGet("my-instance");
    const calls = (childProcess.execFile as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const [cmd, args] = calls[0] as [string, string[]];
    expect(cmd).toBe("gsutil");
    expect(args[0]).toBe("cat");
    expect(args[1]).toContain("scenarios/my-instance.json");
  });
});

// ─── gcsScenariosPut ─────────────────────────────────────────────────────────

describe("gcsScenariosPut", () => {
  it("invokes gsutil cp with the correct destination URL", async () => {
    mockExecFileSuccess("");
    await gcsScenariosPut(VALID_SCENARIOS_CONFIG);
    const calls = (childProcess.execFile as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const [cmd, args] = calls[0] as [string, string[]];
    expect(cmd).toBe("gsutil");
    expect(args[0]).toBe("cp");
    expect(args[2]).toContain("scenarios/vss-brev-1.json");
  });

  it("stamps updatedAt before writing", async () => {
    const inputTs = "2020-01-01T00:00:00Z";
    const before = new Date().toISOString();
    (fsMod.writeFile as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (_path: string, content: string) => {
        const obj = JSON.parse(content as string) as ScenariosConfig;
        expect(obj.updatedAt >= before).toBe(true);
        expect(obj.updatedAt).not.toBe(inputTs);
        return Promise.resolve();
      },
    );
    mockExecFileSuccess("");
    await gcsScenariosPut({ ...VALID_SCENARIOS_CONFIG, updatedAt: inputTs });
  });

  it("throws on gsutil failure", async () => {
    mockExecFileError(1, "AccessDeniedException: 403");
    await expect(gcsScenariosPut(VALID_SCENARIOS_CONFIG)).rejects.toThrow();
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock fs so loadKey() can return a fake service-account JSON without touching disk.
vi.mock("fs", () => ({
  readFileSync: vi.fn(),
}));

// Mock crypto so mintJwt() does not require a real RSA private key.
// The implementation calls: createSign("RSA-SHA256").update(str).sign(key, "base64url")
vi.mock("crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("crypto")>();
  return {
    ...actual,
    createSign: vi.fn(() => ({
      update: vi.fn().mockReturnThis(),
      sign: vi.fn().mockReturnValue("fake-sig"),
    })),
  };
});

// server-only is already stubbed by tests/setup.ts.

import * as fsMod from "fs";
import * as cryptoMod from "crypto";
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

// ─── Fake service-account key ─────────────────────────────────────────────────

const FAKE_SERVICE_ACCOUNT = {
  client_email: "test-sa@test-project.iam.gserviceaccount.com",
  private_key:
    "-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----",
  private_key_id: "key-001",
  token_uri: "https://oauth2.googleapis.com/token",
};

// ─── fetch mock helpers ───────────────────────────────────────────────────────
//
// Dispatch based on URL rather than call count so tests are immune to token-
// cache state (the module-level _tokenCache persists across tests).
//
// Token exchange: POST to https://oauth2.googleapis.com/token
// GCS REST:       any URL containing storage.googleapis.com

const TOKEN_ENDPOINT = "oauth2.googleapis.com/token";

/** Build a fake Response-like object. */
function fakeResponse(body: unknown, status = 200) {
  const bodyStr = typeof body === "string" ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(bodyStr),
    json: () => {
      try {
        return Promise.resolve(JSON.parse(bodyStr));
      } catch {
        return Promise.reject(new Error("not json"));
      }
    },
  };
}

/**
 * Mock fetch with URL-based dispatch:
 *   - requests to the token endpoint → return a valid token response
 *   - all other requests (GCS REST) → return gcsBody at gcsStatus
 */
function mockFetch(gcsBody: unknown, gcsStatus = 200) {
  const tokenResponse = { access_token: "fake-tok", expires_in: 3600 };
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation((url: string) => {
      if (url.includes(TOKEN_ENDPOINT)) {
        return Promise.resolve(fakeResponse(tokenResponse));
      }
      return Promise.resolve(fakeResponse(gcsBody, gcsStatus));
    }),
  );
}

/** Make the token exchange fail (non-ok status). All URLs return the error. */
function mockFetchTokenFail(status = 401) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(fakeResponse("Unauthorized", status)),
  );
}

// ─── Credentials setup ────────────────────────────────────────────────────────

function setupCredentials() {
  process.env.GOOGLE_APPLICATION_CREDENTIALS = "/fake/key.json";
  (fsMod.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(
    JSON.stringify(FAKE_SERVICE_ACCOUNT),
  );
}

function clearCredentials() {
  delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
}

// ─── Test fixtures ────────────────────────────────────────────────────────────

const VALID_CAMERA_LIST: CameraList = {
  schema: "isv-labs.cameras.v1",
  instance: "nvidia-vss-brev-1",
  updatedAt: "2026-04-28T22:00:00Z",
  updatedBy: "stephane.richard@scality.com",
  cameras: [
    {
      id: "checkout-1",
      rtspUrl: "rtsp://1.2.3.4:8554/checkout-1",
      description: "Self-checkout",
    },
    { id: "aisle-1", rtspUrl: "rtsp://1.2.3.4:8554/aisle-1" },
  ],
};

const VALID_PROMPT_CONFIG: PromptConfig = {
  schema: "isv-labs.prompt.v1",
  instance: "nvidia-vss-brev-1",
  updatedAt: "2026-04-28T22:00:00Z",
  updatedBy: "stephane.richard@scality.com",
  prompt: "You are a retail surveillance assistant. Detect theft.",
  model: "cosmos-reason1-7b",
};

const VALID_SCENARIOS_CONFIG: ScenariosConfig = {
  schema: "isv-labs.scenarios.v1",
  instance: "nvidia-vss-brev-1",
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

// ─── Lifecycle ────────────────────────────────────────────────────────────────

let stderrWrites: string[] = [];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let stderrSpy: any;

beforeEach(() => {
  vi.resetAllMocks();
  // Re-apply crypto mock implementation after vi.resetAllMocks() clears it.
  (cryptoMod.createSign as ReturnType<typeof vi.fn>).mockImplementation(() => ({
    update: vi.fn().mockReturnThis(),
    sign: vi.fn().mockReturnValue("fake-sig"),
  }));
  // Suppress / capture structured logger output (goes to process.stderr.write).
  stderrWrites = [];
  stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((c) => {
    stderrWrites.push(String(c));
    return true;
  });
  vi.stubEnv("LOG_PRETTY", "0");
  clearCredentials();
});

afterEach(() => {
  stderrSpy.mockRestore();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  clearCredentials();
});

// ─── gcsCamerasGet ────────────────────────────────────────────────────────────

describe("gcsCamerasGet", () => {
  it("returns null when GOOGLE_APPLICATION_CREDENTIALS is not set", async () => {
    clearCredentials();
    expect(await gcsCamerasGet("nvidia-vss-brev-1")).toBeNull();
  });

  it("returns null when the GCS object does not exist (404)", async () => {
    setupCredentials();
    mockFetch("Not Found", 404);
    expect(await gcsCamerasGet("nvidia-vss-brev-1")).toBeNull();
  });

  it("returns null when the GCS request fails with a network error", async () => {
    setupCredentials();
    const tokenResponse = { access_token: "fake-tok", expires_in: 3600 };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        if (url.includes(TOKEN_ENDPOINT)) {
          return Promise.resolve(fakeResponse(tokenResponse));
        }
        return Promise.reject(
          Object.assign(new Error("The operation was aborted"), {
            name: "AbortError",
          }),
        );
      }),
    );
    expect(await gcsCamerasGet("nvidia-vss-brev-1")).toBeNull();
  });

  it("returns parsed CameraList when the GCS object exists", async () => {
    setupCredentials();
    mockFetch(VALID_CAMERA_LIST);
    const result = await gcsCamerasGet("nvidia-vss-brev-1");
    expect(result).not.toBeNull();
    expect(result?.schema).toBe("isv-labs.cameras.v1");
    expect(result?.cameras).toHaveLength(2);
    expect(result?.cameras[0].id).toBe("checkout-1");
  });

  it("returns null and logs warning on wrong schema", async () => {
    setupCredentials();
    const badSchema = { ...VALID_CAMERA_LIST, schema: "isv-labs.cameras.v0" };
    mockFetch(badSchema);
    const result = await gcsCamerasGet("nvidia-vss-brev-1");
    expect(result).toBeNull();
    const warnRecords = stderrWrites.map((s) => JSON.parse(s));
    expect(warnRecords).toContainEqual(
      expect.objectContaining({ level: "warn", scope: "gcs-config", msg: expect.stringContaining("schema mismatch") }),
    );
  });

  it("accepts isv-labs.cameras.v2 schema", async () => {
    setupCredentials();
    const v2 = {
      ...VALID_CAMERA_LIST,
      schema: "isv-labs.cameras.v2",
    } as CameraList;
    mockFetch(v2);
    const result = await gcsCamerasGet("nvidia-vss-brev-1");
    expect(result).not.toBeNull();
    expect(result?.schema).toBe("isv-labs.cameras.v2");
  });

  it("returns null when cameras field is missing", async () => {
    setupCredentials();
    const { cameras: _c, ...noCams } = VALID_CAMERA_LIST;
    mockFetch(noCams);
    vi.spyOn(console, "warn").mockImplementation(() => void 0);
    expect(await gcsCamerasGet("nvidia-vss-brev-1")).toBeNull();
  });

  it("returns null on invalid JSON in GCS response", async () => {
    setupCredentials();
    mockFetch("not valid json {{{");
    vi.spyOn(console, "warn").mockImplementation(() => void 0);
    expect(await gcsCamerasGet("nvidia-vss-brev-1")).toBeNull();
  });

  it("sends a GET request to the GCS REST URL containing the correct object path", async () => {
    setupCredentials();
    const fetchMock = vi.fn();
    const tokenResponse = { access_token: "tok", expires_in: 3600 };
    fetchMock.mockImplementation((url: string) => {
      if (url.includes(TOKEN_ENDPOINT)) {
        return Promise.resolve(fakeResponse(tokenResponse));
      }
      expect(url).toContain("cameras%2Fnvidia-vss-my-instance.json");
      expect(url).toContain("storage.googleapis.com");
      expect(url).toContain("alt=media");
      return Promise.resolve(fakeResponse(VALID_CAMERA_LIST));
    });
    vi.stubGlobal("fetch", fetchMock);
    await gcsCamerasGet("nvidia-vss-my-instance");
    // At least the GCS GET call must have occurred.
    const gcsCalls = fetchMock.mock.calls.filter(
      (args) => !String(args[0]).includes(TOKEN_ENDPOINT),
    );
    expect(gcsCalls.length).toBeGreaterThan(0);
  });
});

// ─── gcsCamerasPut ────────────────────────────────────────────────────────────

describe("gcsCamerasPut", () => {
  it("sends a media upload POST to the GCS REST URL with the correct object path", async () => {
    setupCredentials();
    const fetchMock = vi.fn();
    fetchMock.mockImplementation((url: string) => {
      if (url.includes(TOKEN_ENDPOINT)) {
        return Promise.resolve(
          fakeResponse({ access_token: "tok", expires_in: 3600 }),
        );
      }
      expect(url).toContain("cameras%2Fnvidia-vss-brev-1.json");
      expect(url).toContain("uploadType=media");
      return Promise.resolve(fakeResponse({}));
    });
    vi.stubGlobal("fetch", fetchMock);
    await gcsCamerasPut(VALID_CAMERA_LIST);
    const gcsCalls = fetchMock.mock.calls.filter(
      (args) => !String(args[0]).includes(TOKEN_ENDPOINT),
    );
    expect(gcsCalls.length).toBe(1);
  });

  it("stamps updatedAt before writing (not the original input value)", async () => {
    setupCredentials();
    const inputTs = "2020-01-01T00:00:00Z";
    const before = new Date().toISOString();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string, init?: RequestInit) => {
        if (url.includes(TOKEN_ENDPOINT)) {
          return Promise.resolve(
            fakeResponse({ access_token: "tok", expires_in: 3600 }),
          );
        }
        // GCS PUT — inspect the request body
        const body = JSON.parse(init?.body as string) as CameraList;
        expect(body.updatedAt >= before).toBe(true);
        expect(body.updatedAt).not.toBe(inputTs);
        return Promise.resolve(fakeResponse({}));
      }),
    );
    await gcsCamerasPut({ ...VALID_CAMERA_LIST, updatedAt: inputTs });
  });

  it("throws when GOOGLE_APPLICATION_CREDENTIALS is not set", async () => {
    clearCredentials();
    await expect(gcsCamerasPut(VALID_CAMERA_LIST)).rejects.toThrow();
  });

  it("throws on GCS permission error (403)", async () => {
    setupCredentials();
    mockFetch("AccessDeniedException: 403", 403);
    await expect(gcsCamerasPut(VALID_CAMERA_LIST)).rejects.toThrow();
  });
});

// ─── gcsHealthCheck ───────────────────────────────────────────────────────────

describe("gcsHealthCheck", () => {
  it("returns no-credentials when GOOGLE_APPLICATION_CREDENTIALS is not set", async () => {
    clearCredentials();
    const result = await gcsHealthCheck();
    expect(result.status).toBe("no-credentials");
    expect(result.detail).toContain("GOOGLE_APPLICATION_CREDENTIALS");
  });

  it("returns no-credentials when the token exchange fails (401)", async () => {
    setupCredentials();
    mockFetchTokenFail(401);
    const result = await gcsHealthCheck();
    expect(result.status).toBe("no-credentials");
  });

  it("returns ok when token exchange and GCS list both succeed", async () => {
    setupCredentials();
    const listBody = { kind: "storage#objects", items: [] };
    mockFetch(listBody, 200);
    const result = await gcsHealthCheck();
    expect(result.status).toBe("ok");
  });

  it("returns no-credentials when the GCS list returns 403", async () => {
    setupCredentials();
    mockFetch("Permission denied", 403);
    const result = await gcsHealthCheck();
    expect(result.status).toBe("no-credentials");
  });

  it("returns error when the GCS list returns an unexpected HTTP error", async () => {
    setupCredentials();
    mockFetch("Internal Server Error", 500);
    const result = await gcsHealthCheck();
    expect(result.status).toBe("error");
  });
});

// ─── gcsPromptGet ─────────────────────────────────────────────────────────────

describe("gcsPromptGet", () => {
  it("returns null when GOOGLE_APPLICATION_CREDENTIALS is not set", async () => {
    clearCredentials();
    expect(await gcsPromptGet("nvidia-vss-brev-1")).toBeNull();
  });

  it("returns null when the GCS object does not exist (404)", async () => {
    setupCredentials();
    mockFetch("Not Found", 404);
    expect(await gcsPromptGet("nvidia-vss-brev-1")).toBeNull();
  });

  it("returns parsed PromptConfig when the GCS object exists", async () => {
    setupCredentials();
    mockFetch(VALID_PROMPT_CONFIG);
    const result = await gcsPromptGet("nvidia-vss-brev-1");
    expect(result).not.toBeNull();
    expect(result?.schema).toBe("isv-labs.prompt.v1");
    expect(result?.prompt).toBe(VALID_PROMPT_CONFIG.prompt);
  });

  it("returns null on schema mismatch (wrong schema string)", async () => {
    setupCredentials();
    const bad = { ...VALID_PROMPT_CONFIG, schema: "isv-labs.prompt.v0" };
    mockFetch(bad);
    vi.spyOn(console, "warn").mockImplementation(() => void 0);
    expect(await gcsPromptGet("nvidia-vss-brev-1")).toBeNull();
  });

  it("returns null on invalid JSON in GCS response", async () => {
    setupCredentials();
    mockFetch("not valid json {{{");
    vi.spyOn(console, "warn").mockImplementation(() => void 0);
    expect(await gcsPromptGet("nvidia-vss-brev-1")).toBeNull();
  });

  it("sends a GET request to the GCS REST URL containing the correct object path", async () => {
    setupCredentials();
    const fetchMock = vi.fn();
    fetchMock.mockImplementation((url: string) => {
      if (url.includes(TOKEN_ENDPOINT)) {
        return Promise.resolve(
          fakeResponse({ access_token: "tok", expires_in: 3600 }),
        );
      }
      expect(url).toContain("prompt%2Fmy-instance.json");
      expect(url).toContain("storage.googleapis.com");
      return Promise.resolve(fakeResponse(VALID_PROMPT_CONFIG));
    });
    vi.stubGlobal("fetch", fetchMock);
    await gcsPromptGet("my-instance");
    const gcsCalls = fetchMock.mock.calls.filter(
      (args) => !String(args[0]).includes(TOKEN_ENDPOINT),
    );
    expect(gcsCalls.length).toBeGreaterThan(0);
  });
});

// ─── gcsPromptPut ─────────────────────────────────────────────────────────────

describe("gcsPromptPut", () => {
  it("sends a media upload POST to the GCS REST URL with the correct object path", async () => {
    setupCredentials();
    const fetchMock = vi.fn();
    fetchMock.mockImplementation((url: string) => {
      if (url.includes(TOKEN_ENDPOINT)) {
        return Promise.resolve(
          fakeResponse({ access_token: "tok", expires_in: 3600 }),
        );
      }
      expect(url).toContain("prompt%2Fnvidia-vss-brev-1.json");
      expect(url).toContain("uploadType=media");
      return Promise.resolve(fakeResponse({}));
    });
    vi.stubGlobal("fetch", fetchMock);
    await gcsPromptPut(VALID_PROMPT_CONFIG);
    const gcsCalls = fetchMock.mock.calls.filter(
      (args) => !String(args[0]).includes(TOKEN_ENDPOINT),
    );
    expect(gcsCalls.length).toBe(1);
  });

  it("stamps updatedAt before writing", async () => {
    setupCredentials();
    const inputTs = "2020-01-01T00:00:00Z";
    const before = new Date().toISOString();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string, init?: RequestInit) => {
        if (url.includes(TOKEN_ENDPOINT)) {
          return Promise.resolve(
            fakeResponse({ access_token: "tok", expires_in: 3600 }),
          );
        }
        const body = JSON.parse(init?.body as string) as PromptConfig;
        expect(body.updatedAt >= before).toBe(true);
        expect(body.updatedAt).not.toBe(inputTs);
        return Promise.resolve(fakeResponse({}));
      }),
    );
    await gcsPromptPut({ ...VALID_PROMPT_CONFIG, updatedAt: inputTs });
  });

  it("throws when GOOGLE_APPLICATION_CREDENTIALS is not set", async () => {
    clearCredentials();
    await expect(gcsPromptPut(VALID_PROMPT_CONFIG)).rejects.toThrow();
  });

  it("throws on GCS permission error (403)", async () => {
    setupCredentials();
    mockFetch("AccessDeniedException: 403", 403);
    await expect(gcsPromptPut(VALID_PROMPT_CONFIG)).rejects.toThrow();
  });
});

// ─── gcsScenariosGet ──────────────────────────────────────────────────────────

describe("gcsScenariosGet", () => {
  it("returns null when GOOGLE_APPLICATION_CREDENTIALS is not set", async () => {
    clearCredentials();
    expect(await gcsScenariosGet("nvidia-vss-brev-1")).toBeNull();
  });

  it("returns null when the GCS object does not exist (404)", async () => {
    setupCredentials();
    mockFetch("Not Found", 404);
    expect(await gcsScenariosGet("nvidia-vss-brev-1")).toBeNull();
  });

  it("returns parsed ScenariosConfig when the GCS object exists", async () => {
    setupCredentials();
    mockFetch(VALID_SCENARIOS_CONFIG);
    const result = await gcsScenariosGet("nvidia-vss-brev-1");
    expect(result).not.toBeNull();
    expect(result?.schema).toBe("isv-labs.scenarios.v1");
    expect(result?.scenarios).toHaveLength(1);
    expect(result?.scenarios[0].id).toBe("theft-1");
  });

  it("returns null on schema mismatch", async () => {
    setupCredentials();
    const bad = {
      ...VALID_SCENARIOS_CONFIG,
      schema: "isv-labs.scenarios.v0",
    };
    mockFetch(bad);
    vi.spyOn(console, "warn").mockImplementation(() => void 0);
    expect(await gcsScenariosGet("nvidia-vss-brev-1")).toBeNull();
  });

  it("returns null on invalid JSON in GCS response", async () => {
    setupCredentials();
    mockFetch("not valid json {{{");
    vi.spyOn(console, "warn").mockImplementation(() => void 0);
    expect(await gcsScenariosGet("nvidia-vss-brev-1")).toBeNull();
  });

  it("sends a GET request to the GCS REST URL containing the correct object path", async () => {
    setupCredentials();
    const fetchMock = vi.fn();
    fetchMock.mockImplementation((url: string) => {
      if (url.includes(TOKEN_ENDPOINT)) {
        return Promise.resolve(
          fakeResponse({ access_token: "tok", expires_in: 3600 }),
        );
      }
      expect(url).toContain("scenarios%2Fmy-instance.json");
      expect(url).toContain("storage.googleapis.com");
      return Promise.resolve(fakeResponse(VALID_SCENARIOS_CONFIG));
    });
    vi.stubGlobal("fetch", fetchMock);
    await gcsScenariosGet("my-instance");
    const gcsCalls = fetchMock.mock.calls.filter(
      (args) => !String(args[0]).includes(TOKEN_ENDPOINT),
    );
    expect(gcsCalls.length).toBeGreaterThan(0);
  });
});

// ─── gcsScenariosPut ─────────────────────────────────────────────────────────

describe("gcsScenariosPut", () => {
  it("sends a media upload POST to the GCS REST URL with the correct object path", async () => {
    setupCredentials();
    const fetchMock = vi.fn();
    fetchMock.mockImplementation((url: string) => {
      if (url.includes(TOKEN_ENDPOINT)) {
        return Promise.resolve(
          fakeResponse({ access_token: "tok", expires_in: 3600 }),
        );
      }
      expect(url).toContain("scenarios%2Fnvidia-vss-brev-1.json");
      expect(url).toContain("uploadType=media");
      return Promise.resolve(fakeResponse({}));
    });
    vi.stubGlobal("fetch", fetchMock);
    await gcsScenariosPut(VALID_SCENARIOS_CONFIG);
    const gcsCalls = fetchMock.mock.calls.filter(
      (args) => !String(args[0]).includes(TOKEN_ENDPOINT),
    );
    expect(gcsCalls.length).toBe(1);
  });

  it("stamps updatedAt before writing", async () => {
    setupCredentials();
    const inputTs = "2020-01-01T00:00:00Z";
    const before = new Date().toISOString();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string, init?: RequestInit) => {
        if (url.includes(TOKEN_ENDPOINT)) {
          return Promise.resolve(
            fakeResponse({ access_token: "tok", expires_in: 3600 }),
          );
        }
        const body = JSON.parse(init?.body as string) as ScenariosConfig;
        expect(body.updatedAt >= before).toBe(true);
        expect(body.updatedAt).not.toBe(inputTs);
        return Promise.resolve(fakeResponse({}));
      }),
    );
    await gcsScenariosPut({ ...VALID_SCENARIOS_CONFIG, updatedAt: inputTs });
  });

  it("throws when GOOGLE_APPLICATION_CREDENTIALS is not set", async () => {
    clearCredentials();
    await expect(gcsScenariosPut(VALID_SCENARIOS_CONFIG)).rejects.toThrow();
  });

  it("throws on GCS permission error (403)", async () => {
    setupCredentials();
    mockFetch("AccessDeniedException: 403", 403);
    await expect(gcsScenariosPut(VALID_SCENARIOS_CONFIG)).rejects.toThrow();
  });
});

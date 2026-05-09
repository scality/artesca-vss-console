import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── Module mocks (must be declared before any imports) ───────────────────────

// next-auth is hard to instantiate in a node test env; mock it so module-level
// NextAuth(...) doesn't try to touch Next.js internals.
vi.mock("next-auth", () => ({
  default: vi.fn(() => ({
    handlers: {},
    auth: vi.fn(),
    signIn: vi.fn(),
    signOut: vi.fn(),
  })),
}));
vi.mock("next-auth/providers/credentials", () => ({
  default: vi.fn((opts) => opts),
}));

// bcryptjs — swap compare with a controllable spy.
vi.mock("bcryptjs", () => ({
  default: {
    compare: vi.fn(),
    hash: vi.fn(),
  },
}));

// fs/promises — intercept readFile so we can simulate the docker-secret file.
vi.mock("fs/promises", () => ({
  default: {
    readFile: vi.fn(),
  },
}));

// ─── Imports (after mocks are set up) ────────────────────────────────────────

import bcrypt from "bcryptjs";
import fsProm from "fs/promises";
import { getPasswordHash, _authorize } from "@/lib/auth";

// ─── Typed mock helpers ───────────────────────────────────────────────────────

const bcryptCompare = vi.mocked(bcrypt.compare);
const fsReadFile    = vi.mocked(fsProm.readFile);

// ─── getPasswordHash — hash precedence ───────────────────────────────────────

describe("getPasswordHash — precedence", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    fsReadFile.mockReset();
  });

  it("returns the env hash (isHashed=true) when CONSOLE_PASSWORD_HASH is set", async () => {
    vi.stubEnv("CONSOLE_PASSWORD_HASH", "$2b$10$envhash");
    vi.stubEnv("CONSOLE_RUNTIME", "docker");       // should be ignored
    vi.stubEnv("CONSOLE_PASSWORD", "plaintext");   // should be ignored

    const result = await getPasswordHash();

    expect(result).toEqual({ hash: "$2b$10$envhash", isHashed: true });
    expect(fsReadFile).not.toHaveBeenCalled();
  });

  it("reads the docker-secret file when CONSOLE_RUNTIME=docker and no env hash", async () => {
    vi.stubEnv("CONSOLE_PASSWORD_HASH", "");
    vi.stubEnv("CONSOLE_RUNTIME", "docker");
    vi.stubEnv("CONSOLE_DATA_DIR", "/custom-data");

    fsReadFile.mockResolvedValueOnce("$2b$10$filehash\n" as never);

    const result = await getPasswordHash();

    expect(fsReadFile).toHaveBeenCalledWith(
      "/custom-data/.docker-secrets/console-auth-password",
      "utf-8",
    );
    expect(result).toEqual({ hash: "$2b$10$filehash", isHashed: true });
  });

  it("falls through to plain when docker-secret file is empty", async () => {
    vi.stubEnv("CONSOLE_PASSWORD_HASH", "");
    vi.stubEnv("CONSOLE_RUNTIME", "docker");
    vi.stubEnv("CONSOLE_PASSWORD", "mypassword");

    // readFile returns whitespace-only — trimmed to "" so we fall through
    fsReadFile.mockResolvedValueOnce("   \n" as never);

    const result = await getPasswordHash();

    expect(result).toEqual({ hash: "mypassword", isHashed: false });
  });

  it("returns plain CONSOLE_PASSWORD (isHashed=false) when no env hash and not docker mode", async () => {
    vi.stubEnv("CONSOLE_PASSWORD_HASH", "");
    vi.stubEnv("CONSOLE_RUNTIME", "");
    vi.stubEnv("CONSOLE_PASSWORD", "custompass");
    // Ensure no leftover docker-mode readFile call from a prior test
    fsReadFile.mockRejectedValueOnce(new Error("ENOENT") as never);

    const result = await getPasswordHash();

    expect(result).toEqual({ hash: "custompass", isHashed: false });
  });

  it('defaults to "scality" when CONSOLE_PASSWORD is not set and not docker mode', async () => {
    vi.stubEnv("CONSOLE_PASSWORD_HASH", "");
    vi.stubEnv("CONSOLE_RUNTIME", "");
    // Do not stub CONSOLE_PASSWORD — let it be absent so `??` kicks in.
    delete process.env.CONSOLE_PASSWORD;

    const result = await getPasswordHash();

    expect(result).toEqual({ hash: "scality", isHashed: false });
  });
});

// ─── _authorize — credentials authorize callback ──────────────────────────────

describe("_authorize — authorize logic", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    bcryptCompare.mockReset();
    fsReadFile.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns null when password is undefined", async () => {
    vi.stubEnv("CONSOLE_PASSWORD", "scality");
    const result = await _authorize(undefined);
    expect(result).toBeNull();
  });

  it("returns null when password is an empty string", async () => {
    vi.stubEnv("CONSOLE_PASSWORD", "scality");
    const result = await _authorize("");
    expect(result).toBeNull();
  });

  it("returns the user when bcrypt.compare succeeds (isHashed path)", async () => {
    vi.stubEnv("CONSOLE_PASSWORD_HASH", "$2b$10$hash");
    bcryptCompare.mockResolvedValueOnce(true as never);

    const result = await _authorize("mypassword");

    expect(bcryptCompare).toHaveBeenCalledWith("mypassword", "$2b$10$hash");
    expect(result).toMatchObject({ id: "1", name: "console-operator" });
  });

  it("returns null when bcrypt.compare fails (isHashed path)", async () => {
    vi.stubEnv("CONSOLE_PASSWORD_HASH", "$2b$10$hash");
    bcryptCompare.mockResolvedValueOnce(false as never);

    const result = await _authorize("wrongpassword");

    expect(result).toBeNull();
  });

  it("returns the user on correct plain-text password match", async () => {
    vi.stubEnv("CONSOLE_PASSWORD_HASH", "");
    vi.stubEnv("CONSOLE_RUNTIME", "");
    vi.stubEnv("CONSOLE_PASSWORD", "myplainpass");

    const result = await _authorize("myplainpass");

    expect(bcryptCompare).not.toHaveBeenCalled();
    expect(result).toMatchObject({ id: "1", name: "console-operator" });
  });

  it("returns null on plain-text password mismatch", async () => {
    vi.stubEnv("CONSOLE_PASSWORD_HASH", "");
    vi.stubEnv("CONSOLE_RUNTIME", "");
    vi.stubEnv("CONSOLE_PASSWORD", "myplainpass");

    const result = await _authorize("wrongpass");

    expect(result).toBeNull();
  });
});

// ─── auth bypass — CONSOLE_DISABLE_AUTH ──────────────────────────────────────
//
// These tests use vi.resetModules() + vi.doMock() + dynamic import so each test
// gets its own module evaluation with a fresh CONSOLE_DISABLE_AUTH value.
// vi.doMock() is NOT hoisted, so variables defined before the call are in scope.

describe("auth bypass — CONSOLE_DISABLE_AUTH", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  /** Shared doMock stubs — reused in each bypass test to satisfy auth.ts imports. */
  function stubAuthDeps(overrides: { authFn?: ReturnType<typeof vi.fn> } = {}) {
    const authFn = overrides.authFn ?? vi.fn();
    vi.doMock("next-auth", () => ({
      default: vi.fn(() => ({
        handlers: {},
        auth: authFn,
        signIn: vi.fn(),
        signOut: vi.fn(),
      })),
    }));
    vi.doMock("next-auth/providers/credentials", () => ({
      default: vi.fn((opts: unknown) => opts),
    }));
    vi.doMock("bcryptjs", () => ({ default: { compare: vi.fn(), hash: vi.fn() } }));
    vi.doMock("fs/promises", () => ({ default: { readFile: vi.fn() } }));
    return { authFn };
  }

  it('auth() resolves to BYPASS_SESSION when CONSOLE_DISABLE_AUTH="true"', async () => {
    vi.stubEnv("CONSOLE_DISABLE_AUTH", "true");
    stubAuthDeps();

    const { auth } = await import("@/lib/auth");
    const session = await (auth as () => Promise<unknown>)();

    expect(session).toMatchObject({
      user: { id: "1", name: "console-operator", email: "console@local" },
      expires: "2099-01-01T00:00:00.000Z",
    });
  });

  it('auth(handler) injects req.auth and calls handler when CONSOLE_DISABLE_AUTH="true"', async () => {
    vi.stubEnv("CONSOLE_DISABLE_AUTH", "true");
    stubAuthDeps();

    const { auth } = await import("@/lib/auth");

    const handler = vi.fn((_req: unknown) => "handler-return");

    // auth(handler) must return a wrapping function
    const wrapper = (auth as unknown as (h: unknown) => (req: unknown) => unknown)(handler);
    expect(typeof wrapper).toBe("function");

    const fakeReq = {} as Request;
    await wrapper(fakeReq);

    expect(handler).toHaveBeenCalledOnce();
    expect((fakeReq as unknown as Record<string, unknown>).auth).toMatchObject({
      user: { id: "1", name: "console-operator" },
    });
  });

  it("auth is the real next-auth instance when CONSOLE_DISABLE_AUTH is not 'true'", async () => {
    vi.stubEnv("CONSOLE_DISABLE_AUTH", "");

    const fakeNextAuthInstance = vi.fn();
    stubAuthDeps({ authFn: fakeNextAuthInstance });

    const { auth } = await import("@/lib/auth");

    // When bypass is inactive, auth must be the exact function next-auth returned.
    expect(auth).toBe(fakeNextAuthInstance);
  });
});

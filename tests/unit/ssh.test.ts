/**
 * Unit tests for src/lib/ssh.ts
 *
 * The module wraps ssh2's Client for camera-sim SSH.  Because ssh2 opens
 * real network connections and fs.readFileSync reads a key PEM from disk,
 * both are mocked at the top level before the module is imported.
 *
 * Isolation concern: ssh.ts holds module-level singletons (cachedKey,
 * hostKeyWarnEmitted).  Tests that need a fresh module use vi.resetModules()
 * + dynamic import(); the main suites use the statically-imported exports.
 *
 * IMPORTANT: We use vi.clearAllMocks() (not vi.resetAllMocks/restoreAllMocks)
 * in beforeEach.  restoreAllMocks() destroys vi.fn().mockImplementation() on
 * module-level mocks, which breaks the Client constructor mock from test 2
 * onward.  clearAllMocks() only zeroes call counts and results — safe.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";

// ─── Hoisted mocks ────────────────────────────────────────────────────────────
//
// vi.mock() factories are hoisted BEFORE module initialisation, so any module-
// level constants we want to reference inside the factory must be created with
// vi.hoisted().

const { mockClientInstances, ClientMock, readFileSyncMock } = vi.hoisted(() => {
  const { EventEmitter: EE } = require("node:events") as typeof import("node:events");

  const mockClientInstances: MockClientCls[] = [];

  // MockClient MUST extend EventEmitter so conn.on/emit work in ssh.ts.
  // The ssh2 API methods are plain vi.fn()s assigned per-instance.
  class MockClientCls extends EE {
    exec = vi.fn();
    sftp = vi.fn();
    end = vi.fn();
    connect = vi.fn();
  }

  function makeMockClient(): MockClientCls {
    const c = new MockClientCls();
    mockClientInstances.push(c);
    return c;
  }

  const ClientMock = vi.fn().mockImplementation(function () { return makeMockClient(); });
  const readFileSyncMock = vi.fn(() => Buffer.from("FAKE_PRIVATE_KEY"));

  return { mockClientInstances, ClientMock, readFileSyncMock };
});

// Export the type so TypeScript can infer MockClient in tests.
type MockClient = (typeof mockClientInstances)[number];

vi.mock("ssh2", () => ({ Client: ClientMock }));

vi.mock("fs", async () => {
  const real = await vi.importActual<typeof import("fs")>("fs");
  return { ...real, readFileSync: readFileSyncMock };
});

vi.mock("@/lib/db", () => ({
  appendAuditLog: vi.fn().mockResolvedValue(undefined),
}));

// server-only is stubbed by tests/setup.ts.

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Settle the microtask queue between emitting EventEmitter events and
 *  asserting on the Promise that consumes them. */
async function tick(): Promise<void> {
  await new Promise<void>((r) => setImmediate(r));
}

/** Build an EventEmitter that looks like an ssh2 ClientChannel.
 *  It has a .stderr sub-emitter to mirror the real stream shape. */
function makeStream(): EventEmitter & { stderr: EventEmitter } {
  const s = new EventEmitter() as EventEmitter & { stderr: EventEmitter };
  s.stderr = new EventEmitter();
  return s;
}

/** Build an EventEmitter that looks like an ssh2 SFTPWrapper WriteStream. */
function makeWriteStream(): EventEmitter & { end: ReturnType<typeof vi.fn> } {
  const ws = new EventEmitter() as EventEmitter & {
    end: ReturnType<typeof vi.fn>;
  };
  ws.end = vi.fn();
  return ws;
}

function lastClient(): MockClient {
  return mockClientInstances[mockClientInstances.length - 1];
}

// ─── Static imports ───────────────────────────────────────────────────────────

import { sshExec, sshScp } from "@/lib/ssh";
import { appendAuditLog } from "@/lib/db";

// ─── Lifecycle ────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let stderrSpy: any;

beforeEach(() => {
  // Clear instance tracking so lastClient() returns the one from this test.
  mockClientInstances.length = 0;
  // clearAllMocks() zeroes call counts/results without destroying implementations.
  // Do NOT use resetAllMocks() or restoreAllMocks() here — they destroy the
  // ClientMock.mockImplementation() set in vi.hoisted(), breaking tests 2+.
  vi.clearAllMocks();
  // Restore return values explicitly after clearAllMocks.
  readFileSyncMock.mockReturnValue(Buffer.from("FAKE_PRIVATE_KEY"));
  (appendAuditLog as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
  // Suppress incidental structured log output from ssh.ts. Track the spy so we
  // can restore it in afterEach without calling vi.restoreAllMocks().
  stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  vi.stubEnv("LOG_PRETTY", "0");
  // Default SSH env vars.
  vi.stubEnv("CAMERA_SIM_HOST", "1.2.3.4");
  vi.stubEnv("CAMERA_SIM_SSH_USER", "ubuntu");
  vi.stubEnv("CAMERA_SIM_SSH_KEY_PATH", "/fake/key.pem");
  delete process.env.CAMERA_SIM_HOST_PUBKEY_SHA256;
});

afterEach(() => {
  // Restore only the spies we installed — NOT vi.restoreAllMocks() which
  // would wipe out ClientMock.mockImplementation().
  stderrSpy.mockRestore();
  vi.unstubAllEnvs();
  delete process.env.CAMERA_SIM_HOST_PUBKEY_SHA256;
});

// ─── sshExec ─────────────────────────────────────────────────────────────────

describe("sshExec", () => {
  it("happy path: connect called with correct config; command runs; resolves with {stdout, stderr, code}", async () => {
    const resultPromise = sshExec("echo hello");
    await tick();

    const client = lastClient();
    expect(client.connect).toHaveBeenCalledOnce();

    const connectArg = client.connect.mock.calls[0][0] as {
      host: string;
      username: string;
      privateKey: Buffer;
      readyTimeout: number;
    };
    expect(connectArg.host).toBe("1.2.3.4");
    expect(connectArg.username).toBe("ubuntu");
    expect(Buffer.isBuffer(connectArg.privateKey)).toBe(true);
    expect(connectArg.privateKey.toString()).toBe("FAKE_PRIVATE_KEY");
    expect(connectArg.readyTimeout).toBe(10_000);

    // Fire 'ready' — the conn.on("ready") handler calls conn.exec().
    client.emit("ready");
    await tick();

    expect(client.exec).toHaveBeenCalledOnce();
    expect(client.exec.mock.calls[0][0]).toBe("echo hello");

    // Drive the stream returned by the exec callback.
    const stream = makeStream();
    const execCb = client.exec.mock.calls[0][1] as (
      err: Error | null,
      s: typeof stream,
    ) => void;
    execCb(null, stream);
    await tick();

    stream.emit("data", Buffer.from("hello\n"));
    stream.stderr.emit("data", Buffer.from("warn text\n"));
    stream.emit("close", 0);
    await tick();

    const result = await resultPromise;
    expect(result).toEqual({
      stdout: "hello\n",
      stderr: "warn text\n",
      code: 0,
    });
    expect(client.end).toHaveBeenCalledOnce();
  });

  it("exec channel error: callback called with Error → promise rejects and client.end() called", async () => {
    const resultPromise = sshExec("bad-cmd");
    // Attach a noop catch immediately so Node/Vitest doesn't flag this as an
    // "unhandled rejection" before we assert on it below.
    resultPromise.catch(() => void 0);
    await tick();

    const client = lastClient();
    client.emit("ready");
    await tick();

    const execError = new Error("exec channel error");
    const execCb = client.exec.mock.calls[0][1] as (
      err: Error | null,
      s: unknown,
    ) => void;
    execCb(execError, undefined as unknown as EventEmitter);
    await tick();

    await expect(resultPromise).rejects.toThrow("exec channel error");
    expect(client.end).toHaveBeenCalledOnce();
  });

  it("connection error: 'error' event before 'ready' → promise rejects", async () => {
    const resultPromise = sshExec("ls");
    resultPromise.catch(() => void 0);
    await tick();

    const client = lastClient();
    client.emit("error", new Error("ECONNREFUSED"));
    await tick();

    await expect(resultPromise).rejects.toThrow("ECONNREFUSED");
  });

  it("key cache: calling sshExec twice triggers fs.readFileSync only once total", async () => {
    // ssh.ts caches the private key at module scope.  After the first read,
    // subsequent calls to getConnectConfig() must skip readFileSync.
    // The key may already be cached by an earlier test in the suite, so we
    // measure delta reads rather than asserting an absolute count.
    const callsBefore = readFileSyncMock.mock.calls.length;

    // First invocation in this test.
    const p1 = sshExec("cmd1");
    await tick();
    const c1 = lastClient();
    c1.emit("ready");
    await tick();
    const s1 = makeStream();
    (c1.exec.mock.calls[0][1] as (e: null, s: typeof s1) => void)(null, s1);
    s1.emit("close", 0);
    await tick();
    await p1;
    const callsAfterFirst = readFileSyncMock.mock.calls.length;

    // Second invocation — cachedKey is now set, so zero new reads.
    const p2 = sshExec("cmd2");
    await tick();
    const c2 = lastClient();
    c2.emit("ready");
    await tick();
    const s2 = makeStream();
    (c2.exec.mock.calls[0][1] as (e: null, s: typeof s2) => void)(null, s2);
    s2.emit("close", 0);
    await tick();
    await p2;
    const callsAfterSecond = readFileSyncMock.mock.calls.length;

    const readsForFirstCall = callsAfterFirst - callsBefore;
    const readsForSecondCall = callsAfterSecond - callsAfterFirst;

    // At most one read for the first call (cold or already warm cache).
    expect(readsForFirstCall).toBeLessThanOrEqual(1);
    // The second call must never read the file again.
    expect(readsForSecondCall).toBe(0);
  });
});

// ─── sshScp ──────────────────────────────────────────────────────────────────

describe("sshScp", () => {
  it("happy path: connects, opens sftp, writes buffer, calls client.end, resolves, audit-logs", async () => {
    const buf = Buffer.from("camera-config-data");
    const remotePath = "/tmp/cameras.json";
    const operator = "alice";

    const scpPromise = sshScp(buf, remotePath, operator);
    // sshScp awaits appendAuditLog before entering the Promise constructor, so
    // we need a couple of ticks to let the await + promise-constructor settle.
    await tick();
    await tick();

    // Audit log must be written with the correct fields.
    expect(appendAuditLog).toHaveBeenCalledOnce();
    const auditArg = (appendAuditLog as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as {
      operator: string;
      action: string;
      target: string;
      detailsJson: string;
    };
    expect(auditArg.operator).toBe(operator);
    expect(auditArg.action).toBe("scp-write");
    expect(auditArg.target).toBe(remotePath);
    const details = JSON.parse(auditArg.detailsJson) as { bytes: number };
    expect(details.bytes).toBe(buf.length);

    const client = lastClient();
    expect(client.connect).toHaveBeenCalledOnce();

    client.emit("ready");
    await tick();

    expect(client.sftp).toHaveBeenCalledOnce();

    // Provide the sftp object via the callback.
    const writeStream = makeWriteStream();
    writeStream.end.mockImplementation((_chunk: Buffer) => {
      // Simulate async finish.
      setImmediate(() => writeStream.emit("finish"));
    });
    const fakeSftp = {
      createWriteStream: vi.fn().mockReturnValue(writeStream),
    };
    const sftpCb = client.sftp.mock.calls[0][0] as (
      err: Error | null,
      sftp: typeof fakeSftp,
    ) => void;
    sftpCb(null, fakeSftp);
    await tick();

    expect(fakeSftp.createWriteStream).toHaveBeenCalledWith(remotePath);
    expect(writeStream.end).toHaveBeenCalledWith(buf);

    await tick();
    await tick();

    await scpPromise;
    expect(client.end).toHaveBeenCalledOnce();
  });

  it("sftp error: sftp callback returns Error → promise rejects, client.end() called", async () => {
    const scpPromise = sshScp(Buffer.from("data"), "/tmp/x", "bob");
    scpPromise.catch(() => void 0);
    await tick();
    await tick();

    const client = lastClient();
    client.emit("ready");
    await tick();

    const sftpCb = client.sftp.mock.calls[0][0] as (
      err: Error | null,
      sftp: unknown,
    ) => void;
    sftpCb(new Error("sftp subsystem unavailable"), undefined as unknown as object);
    await tick();

    await expect(scpPromise).rejects.toThrow("sftp subsystem unavailable");
    expect(client.end).toHaveBeenCalledOnce();
  });

  it("writeStream error: 'error' event → promise rejects, client.end() called", async () => {
    const scpPromise = sshScp(Buffer.from("payload"), "/tmp/y", "charlie");
    scpPromise.catch(() => void 0);
    await tick();
    await tick();

    const client = lastClient();
    client.emit("ready");
    await tick();

    const writeStream = makeWriteStream();
    const fakeSftp = { createWriteStream: vi.fn().mockReturnValue(writeStream) };
    const sftpCb = client.sftp.mock.calls[0][0] as (
      err: Error | null,
      sftp: typeof fakeSftp,
    ) => void;
    sftpCb(null, fakeSftp);
    await tick();

    writeStream.emit("error", new Error("ENOSPC: no space left on device"));
    await tick();

    await expect(scpPromise).rejects.toThrow("ENOSPC");
    expect(client.end).toHaveBeenCalledOnce();
  });
});

// ─── hostVerifier ────────────────────────────────────────────────────────────
//
// hostVerifier behaviour depends on CAMERA_SIM_HOST_PUBKEY_SHA256 at module-
// load time.  Because ssh.ts caches module-level state (cachedKey,
// hostKeyWarnEmitted), we use vi.resetModules() + dynamic import() to get a
// fresh module instance isolated from the rest of the suite.

describe("hostVerifier", () => {
  it("when env is set, connect config includes hostVerifier; correct hash → true, wrong hash → false", async () => {
    const { createHash } = await import("crypto");
    const keyBuf = Buffer.from("TEST_HOST_KEY_BYTES");
    const correctHex = createHash("sha256").update(keyBuf).digest("hex");

    process.env.CAMERA_SIM_HOST_PUBKEY_SHA256 = correctHex;

    vi.resetModules();

    // After resetModules, re-apply all mocks for the freshly resolved module graph.
    // We reuse the hoisted ClientMock + readFileSyncMock so the same instances
    // array is populated.
    vi.doMock("ssh2", () => ({ Client: ClientMock }));
    vi.doMock("fs", async () => {
      const real = await vi.importActual<typeof import("fs")>("fs");
      return { ...real, readFileSync: readFileSyncMock };
    });
    vi.doMock("@/lib/db", () => ({
      appendAuditLog: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock("server-only", () => ({}));

    readFileSyncMock.mockReturnValue(Buffer.from("FAKE_PRIVATE_KEY"));

    const { sshExec: freshSshExec } = await import("@/lib/ssh");

    // Trigger connect() so we can inspect the ConnectConfig.
    const p = freshSshExec("whoami");
    // Attach a noop catch so the cleanup error below isn't flagged as unhandled.
    p.catch(() => void 0);
    await tick();

    const client = lastClient();
    const cfg = client.connect.mock.calls[0][0] as {
      hostVerifier?: (key: Buffer) => boolean;
    };

    expect(typeof cfg.hostVerifier).toBe("function");

    // Correct key → true.
    expect(cfg.hostVerifier!(keyBuf)).toBe(true);
    // Wrong key → false.
    expect(cfg.hostVerifier!(Buffer.from("WRONG_KEY"))).toBe(false);

    // Comparison is case-insensitive: uppercase env value must still match.
    process.env.CAMERA_SIM_HOST_PUBKEY_SHA256 = correctHex.toUpperCase();
    expect(cfg.hostVerifier!(keyBuf)).toBe(true);

    // Clean up the dangling promise by injecting an error.
    client.emit("error", new Error("abort-test-cleanup"));
    await tick();
    await p.catch(() => void 0);
  });

  it("when env is unset, connect config has NO hostVerifier and warn log fires exactly once", async () => {
    delete process.env.CAMERA_SIM_HOST_PUBKEY_SHA256;

    // Spy must be installed BEFORE the fresh module is imported, because
    // getConnectConfig() fires the warn on the first connect() call.
    const freshStderrWrites: string[] = [];
    const freshStderrSpy = vi
      .spyOn(console, "error")
      .mockImplementation((...args: unknown[]) => { freshStderrWrites.push(String(args[0])); });

    vi.resetModules();
    vi.doMock("ssh2", () => ({ Client: ClientMock }));
    vi.doMock("fs", async () => {
      const real = await vi.importActual<typeof import("fs")>("fs");
      return { ...real, readFileSync: readFileSyncMock };
    });
    vi.doMock("@/lib/db", () => ({
      appendAuditLog: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock("server-only", () => ({}));

    readFileSyncMock.mockReturnValue(Buffer.from("FAKE_PRIVATE_KEY"));

    const { sshExec: freshSshExec } = await import("@/lib/ssh");

    // First call — getConnectConfig() emits the warn.
    const p1 = freshSshExec("cmd1");
    // Attach noop catches immediately so cleanup errors aren't flagged as unhandled.
    p1.catch(() => void 0);
    await tick();
    const c1 = lastClient();
    const cfg1 = c1.connect.mock.calls[0][0] as { hostVerifier?: unknown };
    expect(cfg1.hostVerifier).toBeUndefined();

    // Second call — hostKeyWarnEmitted is now true; warn must NOT fire again.
    const p2 = freshSshExec("cmd2");
    p2.catch(() => void 0);
    await tick();

    const warnRecords = freshStderrWrites.map((s) => JSON.parse(s));
    const sshWarns = warnRecords.filter((r) => r.level === "warn" && r.scope === "ssh");
    expect(sshWarns).toHaveLength(1);
    expect(sshWarns[0].msg).toContain("CAMERA_SIM_HOST_PUBKEY_SHA256");

    // Clean up dangling promises.
    c1.emit("error", new Error("abort-test-cleanup"));
    const c2 = lastClient();
    c2.emit("error", new Error("abort-test-cleanup"));
    await tick();
    await p1.catch(() => void 0);
    await p2.catch(() => void 0);
    freshStderrSpy.mockRestore();
  });
});

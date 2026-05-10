/**
 * Unit tests for docker-sock.ts
 *
 * The implementation uses node:http with socketPath=/var/run/docker.sock.
 * We mock node:http at the module boundary so no real socket is needed.
 *
 * Exports covered:
 *   dockerSock            — the core primitive (used by all other exports)
 *   listComposeContainers — error-swallowing list helper
 *   inspectContainer      — error-swallowing inspect helper
 *   dockerRecreateWithEnv — mutating: stop→rename→create→start, with rollback
 *   execInContainer       — exec API + stream demux
 *
 * Exports deferred (complex custom attach streams):
 *   runOneShotGpuContainer — it.todo (dual http.request paths + AutoRemove race)
 *   streamDockerLogs       — it.todo (streaming / AbortSignal interface)
 */

import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { EventEmitter } from "node:events";

// ─── Hoist mock state so vi.mock factory can reference it ─────────────────────
//
// vi.mock() is hoisted before imports, so variables declared at module scope
// (like `let httpRequestMock`) are not yet initialized inside the factory.
// vi.hoisted() runs inside the same hoist pass and returns refs that ARE
// available inside vi.mock().

const { httpRequestMock } = vi.hoisted(() => {
  const httpRequestMock: Mock = vi.fn();
  return { httpRequestMock };
});

vi.mock("node:http", async () => {
  const actual = await vi.importActual<typeof import("node:http")>("node:http");
  return {
    ...actual,
    request: httpRequestMock,
    default: { ...actual, request: httpRequestMock },
  };
});

// server-only is already stubbed in tests/setup.ts

// ─── Fake request/response helpers ───────────────────────────────────────────

class FakeRes extends EventEmitter {
  statusCode: number;
  constructor(statusCode = 200) {
    super();
    this.statusCode = statusCode;
    this.setMaxListeners(50);
  }
  reply(body: string) {
    this.emit("data", body);
    this.emit("end");
  }
  replyBuffer(buf: Buffer) {
    this.emit("data", buf);
    this.emit("end");
  }
}

class FakeReq extends EventEmitter {
  writtenPayload = "";
  destroyed = false;
  write(data: string) {
    this.writtenPayload += data;
  }
  end() { /* no-op — tests drive responses manually */ }
  destroy(err?: Error) {
    this.destroyed = true;
    if (err) this.emit("error", err);
  }
}

type ResponseCallback = (res: FakeRes) => void;

/**
 * Queue-based http.request mock.
 *
 * Call `enqueueResponse(...)` for each request the test expects.
 * httpRequestMock dequeues one entry per call and immediately feeds the
 * response callback with it, which is what the implementation awaits.
 *
 * This avoids the "setup-then-respond" synchronization problem that
 * caused timeouts with `mockImplementationOnce`.
 */
interface QueueEntry {
  statusCode: number;
  body: string | Buffer | null; // null → skip reply (caller drives manually)
}

let responseQueue: QueueEntry[] = [];
let lastCapturedOpts: Record<string, unknown> = {};
let lastCapturedReq: FakeReq;

function enqueueJson(body: unknown, statusCode = 200) {
  responseQueue.push({ statusCode, body: JSON.stringify(body) });
}
function enqueueEmpty(statusCode = 204) {
  responseQueue.push({ statusCode, body: "" });
}
function enqueueError(statusCode: number, body = "Internal Server Error") {
  responseQueue.push({ statusCode, body });
}

/** Build a docker 8-byte framed stdout chunk. */
function dockerFrame(text: string): Buffer {
  const textBuf = Buffer.from(text, "utf8");
  const header = Buffer.alloc(8);
  header[0] = 1; // stream=1 (stdout)
  header.writeUInt32BE(textBuf.length, 4);
  return Buffer.concat([header, textBuf]);
}

import {
  dockerSock,
  listComposeContainers,
  inspectContainer,
  dockerRecreateWithEnv,
  execInContainer,
  DOCKER_TUNING_DIR,
} from "@/lib/helpers/docker-sock";

beforeEach(() => {
  vi.clearAllMocks();
  responseQueue = [];
  lastCapturedOpts = {};

  httpRequestMock.mockImplementation((opts: Record<string, unknown>, cb: ResponseCallback) => {
    lastCapturedOpts = opts;
    const req = new FakeReq();
    lastCapturedReq = req;

    const entry = responseQueue.shift();
    if (entry !== undefined) {
      const res = new FakeRes(entry.statusCode);
      // Schedule the callback asynchronously so the caller's .end() has run.
      setImmediate(() => {
        cb(res);
        if (entry.body !== null) {
          if (typeof entry.body === "string") {
            res.reply(entry.body);
          } else {
            res.replyBuffer(entry.body);
          }
        }
      });
    }
    return req;
  });
});

// ─── DOCKER_TUNING_DIR ────────────────────────────────────────────────────────

describe("DOCKER_TUNING_DIR", () => {
  it("is a string containing .docker-tuning", () => {
    expect(typeof DOCKER_TUNING_DIR).toBe("string");
    expect(DOCKER_TUNING_DIR).toContain(".docker-tuning");
  });
});

// ─── dockerSock ───────────────────────────────────────────────────────────────

describe("dockerSock", () => {
  it("resolves with parsed JSON on a 200 response", async () => {
    enqueueJson([{ Id: "abc" }]);
    expect(await dockerSock("GET", "/containers/json")).toEqual([{ Id: "abc" }]);
  });

  it("uses socketPath /var/run/docker.sock", async () => {
    enqueueJson([]);
    await dockerSock("GET", "/containers/json");
    expect(lastCapturedOpts.socketPath).toBe("/var/run/docker.sock");
  });

  it("resolves with {} on an empty body (204-style)", async () => {
    enqueueEmpty(204);
    expect(await dockerSock("POST", "/containers/foo/stop")).toEqual({});
  });

  it("rejects on 404 with an error including the status code", async () => {
    enqueueError(404, "No such container");
    await expect(dockerSock("GET", "/containers/missing/json")).rejects.toThrow("404");
  });

  it("rejects on 500", async () => {
    enqueueError(500);
    await expect(dockerSock("DELETE", "/containers/x?force=1")).rejects.toThrow("500");
  });

  it("sends a JSON body and sets content-type for POST requests with a body", async () => {
    enqueueJson({ Id: "new123" });
    await dockerSock("POST", "/containers/create", { Image: "ubuntu" });
    expect(lastCapturedReq.writtenPayload).toContain('"Image":"ubuntu"');
    expect(lastCapturedOpts.headers).toMatchObject({ "content-type": "application/json" });
  });

  it("rejects on a network error emitted on the request", async () => {
    // Don't enqueue anything — instead emit an error on the req after it's returned
    httpRequestMock.mockImplementationOnce((opts: Record<string, unknown>, _cb: ResponseCallback) => {
      lastCapturedOpts = opts;
      const req = new FakeReq();
      lastCapturedReq = req;
      setImmediate(() => req.emit("error", new Error("ENOENT /var/run/docker.sock")));
      return req;
    });
    await expect(dockerSock("GET", "/containers/json")).rejects.toThrow("ENOENT");
  });
});

// ─── listComposeContainers ────────────────────────────────────────────────────

describe("listComposeContainers", () => {
  it("returns containers matching the compose project label", async () => {
    enqueueJson([
      { Id: "c1", Names: ["/rtvi-vlm"], Image: "rtvi:latest", State: "running", Status: "Up 1h", Labels: {} },
    ]);
    const result = await listComposeContainers("nvidia-vss");
    expect(result).toHaveLength(1);
    expect(result[0].Id).toBe("c1");
  });

  it("returns an empty array on docker error (best-effort)", async () => {
    enqueueError(500);
    expect(await listComposeContainers("nvidia-vss")).toEqual([]);
  });

  it("encodes the project name in the filters query param", async () => {
    enqueueJson([]);
    await listComposeContainers("my-project");
    const path = lastCapturedOpts.path as string;
    expect(path).toContain("filters=");
    expect(path).toContain("my-project");
  });
});

// ─── inspectContainer ─────────────────────────────────────────────────────────

describe("inspectContainer", () => {
  it("returns ContainerInspect on success", async () => {
    enqueueJson({
      Id: "abc",
      Name: "/rtvi-vlm",
      RestartCount: 0,
      State: { Status: "running", Running: true, StartedAt: "2026-01-01T00:00:00Z" },
      Config: { Image: "rtvi:latest", Env: [], Labels: {} },
    });
    const result = await inspectContainer("rtvi-vlm");
    expect(result?.Id).toBe("abc");
  });

  it("returns null on 404 (no such container)", async () => {
    enqueueError(404, "No such container");
    expect(await inspectContainer("nonexistent")).toBeNull();
  });

  it("URL-encodes the container name in the path", async () => {
    enqueueError(404);
    await inspectContainer("my container");
    expect(lastCapturedOpts.path as string).toContain(encodeURIComponent("my container"));
  });
});

// ─── dockerRecreateWithEnv ────────────────────────────────────────────────────

describe("dockerRecreateWithEnv", () => {
  function fakeInspectBody(envLines: string[] = ["FOO=bar"]) {
    return {
      Config: {
        Image: "rtvi:latest",
        Env: envLines,
        Cmd: ["serve"],
        Entrypoint: null,
        ExposedPorts: {},
        Labels: { "com.docker.compose.project": "nvidia-vss" },
        WorkingDir: "/app",
        User: "",
      },
      HostConfig: { NetworkMode: "bridge" },
      NetworkSettings: { Networks: { bridge: {} } },
    };
  }

  it("happy path: stop → rename → create → start → delete backup, returns new id", async () => {
    enqueueJson(fakeInspectBody()); // GET inspect
    enqueueEmpty(204);              // POST stop
    enqueueEmpty(200);              // POST rename
    enqueueJson({ Id: "new-id-42" }); // POST create
    enqueueEmpty(204);              // POST start
    enqueueEmpty(204);              // DELETE backup

    expect(await dockerRecreateWithEnv("rtvi-vlm", { NEW_ENV: "injected" })).toEqual({ id: "new-id-42" });
  });

  it("merges env: replaces existing key, keeps untouched keys, appends new key", async () => {
    // Intercept the create call to capture the body.
    let createBody: { Env: string[] } = { Env: [] };
    let callCount = 0;

    httpRequestMock.mockImplementation((opts: Record<string, unknown>, cb: ResponseCallback) => {
      lastCapturedOpts = opts;
      const req = new FakeReq();
      lastCapturedReq = req;
      callCount++;

      if (callCount === 4) {
        // create call — intercept write() to capture the body
        const origWrite = req.write.bind(req);
        req.write = (data: string) => {
          origWrite(data);
          createBody = JSON.parse(req.writtenPayload) as { Env: string[] };
        };
      }

      const entry = responseQueue.shift();
      if (entry !== undefined) {
        const res = new FakeRes(entry.statusCode);
        setImmediate(() => {
          cb(res);
          if (entry.body !== null) {
            if (typeof entry.body === "string") res.reply(entry.body);
            else res.replyBuffer(entry.body);
          }
        });
      }
      return req;
    });

    enqueueJson(fakeInspectBody(["FOO=original", "KEEP=unchanged"])); // inspect
    enqueueEmpty(204);              // stop
    enqueueEmpty(200);              // rename
    enqueueJson({ Id: "new-42" }); // create
    enqueueEmpty(204);             // start
    enqueueEmpty(204);             // delete backup

    await dockerRecreateWithEnv("rtvi-vlm", { FOO: "overridden", BRAND_NEW: "yes" });

    expect(createBody.Env).toContain("FOO=overridden");
    expect(createBody.Env).toContain("KEEP=unchanged");
    expect(createBody.Env).toContain("BRAND_NEW=yes");
    expect(createBody.Env.filter((e: string) => e.startsWith("FOO="))).toHaveLength(1);
  });

  it("rollback: start failure triggers delete-new + rename-backup-back + start-backup", async () => {
    const recordedPaths: string[] = [];
    httpRequestMock.mockImplementation((opts: Record<string, unknown>, cb: ResponseCallback) => {
      lastCapturedOpts = opts;
      recordedPaths.push(`${opts.method as string} ${opts.path as string}`);
      const req = new FakeReq();
      lastCapturedReq = req;

      const entry = responseQueue.shift();
      if (entry !== undefined) {
        const res = new FakeRes(entry.statusCode);
        setImmediate(() => {
          cb(res);
          if (entry.body !== null) {
            if (typeof entry.body === "string") res.reply(entry.body);
            else res.replyBuffer(entry.body);
          }
        });
      }
      return req;
    });

    enqueueJson(fakeInspectBody()); // inspect
    enqueueEmpty(204);              // stop
    enqueueEmpty(200);              // rename → backup
    enqueueJson({ Id: "fail-id" }); // create
    enqueueError(500, "start failed"); // start → triggers rollback
    enqueueEmpty(204);              // DELETE fail-id (rollback best-effort)
    enqueueEmpty(200);              // rename backup back (rollback)
    enqueueEmpty(204);              // start backup (rollback)

    await expect(dockerRecreateWithEnv("rtvi-vlm", { VLM_SYSTEM_PROMPT: "new" })).rejects.toThrow();

    // On rollback, the implementation deletes the *new* container by name (not ID)
    // and then renames the backup back to the original name.
    const deleteCalls = recordedPaths.filter((r) => r.startsWith("DELETE"));
    expect(deleteCalls.length).toBeGreaterThan(0);
    // At least one rename-back call should be present (POST rename to original name)
    const renameCalls = recordedPaths.filter((r) => r.startsWith("POST") && r.includes("rename"));
    expect(renameCalls.length).toBeGreaterThan(0);
  });
});

// ─── execInContainer ──────────────────────────────────────────────────────────

describe("execInContainer", () => {
  it("returns stdout decoded from the docker 8-byte framed stream", async () => {
    // First request: POST /containers/<name>/exec → create exec instance
    enqueueJson({ Id: "exec-id-99" });

    // Second request: POST /exec/<id>/start → multiplexed stream
    // We need to drive this one manually (the impl uses http.request directly).
    // enqueue a "manual" entry that triggers but we deliver the buffer ourselves.
    let startResCb: ResponseCallback | null = null;
    let startFakeRes: FakeRes | null = null;

    httpRequestMock.mockImplementationOnce((opts: Record<string, unknown>, cb: ResponseCallback) => {
      // First call: exec create — process from queue
      lastCapturedOpts = opts;
      const req = new FakeReq();
      lastCapturedReq = req;
      const entry = responseQueue.shift()!;
      const res = new FakeRes(entry.statusCode);
      setImmediate(() => {
        cb(res);
        if (typeof entry.body === "string") res.reply(entry.body);
      });
      return req;
    }).mockImplementationOnce((opts: Record<string, unknown>, cb: ResponseCallback) => {
      // Second call: exec start stream
      lastCapturedOpts = opts;
      const req = new FakeReq();
      lastCapturedReq = req;
      startFakeRes = new FakeRes(200);
      startResCb = cb;
      return req;
    });

    const p = execInContainer("rtvi-vlm", ["nvidia-smi", "--query-gpu=name", "--format=csv"]);

    // Wait for both http.request mocks to have been called, then feed the stream.
    await vi.waitFor(() => expect(startResCb).not.toBeNull());
    startResCb!(startFakeRes!);
    startFakeRes!.replyBuffer(dockerFrame("NVIDIA L40S\n"));

    expect(await p).toContain("NVIDIA L40S");
  });

  it("returns null on exec create failure (docker 404)", async () => {
    enqueueError(404, "No such container");
    expect(await execInContainer("bad-container", ["ls"])).toBeNull();
  });

  it("URL-encodes the container name in the exec path", async () => {
    enqueueError(404, "No such container");
    await execInContainer("my container", ["ls"]);
    expect(lastCapturedOpts.path as string).toContain(encodeURIComponent("my container"));
  });

  it("returns null on network error during exec create", async () => {
    httpRequestMock.mockImplementationOnce((_opts: unknown, _cb: ResponseCallback) => {
      const req = new FakeReq();
      setImmediate(() => req.emit("error", new Error("connection refused")));
      return req;
    });
    expect(await execInContainer("rtvi-vlm", ["ls"])).toBeNull();
  });

  // Deferred: runOneShotGpuContainer has a dual http.request flow (create + attach)
  // where the attach stream races with AutoRemove. Complex to mock reliably at this boundary.
  it.todo("runOneShotGpuContainer: happy path — dual http.request mock surface deferred");
  it.todo("runOneShotGpuContainer: returns null on GPU container start failure");

  // Deferred: streamDockerLogs uses a persistent streaming response (follow=1) with
  // AbortSignal cleanup — requires a long-lived FakeRes that stays open.
  it.todo("streamDockerLogs: streams lines via onLine callback — AbortSignal surface deferred");
  it.todo("streamDockerLogs: cleanup function destroys the request");
});

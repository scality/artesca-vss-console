import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

describe("logger", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let stdoutSpy: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let stderrSpy: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let warnSpy: any;
  let writes: { stream: "out" | "err"; chunk: string }[];

  beforeEach(() => {
    writes = [];
    vi.resetModules();
    stdoutSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      writes.push({ stream: "out", chunk: String(args[0]) + "\n" });
    });
    stderrSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      writes.push({ stream: "err", chunk: String(args[0]) + "\n" });
    });
    warnSpy = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      writes.push({ stream: "err", chunk: String(args[0]) + "\n" });
    });
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    warnSpy.mockRestore();
    vi.unstubAllEnvs();
  });

  describe("default level", () => {
    it("writes info to stdout in production", async () => {
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("LOG_PRETTY", "0");
      const { log } = await import("@/lib/logger");
      log.info("hello", { a: 1 });
      expect(writes).toHaveLength(1);
      expect(writes[0].stream).toBe("out");
      const rec = JSON.parse(writes[0].chunk);
      expect(rec.level).toBe("info");
      expect(rec.msg).toBe("hello");
      expect(rec.scope).toBe("console");
      expect(rec.a).toBe(1);
      expect(rec.time).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it("writes warn and error to stderr in production", async () => {
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("LOG_PRETTY", "0");
      const { log } = await import("@/lib/logger");
      log.warn("oops");
      log.error("bad");
      expect(writes).toHaveLength(2);
      expect(writes[0].stream).toBe("err");
      expect(writes[1].stream).toBe("err");
    });

    it("filters trace/debug below info default in production", async () => {
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("LOG_PRETTY", "0");
      const { log } = await import("@/lib/logger");
      log.trace("nope");
      log.debug("nope");
      log.info("yes");
      expect(writes).toHaveLength(1);
      expect(JSON.parse(writes[0].chunk).msg).toBe("yes");
    });

    it("emits debug under non-production default", async () => {
      vi.stubEnv("NODE_ENV", "development");
      vi.stubEnv("LOG_PRETTY", "0");
      const { log } = await import("@/lib/logger");
      log.debug("dev-only");
      expect(writes).toHaveLength(1);
    });
  });

  describe("LOG_LEVEL override", () => {
    it("respects LOG_LEVEL=warn", async () => {
      vi.stubEnv("LOG_LEVEL", "warn");
      vi.stubEnv("LOG_PRETTY", "0");
      const { log } = await import("@/lib/logger");
      log.info("filtered");
      log.warn("kept");
      log.error("kept");
      expect(writes).toHaveLength(2);
      expect(JSON.parse(writes[0].chunk).level).toBe("warn");
      expect(JSON.parse(writes[1].chunk).level).toBe("error");
    });

    it("ignores invalid LOG_LEVEL and falls back to default", async () => {
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("LOG_LEVEL", "garbage");
      vi.stubEnv("LOG_PRETTY", "0");
      const { log } = await import("@/lib/logger");
      log.info("kept");
      log.debug("filtered");
      expect(writes).toHaveLength(1);
    });
  });

  describe("pretty mode", () => {
    it("emits human-readable lines when LOG_PRETTY=1", async () => {
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("LOG_PRETTY", "1");
      const { log } = await import("@/lib/logger");
      log.info("hello", { a: 1 });
      expect(writes).toHaveLength(1);
      expect(writes[0].chunk).toBe('[info] [console] hello {"a":1}\n');
    });

    it("omits ctx suffix when ctx is empty", async () => {
      vi.stubEnv("LOG_PRETTY", "1");
      const { log } = await import("@/lib/logger");
      log.info("plain");
      expect(writes[0].chunk).toBe("[info] [console] plain\n");
    });
  });

  describe("createLogger + child", () => {
    it("scopes are visible in records", async () => {
      vi.stubEnv("LOG_PRETTY", "0");
      vi.stubEnv("LOG_LEVEL", "trace");
      const { createLogger } = await import("@/lib/logger");
      const log = createLogger("kafka-sse");
      log.info("started");
      expect(JSON.parse(writes[0].chunk).scope).toBe("kafka-sse");
    });

    it("child appends scope and merges ctx", async () => {
      vi.stubEnv("LOG_PRETTY", "0");
      vi.stubEnv("LOG_LEVEL", "trace");
      const { createLogger } = await import("@/lib/logger");
      const parent = createLogger("router", { reqId: "abc" });
      const child = parent.child("k8s", { ns: "vst" });
      child.warn("retry");
      const rec = JSON.parse(writes[0].chunk);
      expect(rec.scope).toBe("router:k8s");
      expect(rec.reqId).toBe("abc");
      expect(rec.ns).toBe("vst");
      expect(rec.msg).toBe("retry");
    });

    it("call-site ctx wins over parent baseCtx", async () => {
      vi.stubEnv("LOG_PRETTY", "0");
      vi.stubEnv("LOG_LEVEL", "trace");
      const { createLogger } = await import("@/lib/logger");
      const log = createLogger("svc", { region: "us-west-2" });
      log.info("hit", { region: "us-east-2" });
      expect(JSON.parse(writes[0].chunk).region).toBe("us-east-2");
    });
  });

  describe("request context integration", () => {
    it("includes reqId in JSON record when inside runWithRequestContext", async () => {
      vi.stubEnv("LOG_PRETTY", "0");
      vi.stubEnv("LOG_LEVEL", "info");
      const { log } = await import("@/lib/logger");
      const { runWithRequestContext } = await import("@/lib/request-context");
      runWithRequestContext({ reqId: "test-123" }, () => {
        log.info("hello");
      });
      expect(writes).toHaveLength(1);
      const rec = JSON.parse(writes[0].chunk);
      expect(rec.reqId).toBe("test-123");
    });

    it("omits reqId from JSON record when no ALS context is active", async () => {
      vi.stubEnv("LOG_PRETTY", "0");
      vi.stubEnv("LOG_LEVEL", "info");
      const { log } = await import("@/lib/logger");
      log.info("no context");
      expect(writes).toHaveLength(1);
      const rec = JSON.parse(writes[0].chunk);
      expect(rec.reqId).toBeUndefined();
    });

    it("call-site ctx reqId overrides ALS reqId", async () => {
      vi.stubEnv("LOG_PRETTY", "0");
      vi.stubEnv("LOG_LEVEL", "info");
      const { log } = await import("@/lib/logger");
      const { runWithRequestContext } = await import("@/lib/request-context");
      runWithRequestContext({ reqId: "als-id" }, () => {
        log.info("explicit", { reqId: "explicit-id" });
      });
      expect(writes).toHaveLength(1);
      const rec = JSON.parse(writes[0].chunk);
      expect(rec.reqId).toBe("explicit-id");
    });

    it("includes reqId in pretty output when inside runWithRequestContext", async () => {
      vi.stubEnv("LOG_PRETTY", "1");
      vi.stubEnv("LOG_LEVEL", "info");
      const { log } = await import("@/lib/logger");
      const { runWithRequestContext } = await import("@/lib/request-context");
      runWithRequestContext({ reqId: "pretty-123" }, () => {
        log.info("pretty msg");
      });
      expect(writes).toHaveLength(1);
      expect(writes[0].chunk).toBe("[info] [console] reqId=pretty-123 pretty msg\n");
    });
  });

  describe("error serialization", () => {
    it("serializes Error instances with name + message + stack", async () => {
      vi.stubEnv("LOG_PRETTY", "0");
      vi.stubEnv("LOG_LEVEL", "trace");
      const { log } = await import("@/lib/logger");
      const err = new Error("boom");
      log.error("op failed", { err });
      const rec = JSON.parse(writes[0].chunk);
      expect(rec.err.name).toBe("Error");
      expect(rec.err.message).toBe("boom");
      expect(typeof rec.err.stack).toBe("string");
    });

    it("serializes nested cause", async () => {
      vi.stubEnv("LOG_PRETTY", "0");
      vi.stubEnv("LOG_LEVEL", "trace");
      const { log } = await import("@/lib/logger");
      const inner = new Error("inner");
      const outer = new Error("outer", { cause: inner });
      log.error("chain", { err: outer });
      const rec = JSON.parse(writes[0].chunk);
      expect(rec.err.message).toBe("outer");
      expect(rec.err.cause.message).toBe("inner");
    });

    it("non-Error values pass through as plain ctx", async () => {
      vi.stubEnv("LOG_PRETTY", "0");
      vi.stubEnv("LOG_LEVEL", "trace");
      const { log } = await import("@/lib/logger");
      log.info("plain", { value: 42, str: "x" });
      const rec = JSON.parse(writes[0].chunk);
      expect(rec.value).toBe(42);
      expect(rec.str).toBe("x");
    });
  });

  // ISVD-550. Redaction is a property of the logger, not of the call sites.
  // Nothing was leaking when these were written — that is why they exist: the
  // guarantee has to hold for the call site nobody has written yet.
  describe("redaction", () => {
    async function emitOne(
      fn: (log: import("@/lib/logger").Logger) => void
    ): Promise<Record<string, unknown>> {
      vi.stubEnv("LOG_PRETTY", "0");
      vi.stubEnv("LOG_LEVEL", "trace");
      const { log } = await import("@/lib/logger");
      fn(log);
      expect(writes).toHaveLength(1);
      return JSON.parse(writes[0].chunk);
    }

    it("redacts a top-level ctx value whose key names a credential", async () => {
      const rec = await emitOne((log) => log.info("auth", { password: "hunter2" }));
      expect(rec.password).toBe("[redacted]");
    });

    it("matches the key case-insensitively and as a fragment", async () => {
      const rec = await emitOne((log) =>
        log.info("env", {
          CONSOLE_PASSWORD: "p",
          s3AccessKey: "a",
          "x-api-key": "k",
          authorization: "Basic dXNlcjpwYXNz",
        })
      );
      expect(rec.CONSOLE_PASSWORD).toBe("[redacted]");
      expect(rec.s3AccessKey).toBe("[redacted]");
      expect(rec["x-api-key"]).toBe("[redacted]");
      expect(rec.authorization).toBe("[redacted]");
    });

    it("redacts a credential-shaped value under an innocuous key", async () => {
      const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln";
      const rec = await emitOne((log) =>
        log.info("token seen", { note: jwt, awsId: "AKIAIOSFODNN7EXAMPLE" })
      );
      expect(rec.note).toBe("[redacted]");
      expect(rec.awsId).toBe("[redacted]");
    });

    it("walks nested objects and arrays", async () => {
      const rec = await emitOne((log) =>
        log.info("nested", { outer: { inner: { apiKey: "sk-abc" }, ok: 1 }, list: [{ token: "t" }] })
      );
      const outer = rec.outer as { inner: Record<string, unknown>; ok: number };
      expect(outer.inner.apiKey).toBe("[redacted]");
      expect(outer.ok).toBe(1);
      expect((rec.list as Record<string, unknown>[])[0].token).toBe("[redacted]");
    });

    // The widest form of the leak: passed once at construction, emitted on every
    // line that logger writes. baseCtx used to be spread without normalization.
    it("redacts baseCtx from createLogger", async () => {
      vi.stubEnv("LOG_PRETTY", "0");
      vi.stubEnv("LOG_LEVEL", "trace");
      const { createLogger } = await import("@/lib/logger");
      createLogger("svc", { apiKey: "sk-secret" }).info("hit");
      expect(writes).toHaveLength(1);
      expect(JSON.parse(writes[0].chunk).apiKey).toBe("[redacted]");
    });

    it("redacts baseCtx inherited through child()", async () => {
      vi.stubEnv("LOG_PRETTY", "0");
      vi.stubEnv("LOG_LEVEL", "trace");
      const { createLogger } = await import("@/lib/logger");
      createLogger("parent", { sessionToken: "abc123" }).child("k8s", { pwd: "x" }).warn("retry");
      const rec = JSON.parse(writes[0].chunk);
      expect(rec.sessionToken).toBe("[redacted]");
      expect(rec.pwd).toBe("[redacted]");
    });

    it("redacts a credential inside a serialized Error", async () => {
      const rec = await emitOne((log) =>
        log.error("op failed", { err: new Error("upstream said no"), secret: "s" })
      );
      expect((rec.err as Record<string, unknown>).message).toBe("upstream said no");
      expect(rec.secret).toBe("[redacted]");
    });

    it("leaves every context key the codebase actually logs untouched", async () => {
      // Guards against a denylist widened until it eats real diagnostics. These
      // are the keys in use across the tree as of ISVD-550.
      const rec = await emitOne((log) =>
        log.info("real keys", {
          pod: "vst-0",
          namespace: "vss-alerts",
          topic: "vision-llm-errors",
          container: "sensor",
          count: 3,
          groupId: "g1",
          index: 0,
          query: "theft",
          kiosk: true,
          resumed: 2,
          restarts: 1,
          issues: [],
          cameras: ["a"],
          reqId: "r1",
          ns: "vst",
          region: "us-west-2",
        })
      );
      expect(rec.pod).toBe("vst-0");
      expect(rec.namespace).toBe("vss-alerts");
      expect(rec.topic).toBe("vision-llm-errors");
      expect(rec.container).toBe("sensor");
      expect(rec.count).toBe(3);
      expect(rec.groupId).toBe("g1");
      expect(rec.query).toBe("theft");
      expect(rec.kiosk).toBe(true);
      expect(rec.cameras).toEqual(["a"]);
      expect(rec.region).toBe("us-west-2");
    });

    it("redacts in pretty mode too", async () => {
      vi.stubEnv("LOG_PRETTY", "1");
      vi.stubEnv("LOG_LEVEL", "trace");
      const { log } = await import("@/lib/logger");
      log.info("pretty", { token: "t" });
      expect(writes[0].chunk).toBe('[info] [console] pretty {"token":"[redacted]"}\n');
    });
  });
});

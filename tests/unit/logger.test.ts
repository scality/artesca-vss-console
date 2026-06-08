import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

describe("logger", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let stdoutSpy: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let stderrSpy: any;
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
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
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
});

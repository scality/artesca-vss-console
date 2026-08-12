import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  redactAndCap,
  safeContextString,
  errorSignatureFromPayload,
  kafkaFingerprint,
  podFingerprint,
  podBaseName,
  DedupeWindow,
  MAX_CONTEXT_STRING_LEN,
  MAX_CONTEXT_TOTAL_LEN,
} from "./error-bridge";

describe("redactAndCap", () => {
  it("redacts values under key names that look like secrets", () => {
    const out = redactAndCap({
      apiKey: "super-secret-value",
      password: "hunter2",
      nested: { token: "abc123" },
      safe: "hello",
    }) as Record<string, unknown>;

    expect(out.apiKey).toBe("[redacted]");
    expect(out.password).toBe("[redacted]");
    expect((out.nested as Record<string, unknown>).token).toBe("[redacted]");
    expect(out.safe).toBe("hello");
  });

  it("redacts bare string values that look like tokens even under an innocuous key", () => {
    const out = redactAndCap({ message: "sk-abcdefghijklmnop" }) as Record<string, unknown>;
    expect(out.message).toBe("[redacted]");
  });

  it("redacts a JWT-shaped bearer string", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    const out = redactAndCap({ authValue: jwt }) as Record<string, unknown>;
    expect(out.authValue).toBe("[redacted]");
  });

  it("caps long strings", () => {
    const long = "x".repeat(MAX_CONTEXT_STRING_LEN + 500);
    const out = redactAndCap(long) as string;
    expect(out.length).toBeLessThan(long.length);
    expect(out).toContain("truncated");
  });

  it("caps arrays and objects with too many entries", () => {
    const arr = Array.from({ length: 200 }, (_, i) => i);
    const out = redactAndCap(arr) as unknown[];
    expect(out.length).toBe(50);

    const bigObj: Record<string, number> = {};
    for (let i = 0; i < 100; i++) bigObj[`k${i}`] = i;
    const outObj = redactAndCap(bigObj) as Record<string, unknown>;
    expect(Object.keys(outObj).length).toBeLessThanOrEqual(51);
  });

  it("limits recursion depth", () => {
    let deep: unknown = "leaf";
    for (let i = 0; i < 20; i++) deep = { nested: deep };
    const out = redactAndCap(deep);
    expect(JSON.stringify(out)).toContain("max depth");
  });

  it("passes through primitives and null/undefined", () => {
    expect(redactAndCap(42)).toBe(42);
    expect(redactAndCap(true)).toBe(true);
    expect(redactAndCap(null)).toBe(null);
    expect(redactAndCap(undefined)).toBe(undefined);
  });
});

describe("safeContextString", () => {
  it("produces a redacted, length-capped JSON string", () => {
    const s = safeContextString({ password: "leak-me", ok: "fine" });
    expect(s).not.toContain("leak-me");
    expect(s).toContain("fine");
  });

  it("caps the overall serialized size", () => {
    const huge = { blob: "y".repeat(10_000) };
    const s = safeContextString(huge);
    expect(s.length).toBeLessThanOrEqual(MAX_CONTEXT_TOTAL_LEN + 50);
  });

  it("never throws on circular-ish/unserializable input", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => safeContextString(circular)).not.toThrow();
  });
});

describe("errorSignatureFromPayload", () => {
  it("extracts a known error field", () => {
    expect(errorSignatureFromPayload({ error: "OOM killed" })).toBe("OOM killed");
    expect(errorSignatureFromPayload({ error_type: "TimeoutError" })).toBe("TimeoutError");
    expect(errorSignatureFromPayload({ message: "connection refused" })).toBe(
      "connection refused"
    );
  });

  it("prefers the first matching candidate field", () => {
    expect(errorSignatureFromPayload({ error: "primary", message: "secondary" })).toBe("primary");
  });

  it("falls back to the raw string payload", () => {
    expect(errorSignatureFromPayload("plain text error")).toBe("plain text error");
  });

  it("falls back to unknown for unrecognized shapes", () => {
    expect(errorSignatureFromPayload({ foo: "bar" })).toBe("unknown");
    expect(errorSignatureFromPayload(null)).toBe("unknown");
    expect(errorSignatureFromPayload(42)).toBe("unknown");
  });
});

describe("fingerprints", () => {
  it("groups kafka errors by topic + signature", () => {
    expect(kafkaFingerprint("vision-llm-errors", "OOM killed")).toEqual([
      "vss-kafka",
      "vision-llm-errors",
      "OOM killed",
    ]);
  });

  it("groups pod crashes by namespace + pod + container + reason", () => {
    expect(podFingerprint("vss-base", "vss-vios-sensor", "sensor", "CrashLoopBackOff")).toEqual([
      "vss-pod",
      "vss-base",
      "vss-vios-sensor",
      "sensor",
      "CrashLoopBackOff",
    ]);
  });
});

describe("podBaseName", () => {
  it("strips a ReplicaSet-hash + pod-suffix pair from a Deployment pod name", () => {
    expect(podBaseName("vss-vios-sensor-7d8f9c6b45-x2k9p")).toBe("vss-vios-sensor");
  });

  it("keeps a StatefulSet-style ordinal pod name intact", () => {
    // "0" is a single-char ordinal, not a 5-10 char generated suffix — untouched.
    expect(podBaseName("kafka-kafka-0")).toBe("kafka-kafka-0");
  });

  it("leaves a name with no generated-looking suffix untouched", () => {
    expect(podBaseName("redis")).toBe("redis");
    expect(podBaseName("vss-agent")).toBe("vss-agent");
  });
});

describe("DedupeWindow", () => {
  let now: number;

  beforeEach(() => {
    now = 1_000_000;
  });

  it("suppresses a repeat of the same key within the window", () => {
    const w = new DedupeWindow(60_000);
    expect(w.shouldSuppress("k1", now)).toBe(false);
    expect(w.shouldSuppress("k1", now + 1_000)).toBe(true);
    expect(w.shouldSuppress("k1", now + 59_999)).toBe(true);
  });

  it("allows the same key again once the window has elapsed", () => {
    const w = new DedupeWindow(60_000);
    expect(w.shouldSuppress("k1", now)).toBe(false);
    expect(w.shouldSuppress("k1", now + 60_000)).toBe(false);
  });

  it("tracks distinct keys independently", () => {
    const w = new DedupeWindow(60_000);
    expect(w.shouldSuppress("a", now)).toBe(false);
    expect(w.shouldSuppress("b", now)).toBe(false);
    expect(w.shouldSuppress("a", now + 1)).toBe(true);
    expect(w.shouldSuppress("b", now + 1)).toBe(true);
  });

  it("sweep() drops entries older than the window", () => {
    const w = new DedupeWindow(1_000);
    w.shouldSuppress("old", now);
    w.shouldSuppress("fresh", now + 900);
    expect(w.size()).toBe(2);
    w.sweep(now + 1_500);
    // "old" (age 1500) expired; "fresh" (age 600) survives.
    expect(w.size()).toBe(1);
  });
});

// ─── The entry-point gate ───────────────────────────────────────────────────
//
// Only the pure helpers above were covered, which is how the DSN test stayed
// wrong: `process.env.SENTRY_DSN !== ""` is TRUE when the variable is unset, so
// an unconfigured console started the Kafka consumers and the pod-poll loop and
// pushed captures into an SDK that was never initialised. It read as correct
// only while a DSN was compiled into the image.
describe("startErrorBridge — the telemetry gate", () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.SENTRY_DSN;
    delete process.env.VSS_ERROR_BRIDGE;
    (globalThis as Record<string, unknown>).__errorBridgeStarted = false;
  });

  it("starts no Kafka consumer when no DSN is configured", async () => {
    const consumeTopic = vi.fn();
    vi.doMock("@/lib/kafka", () => ({ consumeTopic }));
    vi.doMock("@/lib/k8s", () => ({ coreV1: () => ({}), watchedNamespaces: () => [] }));

    const { startErrorBridge } = await import("./error-bridge");
    await startErrorBridge();

    // The bridge exists to forward failures into Sentry. With nowhere to forward
    // them, consuming the topics is pure cost — and the captures it would make
    // go nowhere while looking, in a log, exactly like working telemetry.
    expect(consumeTopic).not.toHaveBeenCalled();
  });

  it("starts the consumers once a DSN is configured", async () => {
    process.env.SENTRY_DSN = "https://k@o1.ingest.de.sentry.io/9";
    const consumeTopic = vi.fn().mockResolvedValue(undefined);
    vi.doMock("@/lib/kafka", () => ({ consumeTopic }));
    vi.doMock("@/lib/k8s", () => ({ coreV1: () => ({}), watchedNamespaces: () => [] }));

    const { startErrorBridge } = await import("./error-bridge");
    await startErrorBridge();

    expect(consumeTopic).toHaveBeenCalled();
  });
});

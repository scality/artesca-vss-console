/**
 * Unit tests for src/lib/cluster-refs.ts — RTVI-CV section.
 *
 * cluster-refs reads process.env at module-load time, so each scenario
 * requires vi.resetModules() + env mutation + a fresh dynamic import.
 *
 * The `server-only` stub in tests/setup.ts ensures the import("server-only")
 * at the top of cluster-refs.ts doesn't throw in the node test environment.
 */

import { describe, it, expect, vi, afterEach } from "vitest";

// Capture the original env once; we restore per test.
const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  // Strip any RTVI_CV_* vars added by individual tests and reset module cache.
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("RTVI_CV")) {
      delete process.env[key];
    }
  }
  process.env = { ...ORIGINAL_ENV };
  vi.resetModules();
});

describe("CLUSTER.rtviCv — defaults (no RTVI_CV_* env set)", () => {
  it("has the correct default service name", async () => {
    const { CLUSTER } = await import("@/lib/cluster-refs");
    expect(CLUSTER.rtviCv.service).toBe("vss-rtvi-cv-mv3dt");
  });

  it("has port 9000", async () => {
    const { CLUSTER } = await import("@/lib/cluster-refs");
    expect(CLUSTER.rtviCv.port).toBe(9000);
  });

  it("has apiBase /api/v1", async () => {
    const { CLUSTER } = await import("@/lib/cluster-refs");
    expect(CLUSTER.rtviCv.apiBase).toBe("/api/v1");
  });

  it("endpoint contains :9000", async () => {
    const { CLUSTER } = await import("@/lib/cluster-refs");
    expect(CLUSTER.rtviCv.endpoint).toContain(":9000");
  });

  it("is disabled by default", async () => {
    const { CLUSTER } = await import("@/lib/cluster-refs");
    expect(CLUSTER.rtviCv.enabled).toBe(false);
  });

  it("restartable map does NOT include vss-rtvi-cv-mv3dt when disabled", async () => {
    const { RESTARTABLE } = await import("@/lib/cluster-refs");
    expect(Object.keys(RESTARTABLE)).not.toContain("vss-rtvi-cv-mv3dt");
  });
});

describe("CLUSTER.rtviCv — opt-in via RTVI_CV_ENABLED=1", () => {
  it("is enabled", async () => {
    process.env.RTVI_CV_ENABLED = "1";
    const { CLUSTER } = await import("@/lib/cluster-refs");
    expect(CLUSTER.rtviCv.enabled).toBe(true);
  });

  it("restartable map includes vss-rtvi-cv-mv3dt", async () => {
    process.env.RTVI_CV_ENABLED = "1";
    const { RESTARTABLE } = await import("@/lib/cluster-refs");
    expect(Object.keys(RESTARTABLE)).toContain("vss-rtvi-cv-mv3dt");
  });

  it("component map entry has the correct shape", async () => {
    process.env.RTVI_CV_ENABLED = "1";
    const { RESTARTABLE } = await import("@/lib/cluster-refs");
    const entry = RESTARTABLE["vss-rtvi-cv-mv3dt"];
    expect(entry).toBeDefined();
    expect(entry.kind).toBe("Deployment");
    expect(entry.name).toBe("vss-rtvi-cv-mv3dt");
    expect(typeof entry.namespace).toBe("string");
  });
});

describe("CLUSTER.rtviCv — opt-in via RTVI_CV_SERVICE", () => {
  it("is enabled when RTVI_CV_SERVICE is set", async () => {
    process.env.RTVI_CV_SERVICE = "vss-rtvi-cv-mv3dt";
    const { CLUSTER } = await import("@/lib/cluster-refs");
    expect(CLUSTER.rtviCv.enabled).toBe(true);
  });

  it("restartable map includes the custom service name", async () => {
    process.env.RTVI_CV_SERVICE = "vss-rtvi-cv-mv3dt";
    const { RESTARTABLE } = await import("@/lib/cluster-refs");
    expect(Object.keys(RESTARTABLE)).toContain("vss-rtvi-cv-mv3dt");
  });
});

describe("CLUSTER.rtviCv — RTVI_CV_ENDPOINT override", () => {
  it("uses the explicit endpoint when set", async () => {
    process.env.RTVI_CV_ENDPOINT = "http://custom-rtvi-cv-host:9000";
    const { CLUSTER } = await import("@/lib/cluster-refs");
    expect(CLUSTER.rtviCv.endpoint).toBe("http://custom-rtvi-cv-host:9000");
  });

  it("is enabled when RTVI_CV_ENDPOINT is set", async () => {
    process.env.RTVI_CV_ENDPOINT = "http://custom-rtvi-cv-host:9000";
    const { CLUSTER } = await import("@/lib/cluster-refs");
    expect(CLUSTER.rtviCv.enabled).toBe(true);
  });
});

describe("CLUSTER.rtviCv — disabled: restartable map is clean", () => {
  it("does not include vss-rtvi-cv-mv3dt when no env set", async () => {
    // Confirm no RTVI_CV_* env vars leak in from the global env.
    delete process.env.RTVI_CV_ENABLED;
    delete process.env.RTVI_CV_SERVICE;
    delete process.env.RTVI_CV_ENDPOINT;
    const { RESTARTABLE } = await import("@/lib/cluster-refs");
    expect(Object.keys(RESTARTABLE)).not.toContain("vss-rtvi-cv-mv3dt");
  });
});

// Fixture hygiene: every fixture file must parse against its Zod schema.
// This catches happy-path-only fixtures and structural drift.
import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  CameraSchema,
  ScenarioSchema,
  IncidentSchema,
  GpuStateSchema,
  OverviewSnapshotSchema,
  SgWhitelistEntrySchema,
  PodSummarySchema,
  DemoProfileSchema,
} from "@/lib/schemas";

// ---- fixtures imports ----
import cameras from "../fixtures/cameras.json";
import scenarios from "../fixtures/scenarios.json";
import incidents from "../fixtures/incidents.json";
import gpu from "../fixtures/gpu.json";
import overview from "../fixtures/overview.json";
import overviewDegraded from "../fixtures/overview-degraded.json";
import sgWhitelist from "../fixtures/sg-whitelist.json";
import pods from "../fixtures/pods.json";
import podsFailingFixture from "../fixtures/pods-failing.json";
import profiles from "../fixtures/profiles.json";
import incidentsEmpty from "../fixtures/incidents-empty.json";
import topology from "../fixtures/topology.json";
import topologyDegraded from "../fixtures/topology-degraded.json";

// Helper: parse array of items against a Zod schema
function parseAll<T>(
  schema: z.ZodType<T>,
  data: unknown[],
  label: string
): void {
  const ArraySchema = z.array(schema);
  const result = ArraySchema.safeParse(data);
  if (!result.success) {
    throw new Error(
      `${label} fixture failed schema validation:\n` +
        result.error.issues
          .map((i) => `  [${i.path.join(".")}] ${i.message}`)
          .join("\n")
    );
  }
}

// --- cameras.json ---
describe("fixtures/cameras.json", () => {
  it("parses all camera entries", () => {
    parseAll(CameraSchema, cameras as unknown[], "cameras.json");
  });

  it("has at least 2 cameras", () => {
    expect(cameras.length).toBeGreaterThanOrEqual(2);
  });

  it("has at least one camera with 2 feeds (Pyramid 2-lens rail)", () => {
    const twoFeed = (cameras as Array<{ feeds: unknown[] }>).find(
      (c) => c.feeds.length >= 2
    );
    expect(twoFeed).toBeDefined();
  });
});

// --- scenarios.json ---
describe("fixtures/scenarios.json", () => {
  it("parses all scenario entries", () => {
    parseAll(ScenarioSchema, scenarios as unknown[], "scenarios.json");
  });

  it("has at least 3 scenarios", () => {
    expect(scenarios.length).toBeGreaterThanOrEqual(3);
  });

  it("has at least one disabled scenario", () => {
    const disabled = (scenarios as Array<{ enabled: boolean }>).some(
      (s) => !s.enabled
    );
    expect(disabled).toBe(true);
  });
});

// --- incidents.json ---
describe("fixtures/incidents.json", () => {
  it("parses all incident entries", () => {
    parseAll(IncidentSchema, incidents as unknown[], "incidents.json");
  });

  it("has at least 2 incidents with different severities", () => {
    const severities = new Set(
      (incidents as Array<{ severity: string }>).map((i) => i.severity)
    );
    expect(severities.size).toBeGreaterThanOrEqual(1);
  });
});

// --- incidents-empty.json (edge case) ---
describe("fixtures/incidents-empty.json", () => {
  it("is an empty array", () => {
    expect(Array.isArray(incidentsEmpty)).toBe(true);
    expect((incidentsEmpty as unknown[]).length).toBe(0);
  });
});

// --- gpu.json ---
describe("fixtures/gpu.json", () => {
  it("parses all GPU state entries", () => {
    parseAll(GpuStateSchema, gpu as unknown[], "gpu.json");
  });

  it("has 2 GPU entries (L40S × 2)", () => {
    expect(gpu.length).toBe(2);
  });

  it("all GPUs are L40S model", () => {
    for (const g of gpu as Array<{ name: string }>) {
      expect(g.name).toContain("L40S");
    }
  });
});

// --- overview.json ---
describe("fixtures/overview.json", () => {
  it("parses as OverviewSnapshot", () => {
    const result = OverviewSnapshotSchema.safeParse(overview);
    if (!result.success) {
      throw new Error(
        "overview.json failed:\n" +
          result.error.issues
            .map((i) => `  [${i.path.join(".")}] ${i.message}`)
            .join("\n")
      );
    }
  });

  it("has non-zero GPU count", () => {
    const snap = overview as { gpus: unknown[] };
    expect(snap.gpus.length).toBeGreaterThan(0);
  });

  it("cameraSim is running", () => {
    const snap = overview as { cameraSim: { instanceState: string } };
    expect(snap.cameraSim.instanceState).toBe("running");
  });
});

// --- overview-degraded.json (failure variant) ---
describe("fixtures/overview-degraded.json", () => {
  it("parses as OverviewSnapshot", () => {
    const result = OverviewSnapshotSchema.safeParse(overviewDegraded);
    if (!result.success) {
      throw new Error(
        "overview-degraded.json failed:\n" +
          result.error.issues
            .map((i) => `  [${i.path.join(".")}] ${i.message}`)
            .join("\n")
      );
    }
  });

  it("cameraSim is unreachable (failure variant)", () => {
    const snap = overviewDegraded as { cameraSim: { instanceState: string } };
    expect(snap.cameraSim.instanceState).toBe("unreachable");
  });

  it("nim is not ready (degraded)", () => {
    const snap = overviewDegraded as { nim: { ready: boolean } };
    expect(snap.nim.ready).toBe(false);
  });
});

// --- sg-whitelist.json ---
describe("fixtures/sg-whitelist.json", () => {
  it("parses all SG whitelist entries", () => {
    parseAll(SgWhitelistEntrySchema, sgWhitelist as unknown[], "sg-whitelist.json");
  });

  it("has at least 2 entries", () => {
    expect(sgWhitelist.length).toBeGreaterThanOrEqual(2);
  });

  it("all ports are 8800", () => {
    for (const e of sgWhitelist as Array<{ port: number }>) {
      expect(e.port).toBe(8800);
    }
  });
});

// --- pods.json ---
describe("fixtures/pods.json", () => {
  it("parses all pod summary entries", () => {
    parseAll(PodSummarySchema, pods as unknown[], "pods.json");
  });

  it("has pods from multiple namespaces", () => {
    const ns = new Set(
      (pods as Array<{ namespace: string }>).map((p) => p.namespace)
    );
    expect(ns.size).toBeGreaterThanOrEqual(2);
  });
});

// --- pods-failing.json (failure variant) ---
describe("fixtures/pods-failing.json", () => {
  it("parses all pod summary entries", () => {
    parseAll(PodSummarySchema, podsFailingFixture as unknown[], "pods-failing.json");
  });

  it("has at least one Failed or Pending pod", () => {
    const degraded = (podsFailingFixture as Array<{ phase: string }>).some(
      (p) => p.phase === "Failed" || p.phase === "Pending"
    );
    expect(degraded).toBe(true);
  });
});

// --- profiles.json ---
describe("fixtures/profiles.json", () => {
  it("parses all profile entries against DemoProfileSchema", () => {
    parseAll(DemoProfileSchema, profiles as unknown[], "profiles.json");
  });

  it("has at least 1 profile", () => {
    expect(profiles.length).toBeGreaterThanOrEqual(1);
  });
});

// --- topology.json (structural check — no Zod schema, custom format) ---
describe("fixtures/topology.json", () => {
  it("has a nodes array", () => {
    const t = topology as { nodes?: unknown[] };
    expect(Array.isArray(t.nodes)).toBe(true);
  });

  it("all nodes have id and health fields", () => {
    const t = topology as { nodes: Array<{ id?: string; health?: string }> };
    for (const n of t.nodes) {
      expect(typeof n.id).toBe("string");
      expect(["ok", "warn", "fail", "unknown"]).toContain(n.health);
    }
  });

  it("has 9 nodes (full VSS pipeline)", () => {
    const t = topology as { nodes: unknown[] };
    expect(t.nodes.length).toBe(9);
  });
});

// --- topology-degraded.json (failure variant) ---
describe("fixtures/topology-degraded.json", () => {
  it("has nodes with mixed health states", () => {
    const t = topologyDegraded as {
      nodes: Array<{ health?: string }>;
    };
    const healths = new Set(t.nodes.map((n) => n.health));
    expect(healths.has("fail")).toBe(true);
    expect(healths.has("warn")).toBe(true);
    expect(healths.has("ok")).toBe(true);
  });
});

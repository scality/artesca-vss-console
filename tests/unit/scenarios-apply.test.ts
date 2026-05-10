import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Module mocks (must precede imports) ─────────────────────────────────────

vi.mock("@/lib/helpers/configmaps", () => ({
  readConfigMap: vi.fn(),
  writeConfigMap: vi.fn(),
  patchConfigMapKey: vi.fn(),
  patchConfigMapRawKey: vi.fn(),
  readConfigMapKey: vi.fn(),
}));

// server-only is already stubbed in tests/setup.ts

import * as configmapsMod from "@/lib/helpers/configmaps";
import {
  gcsScenariosToCmPayload,
  scenarioToGcsConfig,
  applyScenariosLive,
  scenariosToYaml,
} from "@/lib/helpers/scenarios-apply";
import { CLUSTER } from "@/lib/cluster-refs";
import type { ScenarioConfig } from "@/lib/helpers/gcs-config";
import type { Scenario } from "@/lib/types";
import { parse as yamlParse } from "yaml";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const SCENARIO_GCS: ScenarioConfig = {
  id: "theft-1",
  name: "Theft Detection",
  description: "Customer concealing items",
  severity: "high",
  channels: ["ui", "slack"],
  sensor_filter: "*",
  keywords: ["conceal", "steal"],
  enabled: true,
  cooldown_seconds: 30,
};

const SCENARIO_CAMEL: Scenario = {
  id: "theft-2",
  name: "Shelf Sweep",
  severity: "medium",
  channels: ["ui"],
  sensorFilter: "checkout-*",
  keywords: ["sweep"],
  enabled: false,
};

beforeEach(() => {
  vi.resetAllMocks();
});

// ─── gcsScenariosToCmPayload ──────────────────────────────────────────────────

describe("gcsScenariosToCmPayload", () => {
  it("maps all required fields from ScenarioConfig to the scenarios array", () => {
    const payload = gcsScenariosToCmPayload([SCENARIO_GCS]);
    expect(payload.scenarios).toHaveLength(1);
    const s = payload.scenarios[0] as Record<string, unknown>;
    expect(s.id).toBe("theft-1");
    expect(s.name).toBe("Theft Detection");
    expect(s.severity).toBe("high");
    expect(s.channels).toEqual(["ui", "slack"]);
    expect(s.sensor_filter).toBe("*");
    expect(s.keywords).toEqual(["conceal", "steal"]);
    expect(s.enabled).toBe(true);
    expect(s.cooldown_seconds).toBe(30);
  });

  it("omits description when undefined", () => {
    const { description: _d, ...noDesc } = SCENARIO_GCS;
    const payload = gcsScenariosToCmPayload([noDesc]);
    expect((payload.scenarios[0] as Record<string, unknown>).description).toBeUndefined();
  });

  it("omits cooldown_seconds when undefined", () => {
    const { cooldown_seconds: _c, ...noCooldown } = SCENARIO_GCS;
    const payload = gcsScenariosToCmPayload([noCooldown]);
    expect((payload.scenarios[0] as Record<string, unknown>).cooldown_seconds).toBeUndefined();
  });

  it("handles an empty array of scenarios", () => {
    const payload = gcsScenariosToCmPayload([]);
    expect(payload.scenarios).toHaveLength(0);
  });
});

// ─── scenarioToGcsConfig ──────────────────────────────────────────────────────

describe("scenarioToGcsConfig", () => {
  it("converts camelCase Scenario to snake_case ScenarioConfig", () => {
    const result = scenarioToGcsConfig(SCENARIO_CAMEL);
    expect(result.id).toBe("theft-2");
    expect(result.sensor_filter).toBe("checkout-*");
    expect(result.severity).toBe("medium");
    expect(result.enabled).toBe(false);
    expect(result.keywords).toEqual(["sweep"]);
  });

  it("omits description when not present on the source Scenario", () => {
    const result = scenarioToGcsConfig(SCENARIO_CAMEL);
    expect(result.description).toBeUndefined();
  });

  it("preserves description when present", () => {
    const withDesc: Scenario = { ...SCENARIO_CAMEL, description: "shelf sweep detail" };
    const result = scenarioToGcsConfig(withDesc);
    expect(result.description).toBe("shelf sweep detail");
  });
});

// ─── applyScenariosLive ───────────────────────────────────────────────────────

describe("applyScenariosLive", () => {
  it("docker mode: skips ConfigMap patch and returns without error", async () => {
    await applyScenariosLive(true, [SCENARIO_GCS]);
    expect(configmapsMod.patchConfigMapKey).not.toHaveBeenCalled();
  });

  it("k8s mode: calls patchConfigMapKey with correct namespace/name/key/payload", async () => {
    vi.mocked(configmapsMod.patchConfigMapKey).mockResolvedValue(undefined);

    await applyScenariosLive(false, [SCENARIO_GCS]);

    expect(configmapsMod.patchConfigMapKey).toHaveBeenCalledTimes(1);
    const [ns, name, key, payload] = vi.mocked(configmapsMod.patchConfigMapKey).mock.calls[0];
    expect(ns).toBe(CLUSTER.scenarios.namespace);
    expect(name).toBe(CLUSTER.scenarios.configMap);
    expect(key).toBe(CLUSTER.scenarios.yamlKey);
    // payload must contain the mapped scenarios
    expect((payload as { scenarios: unknown[] }).scenarios).toHaveLength(1);
  });

  it("k8s mode: propagates errors from patchConfigMapKey", async () => {
    vi.mocked(configmapsMod.patchConfigMapKey).mockRejectedValue(
      new Error("409 Conflict"),
    );
    await expect(applyScenariosLive(false, [SCENARIO_GCS])).rejects.toThrow("409 Conflict");
  });

  it("k8s mode: handles empty scenarios array without error", async () => {
    vi.mocked(configmapsMod.patchConfigMapKey).mockResolvedValue(undefined);
    await expect(applyScenariosLive(false, [])).resolves.toBeUndefined();
    const [, , , payload] = vi.mocked(configmapsMod.patchConfigMapKey).mock.calls[0];
    expect((payload as { scenarios: unknown[] }).scenarios).toHaveLength(0);
  });
});

// ─── scenariosToYaml ─────────────────────────────────────────────────────────

describe("scenariosToYaml", () => {
  it("produces valid YAML that round-trips back to the original payload", () => {
    const yaml = scenariosToYaml([SCENARIO_GCS]);
    const parsed = yamlParse(yaml) as { scenarios: Record<string, unknown>[] };
    expect(parsed.scenarios).toHaveLength(1);
    expect(parsed.scenarios[0].id).toBe("theft-1");
    expect(parsed.scenarios[0].keywords).toEqual(["conceal", "steal"]);
  });

  it("returns a non-empty string for an empty scenarios list", () => {
    const yaml = scenariosToYaml([]);
    expect(typeof yaml).toBe("string");
    expect(yaml.trim().length).toBeGreaterThan(0);
    const parsed = yamlParse(yaml) as { scenarios: unknown[] };
    expect(parsed.scenarios).toHaveLength(0);
  });
});

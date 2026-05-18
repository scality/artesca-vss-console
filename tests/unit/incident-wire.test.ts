import { describe, it, expect } from "vitest";
import { fromWire } from "@/lib/helpers/incident-wire";

describe("fromWire", () => {
  it("converts scenario_id to scenarioId", () => {
    const result = fromWire({ scenario_id: "shoplifting" }) as Record<string, unknown>;
    expect(result.scenarioId).toBe("shoplifting");
    expect("scenario_id" in result).toBe(false);
  });

  it("converts clip_key to clipKey", () => {
    const result = fromWire({ clip_key: "clips/2026/05/18/clip-001.mp4" }) as Record<
      string,
      unknown
    >;
    expect(result.clipKey).toBe("clips/2026/05/18/clip-001.mp4");
    expect("clip_key" in result).toBe(false);
  });

  it("converts clip_status to clipStatus", () => {
    const result = fromWire({ clip_status: "ready" }) as Record<string, unknown>;
    expect(result.clipStatus).toBe("ready");
    expect("clip_status" in result).toBe(false);
  });

  it("leaves severity unchanged (no underscore — already camelCase-compatible)", () => {
    const result = fromWire({ severity: "high" }) as Record<string, unknown>;
    expect(result.severity).toBe("high");
  });

  it("does not recurse into the nested raw field", () => {
    const nestedRaw = { some_key: "value", another_field: 42 };
    const result = fromWire({ raw: nestedRaw }) as Record<string, unknown>;
    // Top-level `raw` key is unchanged (no underscore anyway).
    expect(result.raw).toEqual(nestedRaw);
    // The nested object should NOT be transformed — keys stay snake_case.
    expect((result.raw as Record<string, unknown>).some_key).toBe("value");
    expect((result.raw as Record<string, unknown>).another_field).toBe(42);
  });

  it("handles a full wire incident round-trip", () => {
    const wire = {
      ts: "2026-05-18T10:00:00Z",
      scenario_id: "shoplifting",
      scenario_name: "Shoplifting Detection",
      severity: "high",
      sensor_id: "cam-01-a",
      topic: "alerts.incidents",
      summary: "Suspicious behaviour",
      clip_key: "clips/abc.mp4",
      clip_bucket: "vss-clips",
      clip_status: "ready",
      raw: { original_payload: true },
    };
    const result = fromWire(wire) as Record<string, unknown>;
    expect(result.scenarioId).toBe("shoplifting");
    expect(result.scenarioName).toBe("Shoplifting Detection");
    expect(result.sensorId).toBe("cam-01-a");
    expect(result.clipKey).toBe("clips/abc.mp4");
    expect(result.clipBucket).toBe("vss-clips");
    expect(result.clipStatus).toBe("ready");
    expect(result.severity).toBe("high");
    // raw value passes through but is NOT recursed into
    expect(result.raw).toEqual({ original_payload: true });
  });

  it("returns non-object inputs unchanged", () => {
    expect(fromWire(null)).toBeNull();
    expect(fromWire(undefined)).toBeUndefined();
    expect(fromWire("string")).toBe("string");
    expect(fromWire(42)).toBe(42);
  });
});

import { describe, it, expect } from "vitest";
import {
  PodSummarySchema,
  CameraSchema,
  FeedSchema,
  ScenarioSchema,
  DemoProfileSchema,
  IncidentSchema,
  GpuStateSchema,
  OverviewSnapshotSchema,
  ModelCardSchema,
  AuditLogEntrySchema,
} from "@/lib/schemas";

function roundtrip<T>(schema: { parse: (v: unknown) => T; safeParse: (v: unknown) => { success: boolean; data?: T } }, input: T) {
  const parsed = schema.parse(input);
  const json = JSON.parse(JSON.stringify(parsed));
  const reparsed = schema.parse(json);
  expect(reparsed).toEqual(parsed);
}

describe("PodSummarySchema", () => {
  const valid = {
    namespace: "vst",
    name: "vst-sensor-ms-abc",
    phase: "Running" as const,
    ready: true,
    restarts: 0,
    age: "4h23m",
    node: "artesca-node-1",
    gpus: 1,
  };

  it("parses valid pod summary", () => {
    expect(PodSummarySchema.parse(valid)).toEqual(valid);
  });

  it("roundtrips", () => {
    roundtrip(PodSummarySchema, valid);
  });

  it("rejects unknown phase", () => {
    expect(() => PodSummarySchema.parse({ ...valid, phase: "Evicted" })).toThrow();
  });

  it("accepts missing optional fields", () => {
    const { node, gpus, ...minimal } = valid;
    expect(() => PodSummarySchema.parse(minimal)).not.toThrow();
  });
});

describe("CameraSchema", () => {
  const feed = {
    id: "a",
    sensorId: "checkout-1-a",
    source: "checkout-wide.ts",
    rtspUrl: "rtsp://34.56.78.90:8554/checkout-1-a",
    vstRegistered: true,
    replayReady: true,
  };
  const camera = {
    id: "checkout-1",
    role: "checkout" as const,
    description: "Main checkout",
    feeds: [feed],
  };

  it("parses valid camera", () => {
    expect(CameraSchema.parse(camera)).toEqual(camera);
  });

  it("roundtrips", () => {
    roundtrip(CameraSchema, camera);
  });

  it("rejects camera with empty feeds array", () => {
    expect(() => CameraSchema.parse({ ...camera, feeds: [] })).toThrow();
  });

  it("rejects invalid role", () => {
    expect(() => CameraSchema.parse({ ...camera, role: "office" })).toThrow();
  });
});

describe("ScenarioSchema", () => {
  const valid = {
    id: "theft",
    name: "Shoplifting Detection",
    severity: "high" as const,
    channels: ["ui", "slack"] as ["ui", "slack"],
    sensorFilter: "checkout-*",
    keywords: ["conceal", "pocket"],
    enabled: true,
  };

  it("parses valid scenario", () => {
    expect(ScenarioSchema.parse(valid)).toEqual(valid);
  });

  it("roundtrips", () => {
    roundtrip(ScenarioSchema, valid);
  });

  it("rejects invalid severity", () => {
    expect(() => ScenarioSchema.parse({ ...valid, severity: "critical" })).toThrow();
  });

  it("rejects invalid channel", () => {
    expect(() => ScenarioSchema.parse({ ...valid, channels: ["sms"] })).toThrow();
  });
});

describe("DemoProfileSchema", () => {
  const feed = {
    id: "a",
    sensorId: "checkout-1-a",
    source: "checkout-wide.ts",
    rtspUrl: "rtsp://34.56.78.90:8554/checkout-1-a",
    vstRegistered: true,
    replayReady: true,
  };
  const valid = {
    name: "pyramid-jun-8",
    savedAt: "2026-04-22T08:00:00.000Z",
    savedBy: "console-operator",
    scenarios: [],
    vlmPrompt: "You are a retail security VLM.",
    cameras: [{ id: "checkout-1", role: "checkout" as const, feeds: [feed] }],
    rtviTuning: { maxNumSeqs: 4, kvCachePct: 0.8 },
    alertTuning: { cooldownSeconds: 300 },
    nimModel: "cosmos-reason2-8b",
  };

  it("parses valid profile", () => {
    expect(DemoProfileSchema.parse(valid)).toEqual(valid);
  });

  it("roundtrips", () => {
    roundtrip(DemoProfileSchema, valid);
  });

  it("rejects missing name", () => {
    expect(() => DemoProfileSchema.parse({ ...valid, name: "" })).toThrow();
  });
});

describe("OverviewSnapshotSchema", () => {
  const valid = {
    takenAt: "2026-04-22T10:00:00.000Z",
    namespaces: { vst: { total: 3, ready: 3, failed: 0 } },
    nim: { ready: true, warmupPct: 100, queueDepth: 0 },
    gpus: [],
    kafka: { "vision-llm-responses": { topic: "vision-llm-responses", retainedMsgs: 2 } },
    s3: { bucket: "nvidia-vss-video", objectCount: 4820, bytesTotal: 107374182400, growth24h: 1073741824, bytesCapacity: 1099511627776 },
    cameraSim: { instanceState: "running" as const, pathsReady: 4, pathsTotal: 4 },
  };

  it("parses valid overview snapshot", () => {
    expect(OverviewSnapshotSchema.parse(valid)).toEqual(valid);
  });

  it("roundtrips", () => {
    roundtrip(OverviewSnapshotSchema, valid);
  });
});

describe("ModelCardSchema", () => {
  const valid = {
    image: "nvcr.io/nim/nvidia/cosmos-reason2-8b:1.6.0",
    displayName: "Cosmos Reason 2 8B",
    parameterCount: "8.0 B",
    precision: "BF16",
    minGpuMemoryGiB: 56,
    warmupSeconds: 1680,
    l4Validated: false,
    l40sValidated: true,
    strengths: ["Strong reasoning"],
    limitations: ["No audio"],
    scalityUseCase: "Primary live VLM",
  };

  it("parses valid model card", () => {
    expect(ModelCardSchema.parse(valid)).toEqual(valid);
  });

  it("roundtrips", () => {
    roundtrip(ModelCardSchema, valid);
  });
});

describe("GpuStateSchema", () => {
  const valid = {
    index: 0,
    name: "NVIDIA L40S",
    memoryUsedMiB: 22528,
    memoryTotalMiB: 49152,
    utilGpu: 42,
    utilMem: 46,
    tempC: 58,
    powerW: 180,
    processes: [{ pid: 1234, name: "nim", memMiB: 18432 }],
  };

  it("parses valid GPU state", () => {
    expect(GpuStateSchema.parse(valid)).toEqual(valid);
  });

  it("roundtrips", () => {
    roundtrip(GpuStateSchema, valid);
  });
});

describe("AuditLogEntrySchema", () => {
  const valid = {
    id: "550e8400-e29b-41d4-a716-446655440099",
    ts: "2026-04-22T10:00:00.000Z",
    operator: "console-operator",
    action: "sg.add",
    target: "203.0.113.0/29",
    detailsJson: '{"label":"Head office"}',
  };

  it("parses valid audit log entry", () => {
    expect(AuditLogEntrySchema.parse(valid)).toEqual(valid);
  });

  it("roundtrips", () => {
    roundtrip(AuditLogEntrySchema, valid);
  });
});

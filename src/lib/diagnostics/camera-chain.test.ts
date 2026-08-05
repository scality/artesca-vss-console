import { describe, it, expect } from "vitest";
import { buildCameraChain, type ScenarioBinding } from "./camera-chain";

// Each case below is a failure that actually shipped to the Pyramid showroom
// and was invisible on the Cameras page — the point of the chain is that the
// verdict names the cause instead of every symptom reading "NOT RECORDING".

const healthyScenario: ScenarioBinding[] = [
  { id: "self-checkout-theft", enabled: true, sensorFilter: "cam-a,cam-b" },
];

function base(overrides: Partial<Parameters<typeof buildCameraChain>[0]> = {}) {
  return buildCameraChain({
    camera: { id: "cam-a", rtspUrl: "rtsp://10.0.0.1:8556/video0" },
    registered: true,
    streamId: "11111111-2222-3333-4444-555555555555",
    recording: "recording",
    rules: [{ sensor_name: "cam-a", alert_type: "self-checkout-theft", model: "vlm-1", id: "r1" }],
    liveModel: "vlm-1",
    scenarios: healthyScenario,
    storageOk: true,
    ...overrides,
  });
}

describe("buildCameraChain", () => {
  it("reports no verdict when every link holds", () => {
    const chain = base();
    expect(chain.verdict).toBeUndefined();
    expect(chain.steps.every((s) => s.state === "ok")).toBe(true);
  });

  it("blames object storage, not the camera, when the recorder cannot write", () => {
    const chain = base({
      storageOk: false,
      storageReason: "recorder S3 endpoint does not resolve: s3.artesca.isv-lab.local",
      recording: "not-recording",
    });
    const rec = chain.steps.find((s) => s.id === "recording");
    expect(rec?.state).toBe("fail");
    expect(rec?.detail ?? "").toMatch(/does not resolve/);
    // The verdict must point at storage — five cameras failing this way share
    // one root cause and must not read as five camera faults.
    expect(chain.verdict?.reason ?? "").toMatch(/does not resolve/);
  });

  it("flags a rule naming a model the VLM does not serve", () => {
    const chain = base({
      rules: [{ sensor_name: "cam-a", alert_type: "theft", model: "resolved-live-from-vlm", id: "r1" }],
      liveModel: "nim_nvidia_cosmos3-nano-reasoner_bf16-final",
    });
    const rule = chain.steps.find((s) => s.id === "rule");
    expect(rule?.state).toBe("fail");
    expect(rule?.detail ?? "").toMatch(/resolved-live-from-vlm/);
  });

  it("flags duplicate rules as wasted GPU rather than healthy", () => {
    const chain = base({
      rules: [
        { sensor_name: "cam-a", alert_type: "theft", model: "vlm-1", id: "r1" },
        { sensor_name: "cam-a", alert_type: "theft", model: "vlm-1", id: "r2" },
      ],
    });
    const rule = chain.steps.find((s) => s.id === "rule");
    expect(rule?.state).toBe("warn");
    expect(rule?.detail ?? "").toMatch(/2 duplicate rules/);
  });

  it("marks downstream steps blocked when the sensor is not registered", () => {
    const chain = base({ registered: false, streamId: undefined });
    expect(chain.steps.find((s) => s.id === "sensor")?.state).toBe("fail");
    expect(chain.steps.find((s) => s.id === "stream")?.state).toBe("blocked");
    expect(chain.steps.find((s) => s.id === "recording")?.state).toBe("blocked");
    // Verdict is the ROOT cause, not the blocked consequences.
    expect(chain.verdict?.reason ?? "").toMatch(/no VST sensor/);
  });

  it("warns when no enabled scenario targets the camera", () => {
    const chain = base({
      scenarios: [
        { id: "theft", enabled: false, sensorFilter: "cam-a" },
        { id: "restock", enabled: true, sensorFilter: "cam-z" },
      ],
    });
    const sc = chain.steps.find((s) => s.id === "scenario");
    expect(sc?.state).toBe("warn");
    expect(sc?.detail ?? "").toMatch(/no enabled scenario/);
  });

  it("treats an empty sensor filter as covering every camera", () => {
    const chain = base({ scenarios: [{ id: "all", enabled: true, sensorFilter: "" }] });
    expect(chain.steps.find((s) => s.id === "scenario")?.state).toBe("ok");
  });

  it("does not report not-recording when the storage probe is unreachable", () => {
    const chain = base({ recording: "unknown" });
    expect(chain.steps.find((s) => s.id === "recording")?.state).toBe("unknown");
    expect(chain.verdict).toBeUndefined();
  });
});

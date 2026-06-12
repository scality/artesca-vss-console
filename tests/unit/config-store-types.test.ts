import { describe, it, expect } from "vitest";
import type { ConfigStore, ReconcileStatus } from "@/lib/config-store/types";
import { emptyStatus } from "@/lib/config-store/types";

describe("config-store types", () => {
  it("emptyStatus produces a well-formed zero status", () => {
    const s: ReconcileStatus = emptyStatus("v-test", "2026-06-12T00:00:00.000Z");
    expect(s.agentVersion).toBe("v-test");
    expect(s.lastRunAt).toBe("2026-06-12T00:00:00.000Z");
    expect(s.applied).toEqual({ camerasAdded: 0, camerasPruned: 0 });
    expect(s.drift).toEqual([]);
    expect(s.errors).toEqual([]);
  });

  it("ConfigStore is structurally implementable", () => {
    const stub: ConfigStore = {
      readCameras: async () => [],
      writeCameras: async () => {},
      readStatus: async () => null,
      writeStatus: async () => {},
    };
    expect(typeof stub.readCameras).toBe("function");
  });
});

import { describe, it, expect } from "vitest";
import type { ConfigStore, ReconcileStatus } from "@/lib/config-store/types";
import { emptyStatus } from "@/lib/config-store/types";

describe("config-store types", () => {
  it("emptyStatus produces a well-formed zero status", () => {
    const s: ReconcileStatus = emptyStatus("v-test", "2026-06-12T00:00:00.000Z");
    expect(s.agentVersion).toBe("v-test");
    expect(s.lastRunAt).toBe("2026-06-12T00:00:00.000Z");
    expect(s.applied).toEqual({ camerasAdded: 0, camerasPruned: 0, promptUpdated: false, scenariosUpdated: false, realtimeApplied: 0 });
    expect(s.drift).toEqual([]);
    expect(s.errors).toEqual([]);
  });

  it("ConfigStore is structurally implementable", () => {
    const stub: ConfigStore = {
      readCameras: async () => [],
      writeCameras: async () => {},
      upsertCamera: async () => {},
      deleteCamera: async () => {},
      readStatus: async () => null,
      writeStatus: async () => {},
      readPrompt: async () => null,
      writePrompt: async () => {},
      readScenarios: async () => [],
      writeScenarios: async () => {},
      readPromptSets: async () => [],
      upsertPromptSet: async () => {},
      deletePromptSet: async () => {},
      readActivePromptId: async () => null,
      setActivePromptId: async () => {},
    };
    expect(typeof stub.readCameras).toBe("function");
  });
});

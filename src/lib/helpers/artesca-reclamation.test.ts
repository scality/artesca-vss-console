import { describe, it, expect, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/helpers/prometheus", () => ({ promQuery: vi.fn() }));
import { classifyReclamation } from "./artesca-reclamation";

const base = {
  reclaimableBytes: 0, awaitingRelocate: 0, awaitingRetry: 0, paused: 0,
  reclaimedLastHourBytes: 0, sweeperPassesLastHour: 2,
};

describe("classifyReclamation", () => {
  it("is unknown, not idle, when the reclaimable gauge is absent", () => {
    expect(classifyReclamation({ ...base, reclaimableBytes: null }).state).toBe("unknown");
  });
  it("is idle with nothing pending", () => {
    expect(classifyReclamation(base).state).toBe("idle");
  });
  it("is working while space is pending and the sweeper is passing (the 09-09 spike)", () => {
    const v = classifyReclamation({ ...base, reclaimableBytes: 5.48e12, awaitingRelocate: 120, reclaimedLastHourBytes: 3e11 });
    expect(v.state).toBe("working");
  });
  it("is stuck when relocation is paused", () => {
    expect(classifyReclamation({ ...base, reclaimableBytes: 5e12, paused: 1 }).state).toBe("stuck");
  });
  it("is stuck when space is pending and nothing passed or reclaimed in an hour", () => {
    const v = classifyReclamation({ ...base, reclaimableBytes: 5e12, sweeperPassesLastHour: 0, reclaimedLastHourBytes: 0 });
    expect(v.state).toBe("stuck");
  });
  it("is stuck when retries queue and the sweeper is silent", () => {
    const v = classifyReclamation({ ...base, awaitingRetry: 7, sweeperPassesLastHour: 0, reclaimedLastHourBytes: 0 });
    expect(v.state).toBe("stuck");
  });
  it("is unknown when space is pending but the heartbeat counters are absent", () => {
    const v = classifyReclamation({ ...base, reclaimableBytes: 5e12, sweeperPassesLastHour: null, reclaimedLastHourBytes: null });
    expect(v.state).toBe("unknown");
  });
});

import { describe, it, expect } from "vitest";
import { RtviTuningSchema } from "./schema";

describe("RtviTuningSchema", () => {
  it("accepts maxGenerationTokens within range", () => {
    const r = RtviTuningSchema.safeParse({ maxGenerationTokens: 256 });
    expect(r.success).toBe(true);
  });

  it("rejects maxGenerationTokens above 16384", () => {
    const r = RtviTuningSchema.safeParse({ maxGenerationTokens: 20000 });
    expect(r.success).toBe(false);
  });

  it("rejects an empty patch", () => {
    const r = RtviTuningSchema.safeParse({});
    expect(r.success).toBe(false);
  });
});

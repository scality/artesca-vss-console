import { describe, it, expect } from "vitest";
import { z } from "zod";
import { ModelCardSchema } from "@/lib/schemas";
import catalog from "../../src/data/model-catalog.json";

describe("model-catalog.json", () => {
  it("contains at least one model card", () => {
    expect(Array.isArray(catalog)).toBe(true);
    expect((catalog as unknown[]).length).toBeGreaterThan(0);
  });

  it("every entry parses as ModelCard", () => {
    const ArraySchema = z.array(ModelCardSchema);
    expect(() => ArraySchema.parse(catalog)).not.toThrow();
  });

  it("has cosmos-reason2-8b as first entry (primary model)", () => {
    const first = catalog[0] as { image: string };
    expect(first.image).toContain("cosmos-reason2-8b");
  });

  it("has at least one l4Validated model", () => {
    const any = (catalog as Array<{ l4Validated: boolean }>).some((c) => c.l4Validated);
    expect(any).toBe(true);
  });

  it("all models have required fields", () => {
    for (const card of catalog as Array<Record<string, unknown>>) {
      expect(typeof card.image).toBe("string");
      expect(typeof card.displayName).toBe("string");
      expect(typeof card.parameterCount).toBe("string");
      expect(typeof card.warmupSeconds).toBe("number");
      expect(Array.isArray(card.strengths)).toBe(true);
      expect(Array.isArray(card.limitations)).toBe(true);
    }
  });
});

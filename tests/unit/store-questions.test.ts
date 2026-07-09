import { describe, it, expect } from "vitest";
import { parseStoreQuestion, categoryLabel } from "@/lib/store-questions";

describe("parseStoreQuestion", () => {
  it("maps theft wording → self-checkout-theft + today window", () => {
    expect(parseStoreQuestion("how many theft events today?")).toMatchObject({
      category: "self-checkout-theft",
      hours: 24,
      windowLabel: "in the last 24h",
    });
  });

  it("maps forklift/safety → forklift-safety + week window", () => {
    expect(parseStoreQuestion("forklift safety incidents this week")).toMatchObject({
      category: "forklift-safety",
      hours: 168,
    });
  });

  it("maps restock/shelf wording → shelf-restock", () => {
    expect(parseStoreQuestion("which shelves need restocking?").category).toBe("shelf-restock");
    expect(parseStoreQuestion("any empty shelves?").category).toBe("shelf-restock");
  });

  it("maps intrusion wording → intrusion", () => {
    expect(parseStoreQuestion("were there any intruders after hours?").category).toBe("intrusion");
  });

  it("extracts a known camera name", () => {
    expect(parseStoreQuestion("what happened on dock-1 this month?")).toMatchObject({
      camera: "dock-1",
      hours: 720,
    });
  });

  it("defaults to all-time when no timeframe is given", () => {
    const r = parseStoreQuestion("how many forklift incidents");
    expect(r.hours).toBeUndefined();
    expect(r.windowLabel).toBe("all time");
  });

  it("returns no category for an unmatched question", () => {
    expect(parseStoreQuestion("what is the weather?").category).toBeUndefined();
  });

  it("categoryLabel humanizes slugs", () => {
    expect(categoryLabel("self-checkout-theft")).toBe("self checkout theft");
  });
});

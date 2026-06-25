import { describe, it, expect } from "vitest";
import { classifyListState } from "./list-state";

describe("classifyListState", () => {
  it("config-store warning forces error even with items", () => {
    expect(classifyListState(["config store unavailable: boom"], 0)).toBe("error");
    expect(classifyListState(["config store unavailable: boom"], 3)).toBe("error");
  });
  it("empty list with no config warning is empty", () => {
    expect(classifyListState([], 0)).toBe("empty");
    expect(classifyListState(undefined, 0)).toBe("empty");
    expect(classifyListState(["GCS unavailable — serving from local fallback"], 0)).toBe("empty");
  });
  it("non-empty list is list", () => {
    expect(classifyListState([], 2)).toBe("list");
    expect(classifyListState(undefined, 1)).toBe("list");
  });
});

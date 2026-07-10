import { describe, it, expect } from "vitest";
import { vlmDisplayFromImage } from "./live-vlm";

describe("vlmDisplayFromImage", () => {
  it("names the VSS RT-VLM image with its tag", () => {
    const r = vlmDisplayFromImage("nvcr.io/nvidia/vss-core/vss-rt-vlm:3.2.0");
    expect(r).toEqual({
      image: "nvcr.io/nvidia/vss-core/vss-rt-vlm:3.2.0",
      displayName: "VSS RT-VLM 3.2.0",
      tag: "3.2.0",
    });
  });

  it("title-cases an arbitrary NIM repo and appends the tag", () => {
    const r = vlmDisplayFromImage("nvcr.io/nim/nvidia/cosmos-reason2-8b:1.6.0");
    expect(r.tag).toBe("1.6.0");
    expect(r.displayName).toBe("Cosmos Reason2 8b 1.6.0");
  });

  it("handles an image with no tag", () => {
    const r = vlmDisplayFromImage("foo/bar");
    expect(r).toEqual({ image: "foo/bar", displayName: "Bar", tag: "" });
  });

  it("trims surrounding whitespace", () => {
    const r = vlmDisplayFromImage("  nvcr.io/nvidia/vss-core/vss-rt-vlm:3.2.0  ");
    expect(r.image).toBe("nvcr.io/nvidia/vss-core/vss-rt-vlm:3.2.0");
    expect(r.displayName).toBe("VSS RT-VLM 3.2.0");
  });
});

import { describe, it, expect } from "vitest";
import { vlmDisplayFromImage, prettyModelName, modelIdFromEnv } from "./live-vlm";

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

describe("prettyModelName", () => {
  it("formats cosmos-reason2-8b", () => {
    expect(prettyModelName("cosmos-reason2-8b")).toBe("Cosmos Reason 2 8B");
  });
  it("formats nvila-lite-2b", () => {
    expect(prettyModelName("nvila-lite-2b")).toBe("Nvila Lite 2B");
  });
});

describe("modelIdFromEnv", () => {
  it("extracts the id from an ngc MODEL_PATH", () => {
    expect(modelIdFromEnv({ MODEL_PATH: "ngc:nim/nvidia/cosmos-reason2-8b:hf-1208" })).toBe(
      "cosmos-reason2-8b",
    );
  });
  it("falls back to VLM_MODEL_TO_USE when MODEL_PATH is absent", () => {
    expect(modelIdFromEnv({ VLM_MODEL_TO_USE: "cosmos-reason2" })).toBe("cosmos-reason2");
  });
  it("returns empty string when neither is set", () => {
    expect(modelIdFromEnv({})).toBe("");
  });
});

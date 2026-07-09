import { describe, it, expect } from "vitest";
import { parseVoiceList } from "@/lib/tts-voices";

describe("parseVoiceList", () => {
  it("handles an array of strings", () => {
    expect(parseVoiceList(["Aria", "Ryan"])).toEqual(["Aria", "Ryan"]);
  });

  it("handles an array of objects (name / voice_name / voice)", () => {
    expect(
      parseVoiceList([{ name: "Aria" }, { voice_name: "Ryan" }, { voice: "Leo" }]),
    ).toEqual(["Aria", "Ryan", "Leo"]);
  });

  it("handles a { voices: [...] } wrapper", () => {
    expect(parseVoiceList({ voices: [{ name: "Aria" }, "Ryan"] })).toEqual(["Aria", "Ryan"]);
  });

  it("flattens a { <lang>: [...] } map", () => {
    expect(
      parseVoiceList({
        "en-US": ["Magpie-Multilingual.EN-US.Aria", { name: "Magpie-Multilingual.EN-US.Ryan" }],
        "de-DE": ["Magpie-Multilingual.DE-DE.Klaus"],
      }),
    ).toEqual([
      "Magpie-Multilingual.EN-US.Aria",
      "Magpie-Multilingual.EN-US.Ryan",
      "Magpie-Multilingual.DE-DE.Klaus",
    ]);
  });

  it("dedupes and drops empties", () => {
    expect(parseVoiceList(["Aria", "Aria", "", "  ", "Ryan"])).toEqual(["Aria", "Ryan"]);
  });

  it("returns [] for null / unexpected input", () => {
    expect(parseVoiceList(null)).toEqual([]);
    expect(parseVoiceList(42)).toEqual([]);
    expect(parseVoiceList({})).toEqual([]);
  });
});

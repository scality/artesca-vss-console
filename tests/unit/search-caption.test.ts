import { describe, it, expect } from "vitest";
import { cleanCaption } from "@/lib/search-caption";

describe("cleanCaption", () => {
  it("strips a single leading filler opener", () => {
    expect(cleanCaption("Okay, the person is concealing an item.")).toBe(
      "The person is concealing an item.",
    );
  });

  it("peels stacked openers", () => {
    expect(
      cleanCaption("Okay. Let me analyze the frame. A forklift is tipping over."),
    ).toBe("A forklift is tipping over.");
  });

  it("strips 'Looking at the scene,'", () => {
    expect(cleanCaption("Looking at the scene, two people are fighting.")).toBe(
      "Two people are fighting.",
    );
  });

  it("collapses whitespace and markup", () => {
    expect(cleanCaption("A   person\n\nleaves  <b>the</b> aisle.")).toBe(
      "A person leaves the aisle.",
    );
  });

  it("capitalizes the first surviving character", () => {
    expect(cleanCaption("so a shelf collapsed")).toBe("A shelf collapsed");
  });

  it("truncates at a sentence boundary within budget", () => {
    const long =
      "A forklift moves fast. It nearly hits a worker near the pallets who is not paying attention to the moving vehicle at all.";
    const out = cleanCaption(long, 40);
    expect(out).toBe("A forklift moves fast.");
  });

  it("ellipsizes when no sentence boundary is available", () => {
    const long = "A".repeat(300);
    const out = cleanCaption(long, 50);
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(51);
  });

  it("never returns empty when the whole caption is filler", () => {
    // If stripping would empty the string, the last non-empty state is kept.
    expect(cleanCaption("Okay.")).toBe("Okay.");
  });

  it("handles empty / nullish input", () => {
    expect(cleanCaption("")).toBe("");
    // @ts-expect-error — exercise the runtime nullish guard
    expect(cleanCaption(undefined)).toBe("");
  });

  it("leaves an already-clean caption unchanged (aside from cap)", () => {
    const c = "Forklift operating unsafely near stacked pallets.";
    expect(cleanCaption(c)).toBe(c);
  });

  it("peels the 'The user provided a … description of' meta-opener", () => {
    expect(
      cleanCaption(
        "The user provided a detailed description of a warehouse scene with a forklift and some safety issues.",
      ),
    ).toBe("A warehouse scene with a forklift and some safety issues.");
  });

  it("drops a leading 'The user …' meta sentence when content follows", () => {
    expect(
      cleanCaption(
        "The user provided a description and asked to identify safety issues. A forklift is tipping near a worker.",
      ),
    ).toBe("A forklift is tipping near a worker.");
  });

  it("keeps a bare 'The user …' caption when there is no following sentence", () => {
    const c = "The user asked to review the forklift footage.";
    expect(cleanCaption(c)).toBe(c);
  });

  it("peels a 'First, I need to …' chain-of-thought opener", () => {
    expect(
      cleanCaption(
        "First, I need to parse the video carefully. The forklift is moving between stacks of pallets.",
      ),
    ).toBe("The forklift is moving between stacks of pallets.");
  });

  it("peels a leading 'I need to focus on …' opener", () => {
    expect(
      cleanCaption(
        "I need to focus on the key elements. A worker crosses the forklift path.",
      ),
    ).toBe("A worker crosses the forklift path.");
  });

  it("keeps 'First, the video shows …' (not a meta opener)", () => {
    const c = "First, the video shows a forklift operator moving pallets.";
    expect(cleanCaption(c)).toBe(c);
  });
});

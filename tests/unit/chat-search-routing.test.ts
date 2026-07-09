import { describe, it, expect } from "vitest";
import {
  detectSearchIntent,
  buildSearchReplyMarkdown,
  displayCaption,
  type SearchHit,
} from "@/lib/chat-search-routing";

describe("detectSearchIntent", () => {
  it("matches the explicit 'search:' prefix and strips it", () => {
    expect(detectSearchIntent("search: forklifts near pallets")).toEqual({
      query: "forklifts near pallets",
      sensor: undefined,
    });
  });

  it("matches the explicit 'find:' prefix", () => {
    expect(detectSearchIntent("find: theft at checkout")).toEqual({
      query: "theft at checkout",
      sensor: undefined,
    });
  });

  it("matches natural 'find every … incident'", () => {
    const r = detectSearchIntent("find every forklift incident");
    expect(r).not.toBeNull();
    expect(r?.query).toBe("find every forklift incident");
  });

  it("matches 'show me all clips of …'", () => {
    expect(detectSearchIntent("show me all people running")?.query).toBe(
      "show me all people running",
    );
  });

  it("matches 'search the footage for …'", () => {
    expect(detectSearchIntent("search the footage for spills")).not.toBeNull();
  });

  it("matches 'any clips of someone falling'", () => {
    expect(detectSearchIntent("any clips of someone falling")).not.toBeNull();
  });

  it("does NOT hijack an ordinary agent question", () => {
    expect(detectSearchIntent("how many cameras are streaming?")).toBeNull();
    expect(detectSearchIntent("what happened on dock-1 recently?")).toBeNull();
    expect(detectSearchIntent("give me a summary of the last hour")).toBeNull();
  });

  it("parses the (sensor: X) scope suffix out of the query", () => {
    expect(
      detectSearchIntent("find every forklift incident (sensor: dock-1)"),
    ).toEqual({ query: "find every forklift incident", sensor: "dock-1" });
  });

  it("applies the sensor suffix to explicit-prefix queries too", () => {
    expect(detectSearchIntent("search: spills (sensor: aisle-3)")).toEqual({
      query: "spills",
      sensor: "aisle-3",
    });
  });

  it("returns null for empty / whitespace / bare prefix", () => {
    expect(detectSearchIntent("")).toBeNull();
    expect(detectSearchIntent("   ")).toBeNull();
    expect(detectSearchIntent("search:")).toBeNull();
  });
});

describe("buildSearchReplyMarkdown", () => {
  const hit = (over: Partial<SearchHit>): SearchHit => ({
    camera: "dock-1",
    ts: new Date(Date.now() - 60_000).toISOString(),
    category: "forklift-safety",
    caption: "Okay, a forklift is operating unsafely near stacked pallets.",
    incidentId: "abc",
    score: 0.88,
    ...over,
  });

  it("renders a header with the match count and query", () => {
    const md = buildSearchReplyMarkdown("forklifts", [hit({})]);
    expect(md).toContain("Found **1** matching clip");
    expect(md).toContain('_"forklifts"_');
  });

  it("emits a thumbnail image linked to the Search page for each hit", () => {
    const md = buildSearchReplyMarkdown("forklifts", [hit({})]);
    expect(md).toContain("![dock-1](/api/clips/dock-1/");
    expect(md).toContain("/thumb)](/search?q=forklifts)");
  });

  it("cleans the displayed caption (drops leading filler)", () => {
    const md = buildSearchReplyMarkdown("forklifts", [hit({})]);
    expect(md).toContain("A forklift is operating unsafely near stacked pallets.");
    expect(md).not.toContain("Okay, a forklift");
  });

  it("prefers the worker summary over the raw caption when present", () => {
    const md = buildSearchReplyMarkdown("forklifts", [
      hit({ summary: "Forklift lifting an unstable load near a worker" }),
    ]);
    expect(md).toContain("Forklift lifting an unstable load near a worker");
    expect(md).not.toContain("Okay, a forklift");
  });

  it("caps at 5 hits and notes the remainder", () => {
    const hits = Array.from({ length: 8 }, (_, i) => hit({ incidentId: `i${i}` }));
    const md = buildSearchReplyMarkdown("q", hits);
    const shown = (md.match(/!\[dock-1\]/g) ?? []).length;
    expect(shown).toBe(5);
    expect(md).toContain("Showing the top 5");
    expect(md).toContain("all 8");
  });

  it("renders a helpful empty state with a Search-page link", () => {
    const md = buildSearchReplyMarkdown("unicorns", []);
    expect(md).toContain("no matching clips");
    expect(md).toContain("[Search page](/search?q=unicorns)");
  });

  it("omits the age suffix when the timestamp is unparseable", () => {
    const md = buildSearchReplyMarkdown("q", [hit({ ts: "not-a-date" })]);
    expect(md).not.toContain("ago");
  });
});

describe("displayCaption", () => {
  it("prefers a non-empty summary verbatim", () => {
    expect(
      displayCaption({ summary: "Forklift near a worker", caption: "Okay, verbose reasoning…" }),
    ).toBe("Forklift near a worker");
  });

  it("falls back to a cleaned caption when summary is empty/absent", () => {
    expect(
      displayCaption({ summary: "  ", caption: "Okay, a spill blocks aisle 3." }),
    ).toBe("A spill blocks aisle 3.");
    expect(displayCaption({ caption: "Okay, a spill blocks aisle 3." })).toBe(
      "A spill blocks aisle 3.",
    );
  });

  it("strips a trailing dangling tail from a stored summary", () => {
    expect(
      displayCaption({
        summary: "Most shelves in the supermarket aisle appear to be empty and in",
        caption: "raw",
      }),
    ).toBe("Most shelves in the supermarket aisle appear to be empty");
  });
});

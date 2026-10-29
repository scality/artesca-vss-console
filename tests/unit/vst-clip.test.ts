// Clip window for an incident with a chunk span (timestamp = chunk start,
// end = chunk end): the VST download window and the PVC cache key.

import { describe, it, expect, vi } from "vitest";

// In-memory clip cache: cache dir names carry ISO colons, which Windows paths reject.
const { files } = vi.hoisted(() => ({ files: new Map<string, string>() }));
vi.mock("fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("fs")>();
  return {
    ...real,
    statSync: ((p: string) =>
      files.has(String(p)) ? { mtimeMs: Date.now() } : real.statSync(p)) as typeof real.statSync,
    readFileSync: ((p: string, enc?: BufferEncoding) =>
      files.get(String(p)) ?? real.readFileSync(p, enc)) as typeof real.readFileSync,
  };
});

const TS = "2026-01-01T12:00:00.000Z";
const END = "2026-01-01T12:00:10.000Z";

function windowOf(url: string): { start: string | null; end: string | null } {
  const q = new URL(url).searchParams;
  return { start: q.get("startTime"), end: q.get("endTime") };
}

describe("buildVstClipUrl", () => {
  it("spans [ts - 2 s, end + 2 s] when the incident has an end", async () => {
    const { buildVstClipUrl } = await import("@/lib/streams/vst-clip");
    expect(windowOf(buildVstClipUrl("s1", TS, END))).toEqual({
      start: "2026-01-01T11:59:58.000Z",
      end: "2026-01-01T12:00:12.000Z",
    });
  });

  it("caps the span at 60 s", async () => {
    const { buildVstClipUrl } = await import("@/lib/streams/vst-clip");
    expect(windowOf(buildVstClipUrl("s1", TS, "2026-01-01T12:05:00.000Z"))).toEqual({
      start: "2026-01-01T11:59:58.000Z",
      end: "2026-01-01T12:00:58.000Z",
    });
  });

  it.each([undefined, null, "", "not-a-date", TS, "2026-01-01T11:59:00.000Z"])(
    "keeps the ±5 s window for end=%s",
    async (end) => {
      const { buildVstClipUrl } = await import("@/lib/streams/vst-clip");
      expect(windowOf(buildVstClipUrl("s1", TS, end))).toEqual({
        start: "2026-01-01T11:59:55.000Z",
        end: "2026-01-01T12:00:05.000Z",
      });
    },
  );
});

describe("serveClipPlaylist with an end", () => {
  it("does not serve the cached ±5 s clip, and its segments carry the end", async () => {
    const { cachePath } = await import("@/lib/streams/clip-cache");
    const { clipWindow } = await import("@/lib/streams/vst-clip");
    const { serveClipPlaylist } = await import("@/lib/streams/serve-clip");

    // The ±5 s clip of the same ts is already cached.
    files.set(cachePath("cam-a", TS, "index.m3u8"), "#EXTM3U\nold.ts\n");
    const spanKey = clipWindow(TS, END).key;
    expect(spanKey).not.toBe(TS);
    files.set(
      cachePath("cam-a", spanKey, "index.m3u8"),
      "#EXTM3U\n#EXTINF:2.0,\nseg000.ts\n#EXT-X-ENDLIST\n",
    );

    const res = await serveClipPlaylist("cam-a", TS, END);
    expect(await res.text()).toBe(
      `#EXTM3U\n#EXTINF:2.0,\nseg000.ts?end=${encodeURIComponent(END)}\n#EXT-X-ENDLIST\n`,
    );
    expect(await (await serveClipPlaylist("cam-a", TS)).text()).toBe("#EXTM3U\nold.ts\n");
  });
});

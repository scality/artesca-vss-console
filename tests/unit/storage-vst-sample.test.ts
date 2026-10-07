// How the VST storage panel picks the objects it calls "recent".
//
// It used to be one `ListObjectsV2({MaxKeys: 500})` over the whole bucket. S3 lists
// lexicographically and keys are `<sensor-uuid>/YYYY/MM/DD/HH/<epoch>.mkv`, so that
// window only ever contained the sensors whose UUID sorts first — then sorted those
// by LastModified and presented them as recent.
//
// Measured on pyramid-showroom 2026-08-14: 74 sensor prefixes, ≥300k objects, and the
// 500-key window fell entirely inside `01a8a42c-…`, a sensor deleted on Aug 6. The
// panel showed 190-hour-old segments from a camera that no longer existed while all
// five live cameras were writing a 36 MB segment every minute. The size histogram and
// the duration percentiles were computed over the same dead prefix.
import { describe, it, expect } from "vitest";
import {
  listAllPages,
  newestChildPrefix,
  sampleNewestBySensor,
} from "@/lib/storage/vst-sample";
import type { S3Client } from "@aws-sdk/client-s3";

/** In-memory S3 that implements just the ListObjectsV2 semantics under test:
 *  Prefix filtering, and Delimiter rolling the next path segment into
 *  CommonPrefixes. Keys map to a size so the objects are distinguishable. */
function fakeS3(keys: Record<string, number>): { s3: S3Client; calls: number } {
  const state = { calls: 0 };
  const s3 = {
    async send(cmd: { input: { Prefix?: string; Delimiter?: string } }) {
      state.calls++;
      const { Prefix = "", Delimiter } = cmd.input;
      const matching = Object.keys(keys).filter((k) => k.startsWith(Prefix));
      if (!Delimiter) {
        return {
          Contents: matching.map((k) => ({
            Key: k,
            Size: keys[k],
            LastModified: new Date(keys[k] * 1000),
          })),
        };
      }
      const commonPrefixes = new Set<string>();
      const contents: { Key: string; Size: number; LastModified: Date }[] = [];
      for (const k of matching) {
        const rest = k.slice(Prefix.length);
        const idx = rest.indexOf(Delimiter);
        if (idx === -1) {
          contents.push({ Key: k, Size: keys[k], LastModified: new Date(keys[k] * 1000) });
        } else {
          commonPrefixes.add(Prefix + rest.slice(0, idx + 1));
        }
      }
      return {
        Contents: contents,
        CommonPrefixes: [...commonPrefixes].map((p) => ({ Prefix: p })),
      };
    },
  } as unknown as S3Client;
  return { s3, calls: state.calls };
}

describe("newestChildPrefix", () => {
  it("orders unpadded hour directories numerically, not lexicographically", async () => {
    // The reason this function exists. VST writes hours WITHOUT zero padding, so a
    // string max picks "9" over "10" and reports the 9am recordings as the newest of
    // a day that ran to 10am — an hour-old panel that looks current.
    const { s3 } = fakeS3({
      "cam/2026/08/14/9/a.mkv": 1,
      "cam/2026/08/14/10/b.mkv": 2,
      "cam/2026/08/14/8/c.mkv": 3,
    });
    expect(await newestChildPrefix(s3, "b", "cam/2026/08/14/")).toBe("cam/2026/08/14/10/");
  });

  it("orders zero-padded segments correctly too", async () => {
    const { s3 } = fakeS3({
      "cam/2026/08/x.mkv": 1,
      "cam/2026/09/y.mkv": 2,
      "cam/2026/10/z.mkv": 3,
    });
    expect(await newestChildPrefix(s3, "b", "cam/2026/")).toBe("cam/2026/10/");
  });

  it("falls back to lexicographic order for non-numeric segments", async () => {
    // Nothing writes these today, but the function must not return undefined-ish
    // nonsense if the layout ever gains a named level.
    const { s3 } = fakeS3({ "cam/alpha/x.mkv": 1, "cam/beta/y.mkv": 2 });
    expect(await newestChildPrefix(s3, "b", "cam/")).toBe("cam/beta/");
  });

  it("returns null when there are no child directories", async () => {
    const { s3 } = fakeS3({ "cam/loose.mkv": 1 });
    expect(await newestChildPrefix(s3, "b", "cam/")).toBeNull();
  });
});

describe("sampleNewestBySensor", () => {
  // Two sensors, each with an old day and a newer one. `dead` sorts first — it is the
  // one the old bucket-wide window would have returned, and it stopped recording.
  const keys = {
    "dead/2026/08/06/12/old-1.mkv": 100,
    "dead/2026/08/06/12/old-2.mkv": 101,
    "live/2026/08/13/23/yesterday.mkv": 200,
    "live/2026/08/14/9/recent-1.mkv": 300,
    "live/2026/08/14/10/recent-2.mkv": 400,
    "live/2026/08/14/10/recent-3.mkv": 401,
  };

  it("returns the newest day and hour per sensor, not the first keys in the bucket", async () => {
    const { s3 } = fakeS3(keys);
    const objs = await sampleNewestBySensor(s3, "b", ["live"], 1);
    // Only the newest hour of the newest day — the 10th, not the 9th, and not
    // yesterday's 23:00 which sorts higher as a string.
    expect(objs.map((o) => o.Key).sort()).toEqual([
      "live/2026/08/14/10/recent-2.mkv",
      "live/2026/08/14/10/recent-3.mkv",
    ]);
  });

  it("takes more than one hour when asked, so durations have something to difference", async () => {
    // computeSegmentDurations needs >= 2 objects per sensor to produce any delta at
    // all; a single sparse hour would leave the percentiles null.
    const { s3 } = fakeS3(keys);
    const objs = await sampleNewestBySensor(s3, "b", ["live"], 2);
    expect(objs.map((o) => o.Key)).toContain("live/2026/08/14/9/recent-1.mkv");
    expect(objs.map((o) => o.Key)).toContain("live/2026/08/14/10/recent-2.mkv");
  });

  it("covers every sensor given, so one prefix cannot dominate the sample", async () => {
    const { s3 } = fakeS3(keys);
    const objs = await sampleNewestBySensor(s3, "b", ["dead", "live"], 1);
    const prefixes = new Set(objs.map((o) => (o.Key ?? "").split("/")[0]));
    expect([...prefixes].sort()).toEqual(["dead", "live"]);
  });

  it("skips a sensor with no objects instead of returning nothing", async () => {
    // A registered camera that has never recorded must not blank the whole panel.
    const { s3 } = fakeS3(keys);
    const objs = await sampleNewestBySensor(s3, "b", ["never-recorded", "live"], 1);
    expect(objs.length).toBeGreaterThan(0);
    expect(objs.every((o) => (o.Key ?? "").startsWith("live/"))).toBe(true);
  });

  it("returns nothing for no sensors, which is what selects the fallback path", async () => {
    const { s3 } = fakeS3(keys);
    expect(await sampleNewestBySensor(s3, "b", [], 1)).toEqual([]);
  });

  it("survives a sensor whose listing throws", async () => {
    const good = fakeS3(keys).s3;
    const s3 = {
      async send(cmd: { input: { Prefix?: string } }) {
        if ((cmd.input.Prefix ?? "").startsWith("boom")) throw new Error("AccessDenied");
        return (good as unknown as { send: (c: unknown) => Promise<unknown> }).send(cmd);
      },
    } as unknown as S3Client;
    const objs = await sampleNewestBySensor(s3, "b", ["boom", "live"], 1);
    expect(objs.every((o) => (o.Key ?? "").startsWith("live/"))).toBe(true);
    expect(objs.length).toBeGreaterThan(0);
  });
});

/** fakeS3, but paginated the way S3 is: entries (objects and rolled-up prefixes
 *  together) in lexicographic order, at most `pageSize` per response, the rest
 *  behind a NextContinuationToken. A reader that takes only the first response
 *  sees the lexicographically first `pageSize` entries — and for unpadded hour
 *  directories or a busy hour, that is not the newest data. */
function pagedFakeS3(keys: Record<string, number>, pageSize: number) {
  const inner = fakeS3(keys).s3 as unknown as {
    send: (c: unknown) => Promise<{
      Contents?: { Key: string; Size: number; LastModified: Date }[];
      CommonPrefixes?: { Prefix: string }[];
    }>;
  };
  const calls: { Prefix?: string; ContinuationToken?: string }[] = [];
  const s3 = {
    async send(cmd: { input: { Prefix?: string; Delimiter?: string; ContinuationToken?: string } }) {
      calls.push({ Prefix: cmd.input.Prefix, ContinuationToken: cmd.input.ContinuationToken });
      const full = await inner.send(cmd);
      const entries = [
        ...(full.Contents ?? []).map((c) => ({ sortKey: c.Key, contents: c })),
        ...(full.CommonPrefixes ?? []).map((p) => ({ sortKey: p.Prefix, prefix: p })),
      ].sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0));
      const start = Number(cmd.input.ContinuationToken ?? 0);
      const page = entries.slice(start, start + pageSize);
      const next = start + pageSize < entries.length ? String(start + pageSize) : undefined;
      return {
        Contents: page.flatMap((e) => ("contents" in e && e.contents ? [e.contents] : [])),
        CommonPrefixes: page.flatMap((e) => ("prefix" in e && e.prefix ? [e.prefix] : [])),
        IsTruncated: next !== undefined,
        NextContinuationToken: next,
      };
    },
  } as unknown as S3Client;
  return { s3, calls };
}

describe("pagination (listings longer than one page)", () => {
  it("listAllPages follows continuation tokens to the last page", async () => {
    const keys: Record<string, number> = {};
    for (let i = 0; i < 7; i++) keys[`cam/2026/10/08/10/${i}.mkv`] = i;
    const { s3, calls } = pagedFakeS3(keys, 3);
    const { contents } = await listAllPages(s3, { Bucket: "b", Prefix: "cam/2026/10/08/10/" });
    expect(contents).toHaveLength(7);
    expect(calls.map((c) => c.ContinuationToken)).toEqual([undefined, "3", "6"]);
  });

  it("finds the newest hour when the day's hour directories span several pages", async () => {
    // 24 unpadded hour directories, two per page. Lexicographically the first
    // page is "0/" and "1/", and "9/" sorts after "23/": only a complete listing
    // can see that 23 is the newest.
    const keys: Record<string, number> = {};
    for (let h = 0; h < 24; h++) keys[`cam/2026/10/08/${h}/seg.mkv`] = h;
    const { s3 } = pagedFakeS3(keys, 2);
    expect(await newestChildPrefix(s3, "b", "cam/2026/10/08/")).toBe("cam/2026/10/08/23/");
  });

  it("returns every object of a busy hour, not the first page of it", async () => {
    const keys: Record<string, number> = {};
    for (let i = 0; i < 10; i++) keys[`cam/2026/10/08/10/${String(i).padStart(2, "0")}.mkv`] = 1000 + i;
    keys["cam/2026/10/08/9/old.mkv"] = 1;
    const { s3 } = pagedFakeS3(keys, 4);
    const objs = await sampleNewestBySensor(s3, "b", ["cam"], 1);
    expect(objs).toHaveLength(10);
    // The newest segment of the hour is on the last page.
    expect(objs.map((o) => o.Key)).toContain("cam/2026/10/08/10/09.mkv");
  });
});

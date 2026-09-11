import { describe, it, expect, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/cluster-refs", () => ({ CLUSTER: { vst: { storageBase: "http://vst" } } }));
import { pickPlaybackWindow, classifyPlayback } from "./playback-health";

const T = Date.parse("2026-09-10T19:35:12Z");
const iso = (ms: number) => new Date(ms).toISOString();

describe("pickPlaybackWindow", () => {
  it("picks the last minute before the lead of the most recently ending recent segment", () => {
    const win = pickPlaybackWindow(
      {
        old: [{ startTime: iso(T - 3_600_000 * 24), endTime: iso(T - 3_600_000 * 20) }],
        a: [{ startTime: iso(T - 3_600_000), endTime: iso(T - 120_000) }],
        b: [{ startTime: iso(T - 3_600_000), endTime: iso(T - 30_000) }],
      },
      T,
    );
    expect(win).toEqual({ streamId: "b", start: iso(T - 30_000 - 120_000), end: iso(T - 30_000 - 60_000) });
  });
  it("returns null when nothing ended in the last 10 minutes", () => {
    expect(pickPlaybackWindow({ a: [{ startTime: iso(T - 3_600_000), endTime: iso(T - 11 * 60_000) }] }, T)).toBeNull();
  });
  it("skips a segment too short to hold the window", () => {
    expect(pickPlaybackWindow({ a: [{ startTime: iso(T - 90_000), endTime: iso(T) }] }, T)).toBeNull();
  });
  it("skips streams with no segments or unparsable times", () => {
    expect(pickPlaybackWindow({ a: [], b: [{ startTime: "x", endTime: "y" }] }, T)).toBeNull();
  });
});

describe("classifyPlayback", () => {
  it("200 is ok", () => {
    expect(classifyPlayback(200, "")).toMatchObject({ ok: true, severity: "ok" });
  });
  it("500 VMSInternalError names the null storage manager", () => {
    const v = classifyPlayback(500, '{"error_code":"VMSInternalError","error_message":"Unable to get requested file"}');
    expect(v).toMatchObject({ ok: false, severity: "error" });
    expect(v.detail).toMatch(/storage manager is not initialized/);
  });
  it("404 on a listed window is a warning", () => {
    expect(classifyPlayback(404, '{"error_code":"VMSNoDataError"}')).toMatchObject({ ok: false, severity: "warn" });
  });
  it("any other status is an error carrying the code", () => {
    expect(classifyPlayback(502, "")).toMatchObject({ ok: false, severity: "error", detail: "clip fetch returned HTTP 502" });
  });
});

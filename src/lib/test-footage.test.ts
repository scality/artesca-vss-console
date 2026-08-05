import { describe, it, expect } from "vitest";
import {
  FootageError,
  footageCameraId,
  footageRtspUrl,
  isFootageCamera,
  sanitiseFilename,
} from "./test-footage";

// The filename becomes BOTH a path on disk and a segment of an RTSP URL that
// ffmpeg is handed inside mediamtx's runOnDemand command — so a hostile or
// merely awkward name must be neutralised, not passed through.

describe("sanitiseFilename", () => {
  it("slugifies a human filename and keeps the extension", () => {
    expect(sanitiseFilename("Store Theft — Lane 3.MP4")).toBe("store-theft-lane-3.mp4");
    expect(sanitiseFilename("aisle_restock 2026.ts")).toBe("aisle-restock-2026.ts");
  });

  it("strips any directory component, defeating traversal", () => {
    expect(sanitiseFilename("../../etc/passwd.mp4")).toBe("passwd.mp4");
    expect(sanitiseFilename("/footage/../clip.mp4")).toBe("clip.mp4");
    expect(sanitiseFilename("C:\\videos\\clip.mp4")).toBe("clip.mp4");
  });

  it("rejects a format ffmpeg cannot remux with -c copy", () => {
    expect(() => sanitiseFilename("clip.avi")).toThrow(FootageError);
    expect(() => sanitiseFilename("notes.txt")).toThrow(/unsupported video format/);
    expect(() => sanitiseFilename("noextension")).toThrow(/unsupported video format/);
  });

  it("rejects a name that slugifies to nothing rather than inventing one", () => {
    expect(() => sanitiseFilename("___.mp4")).toThrow(/no usable characters/);
    expect(() => sanitiseFilename("....mp4")).toThrow();
  });

  it("bounds the stem so a pathological name cannot blow up the path", () => {
    const out = sanitiseFilename(`${"a".repeat(200)}.mp4`);
    expect(out.length).toBeLessThanOrEqual(68);
    expect(out.endsWith(".mp4")).toBe(true);
  });

  it("leaves no character that would need URL escaping", () => {
    const out = sanitiseFilename("cam #1 (50%) & more.mp4");
    expect(out).toBe(encodeURIComponent(out));
  });
});

describe("footageCameraId", () => {
  it("prefixes so a test camera is obvious in the camera list and incidents", () => {
    expect(footageCameraId("store-theft.mp4")).toBe("test-store-theft");
    expect(isFootageCamera(footageCameraId("x.mp4"))).toBe(true);
  });

  it("does not mistake a real camera for test footage", () => {
    expect(isFootageCamera("pyramid-16-cam0")).toBe(false);
    expect(isFootageCamera("checkout-1")).toBe(false);
  });

  it("stays within VST's practical name length", () => {
    expect(footageCameraId(`${"b".repeat(80)}.mp4`).length).toBeLessThanOrEqual(32);
  });
});

describe("footageRtspUrl", () => {
  it("maps the mode onto the matching mediamtx path", () => {
    expect(footageRtspUrl("clip.mp4", "loop")).toBe("rtsp://test-footage-server.console.svc.cluster.local:8654/loop/clip.mp4");
    expect(footageRtspUrl("clip.mp4", "once")).toBe("rtsp://test-footage-server.console.svc.cluster.local:8654/once/clip.mp4");
  });

  it("produces a URL that parses", () => {
    const u = new URL(footageRtspUrl("a-b-1.ts", "loop").replace("rtsp://", "http://"));
    expect(u.pathname).toBe("/loop/a-b-1.ts");
  });
});

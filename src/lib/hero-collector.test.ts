import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { collectHeroExtras } from "./hero-collector";

/** Route a mocked fetch by URL substring. */
function mockFetchByUrl(handler: (url: string) => Response | Promise<Response>) {
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    return Promise.resolve(handler(url));
  }));
}

const json = (body: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(body), { status: 200, ...init });

describe("collectHeroExtras", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it("aggregates archive total, 24h total, and recent incidents on the happy path", async () => {
    mockFetchByUrl((url) => {
      if (url.includes("/stats?since_hours=24")) return json({ total: 12 });
      if (url.includes("/stats")) return json({ total: 1633 });
      if (url.includes("/realtime/incidents")) {
        return json({
          incidents: [
            { category: "shoplifting", timestamp: "2026-07-09T10:00:00Z", info: { sensorId: "cam-3" } },
            { category: "loitering", timestamp: "2026-07-09T09:50:00Z", info: { sensorId: "cam-1" } },
          ],
        });
      }
      return new Response("not found", { status: 404 });
    });

    const extras = await collectHeroExtras();
    expect(extras.archiveTotal).toBe(1633);
    expect(extras.last24h).toBe(12);
    expect(extras.recent).toHaveLength(2);
    expect(extras.recent[0].sensorId).toBe("cam-3");
    expect(extras.warnings).toHaveLength(0);
  });

  it("accepts a bare array from the alert-bridge", async () => {
    mockFetchByUrl((url) => {
      if (url.includes("/stats")) return json({ total: 5 });
      if (url.includes("/realtime/incidents")) {
        return json([{ category: "intrusion", timestamp: "2026-07-09T10:00:00Z", info: { sensorId: "cam-9" } }]);
      }
      return new Response("nf", { status: 404 });
    });

    const extras = await collectHeroExtras();
    expect(extras.recent).toHaveLength(1);
    expect(extras.recent[0].sensorId).toBe("cam-9");
  });

  it("is fail-soft when every backend is down", async () => {
    mockFetchByUrl(() => {
      throw new Error("ECONNREFUSED");
    });

    const extras = await collectHeroExtras();
    expect(extras.archiveTotal).toBeNull();
    expect(extras.last24h).toBeNull();
    expect(extras.recent).toEqual([]);
    expect(extras.warnings.some((w) => w.includes("alert-bridge"))).toBe(true);
    expect(extras.warnings.some((w) => w.includes("archive"))).toBe(true);
  });

  it("treats non-2xx stats as unavailable (null), not zero", async () => {
    mockFetchByUrl((url) => {
      if (url.includes("/stats")) return new Response("boom", { status: 503 });
      if (url.includes("/realtime/incidents")) return json({ incidents: [] });
      return new Response("nf", { status: 404 });
    });

    const extras = await collectHeroExtras();
    expect(extras.archiveTotal).toBeNull();
    expect(extras.last24h).toBeNull();
    expect(extras.recent).toEqual([]);
  });
});

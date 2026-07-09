import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth", () => ({
  auth: vi.fn().mockResolvedValue({ user: { email: "operator@test.com" } }),
}));
vi.mock("@/lib/with-request-context", () => ({
  withRequestContext: (fn: unknown) => fn,
}));
vi.mock("@/lib/cluster-refs", () => ({
  CLUSTER: { search: { url: "http://worker:8080" } },
}));

import { POST } from "@/app/api/search/route";
import { auth } from "@/lib/auth";

function req(body: unknown) {
  return { json: async () => body } as unknown as Parameters<typeof POST>[0];
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.mocked(auth).mockResolvedValue({ user: { email: "operator@test.com" } } as never);
});

describe("POST /api/search", () => {
  it("401s when unauthenticated", async () => {
    vi.mocked(auth).mockResolvedValueOnce(null as never);
    const res = await POST(req({ query: "forklift" }));
    expect(res.status).toBe(401);
  });

  it("400s on an invalid body", async () => {
    const res = await POST(req({ query: "" }));
    expect(res.status).toBe(400);
  });

  it("proxies hits from the worker on success", async () => {
    const hits = [{ camera: "dock-1", ts: "T", category: "forklift-safety", caption: "c", summary: "s", incidentId: "i", score: 0.9 }];
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ hits }) });
    vi.stubGlobal("fetch", fetchMock);

    const res = await POST(req({ query: "forklift", limit: 5 }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.hits).toEqual(hits);
    // Forwards to the worker /search with query + limit.
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://worker:8080/search");
    expect(JSON.parse(init.body as string)).toMatchObject({ query: "forklift", limit: 5 });
  });

  it("passes the sensor filter through when provided", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ hits: [] }) });
    vi.stubGlobal("fetch", fetchMock);
    await POST(req({ query: "forklift", sensor: "dock-1" }));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toMatchObject({ sensor: "dock-1" });
  });

  it("fail-softs to { hits: [], error } on a worker 5xx", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 502, text: async () => "boom" }));
    const res = await POST(req({ query: "forklift" }));
    const body = await res.json();
    expect(res.status).toBe(502);
    expect(body.hits).toEqual([]);
    expect(body.error).toContain("caption-indexer HTTP 502");
  });

  it("fail-softs to { hits: [], error } when the worker is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    const res = await POST(req({ query: "forklift" }));
    const body = await res.json();
    expect(res.status).toBe(503);
    expect(body.hits).toEqual([]);
    expect(body.error).toContain("unreachable");
  });
});

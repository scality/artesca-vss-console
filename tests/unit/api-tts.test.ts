import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth", () => ({
  auth: vi.fn().mockResolvedValue({ user: { email: "operator@test.com" } }),
}));
vi.mock("@/lib/with-request-context", () => ({
  withRequestContext: (fn: unknown) => fn,
}));
vi.mock("@/lib/cluster-refs", () => ({
  CLUSTER: {
    tts: {
      url: "http://magpie-tts:9000",
      enabled: true,
      voice: "Magpie-Multilingual.EN-US.Aria",
      language: "en-US",
    },
  },
}));

import { POST } from "@/app/api/tts/route";
import { auth } from "@/lib/auth";

function req(body: unknown) {
  return { json: async () => body } as unknown as Parameters<typeof POST>[0];
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.mocked(auth).mockResolvedValue({ user: { email: "operator@test.com" } } as never);
});

describe("POST /api/tts", () => {
  it("401s when unauthenticated", async () => {
    vi.mocked(auth).mockResolvedValueOnce(null as never);
    const res = await POST(req({ text: "hello" }));
    expect(res.status).toBe(401);
  });

  it("400s on an empty text", async () => {
    const res = await POST(req({ text: "" }));
    expect(res.status).toBe(400);
  });

  it("proxies WAV bytes on success and forwards a multipart synth request", async () => {
    const wav = new Uint8Array([0x52, 0x49, 0x46, 0x46]); // "RIFF"
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(wav, { status: 200, headers: { "content-type": "audio/wav" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await POST(req({ text: "forklift near pallets", voice: "Magpie-Multilingual.EN-US.Ryan" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/wav");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(wav);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://magpie-tts:9000/v1/audio/synthesize");
    expect(init.method).toBe("POST");
    const form = init.body as FormData;
    expect(form.get("text")).toBe("forklift near pallets");
    expect(form.get("voice")).toBe("Magpie-Multilingual.EN-US.Ryan");
    expect(form.get("language")).toBe("en-US");
  });

  it("defaults the voice when none is supplied", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(new Uint8Array([1]), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await POST(req({ text: "hello" }));
    expect((fetchMock.mock.calls[0][1].body as FormData).get("voice")).toBe(
      "Magpie-Multilingual.EN-US.Aria",
    );
  });

  it("returns 502 when the NIM errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("no profile", { status: 500 })));
    const res = await POST(req({ text: "hello" }));
    expect(res.status).toBe(502);
    expect((await res.json()).error).toContain("magpie-tts HTTP 500");
  });

  it("returns 503 when the NIM is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    const res = await POST(req({ text: "hello" }));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toContain("unreachable");
  });
});

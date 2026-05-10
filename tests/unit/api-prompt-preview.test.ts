import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Module mocks — declared before any imports that trigger the modules ──────

vi.mock("@/lib/auth", () => ({
  auth: vi.fn().mockResolvedValue({ user: { name: "operator", email: "operator@test.com" } }),
}));

import type { NextRequest } from "next/server";
import { auth } from "@/lib/auth";

import { POST } from "@/app/api/prompt/preview/route";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeRequest(body: unknown): NextRequest {
  return new Request("http://localhost/api/prompt/preview", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  }) as unknown as NextRequest;
}

const VALID_BODY = {
  prompt: "You are an AI camera operator. Detect suspicious activity.",
  userMessage: "What do you see in this frame?",
};

const NIM_SUCCESS_RESPONSE = {
  choices: [{ message: { content: "I see a person near the entrance." } }],
  model: "nvila-lite-2b",
};

function makeFetchOk(body: unknown = NIM_SUCCESS_RESPONSE): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: vi.fn().mockResolvedValue(body),
    text: vi.fn().mockResolvedValue(JSON.stringify(body)),
  }) as unknown as typeof fetch;
}

function makeFetchError(status: number, body = "Internal Server Error"): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: false,
    status,
    json: vi.fn().mockResolvedValue({ error: body }),
    text: vi.fn().mockResolvedValue(body),
  }) as unknown as typeof fetch;
}

// ── Setup ─────────────────────────────────────────────────────────────────────

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  vi.mocked(auth).mockReset().mockResolvedValue({
    user: { name: "operator", email: "operator@test.com" },
  } as never);

  // Preserve original so we can restore after each test.
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.NIM_PREVIEW_ENDPOINT;
  delete process.env.NIM_PREVIEW_MODEL;
});

// ── POST /api/prompt/preview ──────────────────────────────────────────────────

describe("POST /api/prompt/preview", () => {
  it("auth missing → 401, no upstream fetch", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    vi.stubGlobal("fetch", vi.fn());

    const req = makeRequest(VALID_BODY);
    const res = await POST(req);

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toMatch(/unauthorized/i);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("invalid body: missing prompt → 400, no upstream fetch", async () => {
    vi.stubGlobal("fetch", vi.fn());

    const req = makeRequest({ userMessage: "hello" });
    const res = await POST(req);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/validation failed/i);
    expect(body.issues).toBeDefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("invalid body: empty prompt (min(1) fails) → 400", async () => {
    vi.stubGlobal("fetch", vi.fn());

    const req = makeRequest({ prompt: "", userMessage: "hello" });
    const res = await POST(req);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/validation failed/i);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("invalid body: non-JSON body → 400", async () => {
    vi.stubGlobal("fetch", vi.fn());

    const req = new Request("http://localhost/api/prompt/preview", {
      method: "POST",
      body: "not json",
      headers: { "content-type": "application/json" },
    }) as unknown as NextRequest;

    const res = await POST(req);

    expect(res.status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("happy path: forwards to NIM, returns response + latencyMs + model", async () => {
    vi.stubGlobal("fetch", makeFetchOk());

    const req = makeRequest(VALID_BODY);
    const res = await POST(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.response).toBe("I see a person near the entrance.");
    expect(body.model).toBe("nvila-lite-2b");
    expect(typeof body.latencyMs).toBe("number");
    expect(body.latencyMs).toBeGreaterThanOrEqual(0);

    // Verify the upstream request shape.
    const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("nim-preview");
    const upstreamBody = JSON.parse(init.body as string);
    expect(upstreamBody.messages).toHaveLength(2);
    expect(upstreamBody.messages[0].role).toBe("system");
    expect(upstreamBody.messages[0].content).toBe(VALID_BODY.prompt);
    expect(upstreamBody.messages[1].role).toBe("user");
    expect(upstreamBody.messages[1].content).toBe(VALID_BODY.userMessage);
  });

  it("NIM returns 5xx → 502 with status in error message", async () => {
    vi.stubGlobal("fetch", makeFetchError(503, "Service Unavailable"));

    const req = makeRequest(VALID_BODY);
    const res = await POST(req);

    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toContain("503");
    expect(body.error).toContain("Service Unavailable");
  });

  it("NIM returns 4xx (e.g. 422) → 502 with status in error message", async () => {
    vi.stubGlobal("fetch", makeFetchError(422, "Unprocessable Entity"));

    const req = makeRequest(VALID_BODY);
    const res = await POST(req);

    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toContain("422");
  });

  it("network error (fetch throws) → 503 with unreachable message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("Failed to fetch")),
    );

    const req = makeRequest(VALID_BODY);
    const res = await POST(req);

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toMatch(/Preview NIM unreachable/);
    expect(body.error).toContain("Failed to fetch");
  });

  it("AbortSignal timeout (fetch throws DOMException) → 503", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new DOMException("The operation was aborted", "AbortError")),
    );

    const req = makeRequest(VALID_BODY);
    const res = await POST(req);

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toMatch(/Preview NIM unreachable/);
  });

  it("NIM response missing choices → returns empty string as response", async () => {
    vi.stubGlobal("fetch", makeFetchOk({ model: "nvila-lite-2b" })); // no choices

    const req = makeRequest(VALID_BODY);
    const res = await POST(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.response).toBe("");
    expect(body.model).toBe("nvila-lite-2b");
  });

  it("NIM_PREVIEW_ENDPOINT env var is used when set", async () => {
    process.env.NIM_PREVIEW_ENDPOINT = "http://custom-nim:9090/v1/chat/completions";
    vi.stubGlobal("fetch", makeFetchOk());

    const req = makeRequest(VALID_BODY);
    await POST(req);

    const [url] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(url).toBe("http://custom-nim:9090/v1/chat/completions");
  });
});

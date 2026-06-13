/**
 * Unit tests for src/lib/helpers/alert-bridge.ts
 *
 * Covers:
 *  - listRealtimeRules(): parses rules array, HTTP error, network failure.
 *  - addRealtimeRule(): POST body shape + returns id, 409 idempotent,
 *    non-2xx → warning + ok:false.
 *  - deleteRealtimeRule(): correct DELETE URL + 404 idempotent,
 *    non-2xx → warning + ok:false.
 *
 * Mocking strategy: vi.stubGlobal("fetch", vi.fn()) — intercepts every fetch
 * call in the module under test.  cluster-refs is mocked to a fixed test URL
 * so no process.env wiring is needed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── cluster-refs mock ───────────────────────────────────────────────────────

vi.mock("@/lib/cluster-refs", () => ({
  CLUSTER: {
    alertBridge: {
      realtimeUrl: "http://ab:9080/api/v1/realtime",
    },
  },
}));

// ─── Module under test (imported after mocks) ────────────────────────────────

import {
  listRealtimeRules,
  addRealtimeRule,
  deleteRealtimeRule,
} from "@/lib/helpers/alert-bridge";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function okResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function errResponse(status: number): Response {
  return new Response(JSON.stringify({ error: "boom" }), { status });
}

// ─── Lifecycle ───────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ═════════════════════════════════════════════════════════════════════════════
// listRealtimeRules
// ═════════════════════════════════════════════════════════════════════════════

describe("listRealtimeRules", () => {
  it("parses rules array from the response envelope", async () => {
    const rules = [
      {
        id: "rule-1",
        live_stream_url: "rtsp://host/cam1",
        alert_type: "intrusion",
        prompt: "detect intruders",
        sensor_id: "cam1",
        sensor_name: "Camera 1",
      },
    ];
    vi.mocked(fetch).mockResolvedValueOnce(okResponse({ status: "ok", rules, count: 1, total: 1 }));

    const result = await listRealtimeRules();

    expect(result.warning).toBeUndefined();
    expect(result.rules).toHaveLength(1);
    expect(result.rules[0].id).toBe("rule-1");
    expect(result.rules[0].live_stream_url).toBe("rtsp://host/cam1");
    expect(result.rules[0].alert_type).toBe("intrusion");

    const [url] = vi.mocked(fetch).mock.calls[0] as [string, ...unknown[]];
    expect(url).toBe("http://ab:9080/api/v1/realtime");
  });

  it("returns empty rules array + no warning when rules key is absent", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(okResponse({ status: "ok" }));

    const result = await listRealtimeRules();

    expect(result.rules).toEqual([]);
    expect(result.warning).toBeUndefined();
  });

  it("HTTP 5xx: returns empty rules + warning, does not throw", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(errResponse(503));

    const result = await listRealtimeRules();

    expect(result.rules).toEqual([]);
    expect(result.warning).toMatch(/503/);
  });

  it("network failure: returns empty rules + warning, does not throw", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const result = await listRealtimeRules();

    expect(result.rules).toEqual([]);
    expect(result.warning).toMatch(/unreachable/i);
    expect(result.warning).toMatch(/ECONNREFUSED/);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// addRealtimeRule
// ═════════════════════════════════════════════════════════════════════════════

describe("addRealtimeRule", () => {
  it("happy path: POST to realtimeUrl with correct body, returns ok:true + id", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      okResponse({ status: "ok", rule: { id: "rule-42", live_stream_url: "rtsp://host/cam1", alert_type: "intrusion", prompt: "detect" } }, 201)
    );

    const result = await addRealtimeRule({
      streamUrl: "rtsp://host/cam1",
      alertType: "intrusion",
      prompt: "detect intruders",
    });

    expect(result.ok).toBe(true);
    expect(result.id).toBe("rule-42");
    expect(result.warning).toBeUndefined();

    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://ab:9080/api/v1/realtime");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ "Content-Type": "application/json" });

    const body = JSON.parse(init.body as string);
    expect(body.live_stream_url).toBe("rtsp://host/cam1");
    expect(body.alert_type).toBe("intrusion");
    expect(body.prompt).toBe("detect intruders");
    // Optional fields not provided — must be absent from body.
    expect(body.sensor_name).toBeUndefined();
    expect(body.system_prompt).toBeUndefined();
    expect(body.model).toBeUndefined();
  });

  it("optional fields are included in POST body when provided", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      okResponse({ status: "ok", rule: { id: "r1", live_stream_url: "rtsp://x/1", alert_type: "fire", prompt: "fire?" } }, 201)
    );

    await addRealtimeRule({
      streamUrl: "rtsp://x/1",
      alertType: "fire",
      prompt: "fire?",
      sensorName: "Camera A",
      systemPrompt: "You are a safety monitor.",
      model: "cosmos-reason2-8b",
    });

    const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.sensor_name).toBe("Camera A");
    expect(body.system_prompt).toBe("You are a safety monitor.");
    expect(body.model).toBe("cosmos-reason2-8b");
  });

  it("id parsed from top-level json.id when rule envelope is absent", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      okResponse({ id: "top-level-id" }, 200)
    );

    const result = await addRealtimeRule({
      streamUrl: "rtsp://x/2",
      alertType: "motion",
      prompt: "detect motion",
    });

    expect(result.ok).toBe(true);
    expect(result.id).toBe("top-level-id");
  });

  it("409 idempotent: treated as success (ok:true), no warning", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(errResponse(409));

    const result = await addRealtimeRule({
      streamUrl: "rtsp://host/cam1",
      alertType: "intrusion",
      prompt: "detect",
    });

    expect(result.ok).toBe(true);
    expect(result.warning).toBeUndefined();
  });

  it("non-2xx (non-409): returns ok:false + warning, does not throw", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(errResponse(400));

    const result = await addRealtimeRule({
      streamUrl: "rtsp://host/cam1",
      alertType: "intrusion",
      prompt: "detect",
    });

    expect(result.ok).toBe(false);
    expect(result.warning).toMatch(/400/);
  });

  it("network failure: returns ok:false + warning, does not throw", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error("ETIMEDOUT"));

    const result = await addRealtimeRule({
      streamUrl: "rtsp://host/cam1",
      alertType: "intrusion",
      prompt: "detect",
    });

    expect(result.ok).toBe(false);
    expect(result.warning).toMatch(/ETIMEDOUT/);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// deleteRealtimeRule
// ═════════════════════════════════════════════════════════════════════════════

describe("deleteRealtimeRule", () => {
  it("happy path: DELETE to /{id}, returns ok:true", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(okResponse({}, 200));

    const result = await deleteRealtimeRule("rule-42");

    expect(result.ok).toBe(true);
    expect(result.warning).toBeUndefined();

    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://ab:9080/api/v1/realtime/rule-42");
    expect(init.method).toBe("DELETE");
  });

  it("rule id is URL-encoded in the DELETE path", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(okResponse({}, 200));

    await deleteRealtimeRule("rule with spaces");

    const [url] = vi.mocked(fetch).mock.calls[0] as [string, ...unknown[]];
    expect(url).toMatch(/rule%20with%20spaces$/);
  });

  it("404 idempotent: treated as success (ok:true), no warning", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(errResponse(404));

    const result = await deleteRealtimeRule("already-gone");

    expect(result.ok).toBe(true);
    expect(result.warning).toBeUndefined();
  });

  it("non-2xx (non-404): returns ok:false + warning, does not throw", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(errResponse(500));

    const result = await deleteRealtimeRule("rule-42");

    expect(result.ok).toBe(false);
    expect(result.warning).toMatch(/500/);
  });

  it("network failure: returns ok:false + warning, does not throw", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error("ECONNRESET"));

    const result = await deleteRealtimeRule("rule-42");

    expect(result.ok).toBe(false);
    expect(result.warning).toMatch(/ECONNRESET/);
  });
});

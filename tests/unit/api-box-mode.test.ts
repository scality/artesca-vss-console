// GET /api/box-mode — the shape the banner reads, and the auth gate.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

import { auth } from "@/lib/auth";
import { resetBoxModeCache } from "@/lib/box-mode";
import { GET } from "@/app/api/box-mode/route";

beforeEach(() => {
  vi.mocked(auth).mockReset().mockResolvedValue({ user: { name: "operator" } } as never);
});

describe("GET /api/box-mode", () => {
  it("returns exactly { mode, pinned, updatedAt, source, reason }", async () => {
    resetBoxModeCache({
      reader: async () => ({ data: { mode: "llm", pinned: "true", updatedAt: "2026-10-01T10:40:29.227Z", lastMessage: "llm healthy" } }),
    });
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      mode: "llm",
      pinned: true,
      updatedAt: "2026-10-01T10:40:29.227Z",
      source: "configmap",
      reason: null,
    });
  });

  it("a 403 still answers 200 with mode vss and the reason", async () => {
    resetBoxModeCache({
      reader: async () => {
        throw Object.assign(new Error("forbidden"), { code: 403 });
      },
    });
    const body = await (await GET()).json();
    expect(body).toMatchObject({ mode: "vss", pinned: false, updatedAt: null, source: "error" });
    expect(body.reason).toMatch(/^forbidden: /);
  });

  it("401 without a session", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    expect((await GET()).status).toBe(401);
  });
});

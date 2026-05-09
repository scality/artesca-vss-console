import { describe, it, expect, vi, beforeEach } from "vitest";

// Override the setup.ts global mock of next/headers with a controllable version.
// setup.ts installs a synchronous stub; we replace it with an async-capable mock here.
vi.mock("next/headers", () => ({
  cookies: vi.fn(),
}));

// server-only is already stubbed by tests/setup.ts.
import { rejectIfKiosk } from "@/lib/kiosk-server";
import { cookies } from "next/headers";

// Helper: build a minimal ReadonlyRequestCookies-like object.
function makeCookieStore(entries: Record<string, string> = {}) {
  return {
    get(name: string) {
      const value = entries[name];
      return value !== undefined ? { name, value } : undefined;
    },
  };
}

const mockedCookies = vi.mocked(cookies);

beforeEach(() => {
  mockedCookies.mockReset();
});

describe("rejectIfKiosk", () => {
  it("returns null when no kiosk cookie is set", async () => {
    mockedCookies.mockResolvedValue(makeCookieStore() as never);
    const result = await rejectIfKiosk();
    expect(result).toBeNull();
  });

  it("returns null when kiosk cookie value is '0'", async () => {
    mockedCookies.mockResolvedValue(makeCookieStore({ kiosk: "0" }) as never);
    const result = await rejectIfKiosk();
    expect(result).toBeNull();
  });

  it("returns null when kiosk cookie value is empty string", async () => {
    mockedCookies.mockResolvedValue(makeCookieStore({ kiosk: "" }) as never);
    const result = await rejectIfKiosk();
    expect(result).toBeNull();
  });

  it("returns null when kiosk cookie value is 'true' (only '1' triggers reject)", async () => {
    mockedCookies.mockResolvedValue(makeCookieStore({ kiosk: "true" }) as never);
    const result = await rejectIfKiosk();
    expect(result).toBeNull();
  });

  it("returns a 403 NextResponse when kiosk cookie value is '1'", async () => {
    mockedCookies.mockResolvedValue(makeCookieStore({ kiosk: "1" }) as never);
    const result = await rejectIfKiosk();
    expect(result).not.toBeNull();
    expect(result!.status).toBe(403);
    const body = await result!.json();
    expect(body).toEqual({ error: "kiosk mode is read-only" });
  });
});

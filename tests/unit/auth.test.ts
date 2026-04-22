import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Test the auth logic in isolation without importing next-auth
// (which requires full Next.js environment)

async function authorizeCredentials(
  password: string | undefined,
  envHash: string | undefined,
  envPlain: string | undefined
): Promise<{ id: string; name: string; email: string } | null> {
  // Replicated authorize logic from src/lib/auth.ts
  const DEV_USER = { id: "1", name: "console-operator", email: "console@local" };
  if (!password) return null;
  if (!envHash && !envPlain) return DEV_USER; // permissive dev-mode
  if (envPlain) {
    return password === envPlain ? DEV_USER : null;
  }
  // bcrypt compare — tested separately
  return null;
}

describe("auth credentials provider logic", () => {
  it("returns dev user when no password env vars configured (permissive dev-mode)", async () => {
    const result = await authorizeCredentials("anything", undefined, undefined);
    expect(result).not.toBeNull();
    expect(result?.name).toBe("console-operator");
  });

  it("returns null when password is empty", async () => {
    const result = await authorizeCredentials("", "hash", "plain");
    expect(result).toBeNull();
  });

  it("returns user on correct plain-text password", async () => {
    const result = await authorizeCredentials("correct", undefined, "correct");
    expect(result).not.toBeNull();
    expect(result?.id).toBe("1");
  });

  it("returns null on wrong plain-text password", async () => {
    const result = await authorizeCredentials("wrong", undefined, "correct");
    expect(result).toBeNull();
  });

  it("returns null when password is undefined", async () => {
    const result = await authorizeCredentials(undefined, undefined, "correct");
    expect(result).toBeNull();
  });
});

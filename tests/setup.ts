// Shim next-auth's server-only import so unit tests don't fail on missing next.js internals
// next-auth/react uses window — stub it out for node env
import { vi } from "vitest";

// Prevent "server-only" from throwing in test env
vi.mock("server-only", () => ({}));

// Stub next/headers used by some lib files
vi.mock("next/headers", () => ({
  headers: vi.fn(() => new Map()),
  cookies: vi.fn(() => new Map()),
}));

// Stub next/navigation
vi.mock("next/navigation", () => ({
  redirect: vi.fn(),
  useRouter: vi.fn(() => ({ push: vi.fn(), replace: vi.fn() })),
  usePathname: vi.fn(() => "/"),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));

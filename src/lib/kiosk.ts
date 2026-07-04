import { type ReadonlyHeaders } from "next/dist/server/web/spec-extension/adapters/headers";

export const KIOSK_HIDDEN_ROUTES = [
  "/cameras",
  "/scenarios",
  "/prompt",
  "/tuning",
  "/demo-data",
  "/profiles",
  "/secrets",
  "/logs",
  "/diagnostics",
  "/sizing-studio",
  "/settings",
  "/about",
  "/capabilities",
];

/**
 * Page routes that remain accessible in kiosk mode (the showroom-visible set).
 * The middleware redirects any other page route to "/" when the kiosk cookie is active.
 * API routes are excluded from this check — data-fetching on allowed pages must
 * continue to work, and mutating API routes are already guarded by rejectIfKiosk().
 */
export const KIOSK_ALLOWED_ROUTES: readonly string[] = [
  "/",
  "/incidents",
  "/topology",
  "/chat",
];

/**
 * Returns true when the pathname is an API or Next.js internal route.
 * These are exempt from the kiosk page guard.
 */
export function isApiOrInternal(pathname: string): boolean {
  return pathname.startsWith("/api/") || pathname.startsWith("/_next/");
}

/**
 * Returns true when the pathname is a page route allowed in kiosk mode.
 * Exact-match "/" plus prefix-match for the others (covers future sub-routes).
 */
export function isKioskAllowed(pathname: string): boolean {
  return KIOSK_ALLOWED_ROUTES.some(
    (p) =>
      p === "/"
        ? pathname === "/"
        : pathname === p || pathname.startsWith(p + "/")
  );
}

export function isKioskFromHeaders(headers: ReadonlyHeaders): boolean {
  const cookie = headers.get("cookie") ?? "";
  return /(?:^|;\s*)kiosk=1/.test(cookie);
}

export function setKioskCookie(val: boolean): string {
  if (val) {
    return "kiosk=1; Path=/; SameSite=Strict; HttpOnly";
  }
  return "kiosk=; Path=/; SameSite=Strict; HttpOnly; Max-Age=0";
}

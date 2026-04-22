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
  "/settings",
  "/about",
];

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

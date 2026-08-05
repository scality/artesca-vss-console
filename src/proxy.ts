import { auth } from "@/lib/auth";
import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { isKioskAllowed, isApiOrInternal } from "@/lib/kiosk";

const PUBLIC_PATHS = [
  "/sign-in",
  "/api/auth",
  "/api/health/self",
  "/_next",
  "/favicon.ico",
];

function isPublic(pathname: string): boolean {
  return PUBLIC_PATHS.some(
    (p) => pathname === p || pathname.startsWith(p + "/")
  );
}

function withRequestId(response: NextResponse, reqId: string): NextResponse {
  response.headers.set("x-request-id", reqId);
  return response;
}

export default auth((req) => {
  const { pathname, searchParams } = req.nextUrl;
  const reqId = req.headers.get("x-request-id") ?? randomUUID();

  // Persist ?mode=kiosk to a cookie so subsequent navigations keep kiosk mode.
  if (searchParams.get("mode") === "kiosk") {
    const url = req.nextUrl.clone();
    url.searchParams.delete("mode");
    const response = NextResponse.redirect(url);
    response.cookies.set("kiosk", "1", {
      httpOnly: true,
      sameSite: "strict",
      path: "/",
      maxAge: 8 * 60 * 60,
    });
    return withRequestId(response, reqId);
  }

  // ?mode=normal exits kiosk — clears the cookie so an operator can leave the
  // showroom wall without manually wiping browser cookies (the cookie is
  // HttpOnly, so it can only be cleared server-side).
  if (searchParams.get("mode") === "normal") {
    const url = req.nextUrl.clone();
    url.searchParams.delete("mode");
    const response = NextResponse.redirect(url);
    response.cookies.set("kiosk", "", {
      httpOnly: true,
      sameSite: "strict",
      path: "/",
      maxAge: 0,
    });
    return withRequestId(response, reqId);
  }

  if (isPublic(pathname)) {
    const response = NextResponse.next();
    response.headers.set("x-request-id", reqId);
    return response;
  }

  if (!req.auth) {
    const signInUrl = new URL("/sign-in", req.url);
    return withRequestId(NextResponse.redirect(signInUrl), reqId);
  }

  // Server-side kiosk page guard: block navigation to operator-config pages.
  // API routes are exempt — data fetching on allowed pages must keep working;
  // mutating API routes are already guarded by rejectIfKiosk() in each handler.
  const isKiosk = req.cookies.get("kiosk")?.value === "1";
  if (isKiosk && !isApiOrInternal(pathname) && !isKioskAllowed(pathname)) {
    const homeUrl = new URL("/", req.url);
    return withRequestId(NextResponse.redirect(homeUrl), reqId);
  }

  const response = NextResponse.next({
    request: {
      headers: new Headers({ ...Object.fromEntries(req.headers), "x-request-id": reqId }),
    },
  });
  response.headers.set("x-request-id", reqId);
  return response;
});

export const config = {
  // `api/test-footage` is excluded deliberately. When a proxy matches a request,
  // Next CLONES AND BUFFERS its body in memory up to
  // experimental.proxyClientMaxBodySize (default 10 MB) and — per the Next docs
  // — "the request will not fail or return an error to the client": the handler
  // silently receives only the first 10 MB. A 31 MB clip uploaded that way was
  // stored truncated with an HTTP 200. Raising the limit is not the fix either,
  // since it buffers in memory and this pod has a 1 Gi cap; the upload has to
  // stream, so it must not be proxied. Auth is unaffected — every API route
  // checks auth() itself, which is the actual gate for API requests.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|api/test-footage).*)"],
};

import { auth } from "@/lib/auth";
import { NextResponse } from "next/server";

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

export default auth((req) => {
  const { pathname, searchParams } = req.nextUrl;

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
    return response;
  }

  if (isPublic(pathname)) return NextResponse.next();

  if (!req.auth) {
    const signInUrl = new URL("/sign-in", req.url);
    return NextResponse.redirect(signInUrl);
  }

  return NextResponse.next();
});

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};

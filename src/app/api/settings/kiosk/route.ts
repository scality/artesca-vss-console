import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { createLogger } from "@/lib/logger";

const log = createLogger("api/settings/kiosk");

export const dynamic = "force-dynamic";

const BodySchema = z.object({ kiosk: z.boolean() });

// POST — toggle the kiosk cookie from the Settings page. Mirrors the cookie the
// `?mode=kiosk` / `?mode=normal` query params set in proxy.ts (HttpOnly, so it
// can only be written server-side): 8h TTL when enabling, cleared when disabling.
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Expected { kiosk: boolean }" }, { status: 400 });
  }

  const enabled = parsed.data.kiosk;
  const res = NextResponse.json({ ok: true, kiosk: enabled });
  res.cookies.set("kiosk", enabled ? "1" : "", {
    httpOnly: true,
    sameSite: "strict",
    path: "/",
    maxAge: enabled ? 8 * 60 * 60 : 0,
  });
  log.info("kiosk mode toggled", { kiosk: enabled });
  return res;
}

import "server-only";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

export async function rejectIfKiosk(): Promise<NextResponse | null> {
  const c = await cookies();
  if (c.get("kiosk")?.value === "1") {
    return NextResponse.json({ error: "kiosk mode is read-only" }, { status: 403 });
  }
  return null;
}

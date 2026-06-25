import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { collectStreamDensity } from "@/lib/stream-density";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const snapshot = await collectStreamDensity();
  return NextResponse.json(snapshot);
}

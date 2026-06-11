import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { collectConnectivity } from "@/lib/diagnostics/connectivity";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const backends = await collectConnectivity();
  return NextResponse.json({ takenAt: new Date().toISOString(), backends });
}

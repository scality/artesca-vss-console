import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { collectOverviewSnapshot } from "@/lib/overview-collector";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { snapshot, mode, warnings } = await collectOverviewSnapshot();
  return NextResponse.json({ ...snapshot, mode, warnings });
}

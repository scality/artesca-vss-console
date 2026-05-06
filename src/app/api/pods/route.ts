import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { collectPodSummaries } from "@/lib/overview-collector";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const ns = req.nextUrl.searchParams.get("ns") ?? undefined;
  const { pods, warnings } = await collectPodSummaries(ns);
  return NextResponse.json({ pods, warnings });
}

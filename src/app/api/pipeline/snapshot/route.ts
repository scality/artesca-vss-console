// GET /api/pipeline/snapshot
// Returns a single PipelineSnapshot collected synchronously.
// Auth-guarded. Dynamic — no caching.

import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { collectSnapshot } from "@/lib/pipeline/aggregator";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const snapshot = await collectSnapshot();
  return NextResponse.json(snapshot);
}

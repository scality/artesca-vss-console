import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { collectGpuAllocation } from "@/lib/gpu-allocation";

export const dynamic = "force-dynamic";

// Thin auth + JSON wrapper around collectGpuAllocation, for the client-side
// GpuSharingCard auto-refresh. The collector never throws (degrades to
// warnings), so this always returns 200 once authenticated.
export async function GET() {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const snapshot = await collectGpuAllocation();
  return NextResponse.json(snapshot);
}

import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getBoxMode } from "@/lib/box-mode";

export const dynamic = "force-dynamic";

/**
 * The box's GPU mode as the console sees it — the AI Factory's record
 * (ConfigMap `ai-factory/gpu-mode`), cached ~10 s. Read-only; never fails:
 * a box without the AI Factory, or a record the console cannot read, answers
 * `mode: "vss"` with `source` and `reason` saying why. The banner polls it.
 */
export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { mode, pinned, updatedAt, source, reason } = await getBoxMode();
  return NextResponse.json({ mode, pinned, updatedAt, source, reason });
}

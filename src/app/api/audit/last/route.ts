import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { readLastAuditLog } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const action = req.nextUrl.searchParams.get("action");
  if (!action) {
    return NextResponse.json(
      { error: "Missing required query param: action" },
      { status: 400 }
    );
  }

  const row = readLastAuditLog(action);
  return NextResponse.json(row);
}

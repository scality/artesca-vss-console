/**
 * GET /api/storage/substrate
 *
 * Live per-bucket ARTESCA S3 usage (objects/bytes/24h + latest objects) backing
 * the /storage page. Thin auth + JSON wrapper around collectStorageSubstrate();
 * the collector caches heavy listings and is fail-soft, so this never throws.
 */
import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { withRequestContext } from "@/lib/with-request-context";
import { collectStorageSubstrate } from "@/lib/storage-substrate";

export const dynamic = "force-dynamic";

export const GET = withRequestContext(async function (_req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const data = await collectStorageSubstrate();
  return NextResponse.json(data);
});

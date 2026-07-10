/**
 * GET /api/kvcache
 *
 * Live vLLM+LMCache reachability + ARTESCA S3 KV-cache bucket stats backing
 * the /kvcache page's LIVE mode. Thin auth + JSON wrapper around
 * collectKvcacheSnapshot(); the collector is fail-soft (available:false +
 * warnings on any probe/listing failure), so this route never throws.
 */
import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { withRequestContext } from "@/lib/with-request-context";
import { collectKvcacheSnapshot } from "@/lib/kvcache";

export const dynamic = "force-dynamic";

export const GET = withRequestContext(async function (_req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const data = await collectKvcacheSnapshot();
  return NextResponse.json(data);
});

/**
 * POST /api/kvcache/race
 *
 * Fires a real cold-vs-warm completion race against the live vLLM+LMCache
 * backend to measure the actual TTFT speedup from an ARTESCA-backed KV-cache
 * hit. Can take ~10-30s (a warmup call, a cold generation, a pause for
 * LMCache to finish offloading to S3, then the warm generation) — that's
 * expected. runKvRace() is fail-soft: a backend outage returns
 * `{ ok: false, error }` rather than throwing, so the page can fall back to
 * its mock race.
 */
import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { withRequestContext } from "@/lib/with-request-context";
import { runKvRace } from "@/lib/kvcache";

export const dynamic = "force-dynamic";

export const POST = withRequestContext(async function (_req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const result = await runKvRace();
  return NextResponse.json(result);
});

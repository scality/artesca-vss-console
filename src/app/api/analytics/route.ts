/**
 * GET /api/analytics[?hours=N]
 *
 * Incident-archive aggregations (total + by category + by camera + by day) for
 * the /analytics "ask the store" page. Proxies the caption-indexer worker's
 * /stats (which scrolls Qdrant). Fail-soft: returns zeros + error on any
 * failure so the page degrades instead of throwing.
 */
import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { withRequestContext } from "@/lib/with-request-context";
import { CLUSTER } from "@/lib/cluster-refs";

export const dynamic = "force-dynamic";

const EMPTY = { total: 0, byCategory: {}, byCamera: {}, byDay: [] as unknown[] };

export const GET = withRequestContext(async function (req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const hours = new URL(req.url).searchParams.get("hours");
  const qs = hours && Number.isFinite(Number(hours)) ? `?since_hours=${encodeURIComponent(hours)}` : "";

  try {
    const resp = await fetch(`${CLUSTER.search.url}/stats${qs}`, {
      signal: AbortSignal.timeout(12_000),
    });
    if (!resp.ok) {
      return NextResponse.json({ ...EMPTY, error: `stats HTTP ${resp.status}` }, { status: 502 });
    }
    const d = await resp.json();
    return NextResponse.json({
      total: Number(d?.total) || 0,
      byCategory: d?.byCategory ?? {},
      byCamera: d?.byCamera ?? {},
      byDay: Array.isArray(d?.byDay) ? d.byDay : [],
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ...EMPTY, error: `stats unreachable: ${msg}` }, { status: 503 });
  }
});

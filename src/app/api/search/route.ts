/**
 * POST /api/search
 *
 * Console-side proxy to the vss-caption-indexer worker's POST /search endpoint.
 * The worker indexes VLM incident captions into Qdrant; the console is a thin
 * auth-gated proxy — Qdrant is never addressed from the console directly.
 *
 * Request body:  { query: string, sensor?: string, limit?: number }
 * Response:      { hits: SearchHit[] }          on success
 *                { hits: [], error: string }     on upstream failure (fail-soft)
 *
 * Errors from the worker (502) or connectivity problems (503) are surfaced as
 * fail-soft: the client always receives { hits: [], error } rather than an
 * unhandled throw, so the search UI can render an inline error instead of
 * crashing.
 *
 * Auth: gated by the same NextAuth session as the rest of the console.
 */
import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { z } from "zod";
import { withRequestContext } from "@/lib/with-request-context";
import { CLUSTER } from "@/lib/cluster-refs";

export const dynamic = "force-dynamic";

const SearchRequestSchema = z.object({
  query: z.string().min(1).max(500),
  sensor: z.string().max(200).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

export const POST = withRequestContext(async function (req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = SearchRequestSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.message }, { status: 400 });
  }

  const body: Record<string, unknown> = { query: parsed.data.query };
  if (parsed.data.sensor) body.sensor = parsed.data.sensor;
  if (parsed.data.limit !== undefined) body.limit = parsed.data.limit;

  try {
    const resp = await fetch(`${CLUSTER.search.url}/search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      return NextResponse.json(
        { hits: [], error: `caption-indexer HTTP ${resp.status}: ${text.slice(0, 300)}` },
        { status: 502 },
      );
    }

    const data = await resp.json();
    return NextResponse.json(data);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { hits: [], error: `caption-indexer unreachable: ${msg}` },
      { status: 503 },
    );
  }
});

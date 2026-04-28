import { NextResponse, type NextRequest } from "next/server";
import { existsSync, readFileSync } from "node:fs";
import { auth } from "@/lib/auth";
import { CLUSTER } from "@/lib/cluster-refs";

export const dynamic = "force-dynamic";

// k8s runtime: alert-worker exposes :9100 via hostPort (k8s/vss/alerts/);
// console reads via the ClusterIP service. ALERT_WORKER_URL overrides.
const ALERT_WORKER_URL = CLUSTER.alertWorker.url;

// docker runtime: the upstream blueprint's alert-bridge (captions →
// incidents filter) only runs in --mode verification (2d_cv). For
// --mode real-time (2d_vlm) we capture rtvi-vlm's caption SSE stream
// directly into a JSONL on a host volume mounted into the console at
// /data; each line is one VLM caption. Set CONSOLE_RUNTIME=docker on
// the deployment to opt in to this path.
const SYNTHETIC_EVENTS_PATH =
  process.env.SYNTHETIC_EVENTS_PATH ?? "/data/synthetic-events.jsonl";

type CaptionsEnvelope = {
  ingestedAt: string;
  streamId: string;
  sensorName: string;
  vlmResponse: {
    id?: string;
    model?: string;
    media_info?: { start_timestamp?: string; end_timestamp?: string };
    chunk_responses?: { start_time?: string; end_time?: string; content?: string }[];
  };
};

/**
 * Read the SSE-captured JSONL on the docker-runtime path and convert each
 * VLM caption into the Incident shape the console renders. The JSONL is
 * append-only; we read up to `limit` most recent entries and reverse so
 * the newest is first. Best-effort: a malformed line is skipped, not fatal.
 */
function readDockerIncidents(limit: number): unknown[] {
  if (!existsSync(SYNTHETIC_EVENTS_PATH)) return [];
  const raw = readFileSync(SYNTHETIC_EVENTS_PATH, "utf8");
  const lines = raw.split("\n").filter(Boolean);
  // Take the last N lines so the response is bounded — the file grows
  // unbounded over the life of the demo (one caption every 5 s).
  const tail = lines.slice(Math.max(0, lines.length - limit));
  const out: unknown[] = [];
  for (const line of tail) {
    let env: CaptionsEnvelope;
    try {
      env = JSON.parse(line) as CaptionsEnvelope;
    } catch {
      continue;
    }
    const chunk = env.vlmResponse?.chunk_responses?.[0];
    if (!chunk?.content) continue;
    out.push({
      ts: env.ingestedAt,
      scenarioId: "synthetic",
      scenarioName: "Synthetic VLM activity",
      severity: "low",
      sensorId: env.sensorName,
      topic: "mdx-vlm",
      summary: chunk.content,
      raw: env.vlmResponse,
    });
  }
  // newest first
  return out.reverse();
}

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const limit = parseInt(req.nextUrl.searchParams.get("limit") ?? "50", 10);
  const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.min(limit, 500) : 50;

  if (process.env.CONSOLE_RUNTIME === "docker") {
    const incidents = readDockerIncidents(safeLimit);
    return NextResponse.json({ incidents });
  }

  try {
    const resp = await fetch(
      `${ALERT_WORKER_URL}/api/incidents/recent?limit=${encodeURIComponent(String(safeLimit))}`,
      {
        next: { revalidate: 0 },
        signal: AbortSignal.timeout(5_000),
      }
    );

    if (!resp.ok) {
      return NextResponse.json(
        { error: `alert-worker returned HTTP ${resp.status}`, incidents: [] },
        { status: 502 }
      );
    }

    const data = await resp.json();
    return NextResponse.json(data);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: `alert-worker unreachable: ${msg}`, incidents: [] },
      { status: 503 }
    );
  }
}

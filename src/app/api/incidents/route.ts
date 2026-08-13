import { NextResponse, type NextRequest } from "next/server";
import { existsSync, readFileSync } from "node:fs";
import { auth } from "@/lib/auth";
import { CLUSTER } from "@/lib/cluster-refs";
import { fromAlertBridge } from "@/lib/helpers/incident-wire";

export const dynamic = "force-dynamic";

// k8s runtime: incidents come from the realtime alert-bridge
// (vss-alert-bridge) GET /api/v1/realtime/incidents — it's the service that
// actually produces incidents (into ES) for live RTSP alert rules. The older
// ALERT_WORKER_URL (vss-video-analytics-api) has no /api/incidents endpoint.
const ALERT_BRIDGE_URL = CLUSTER.alertBridge.url;

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

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const limit = parseInt(req.nextUrl.searchParams.get("limit") ?? "50", 10);
  const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.min(limit, 500) : 50;


  try {
    const resp = await fetch(
      `${ALERT_BRIDGE_URL}/api/v1/realtime/incidents?limit=${encodeURIComponent(String(safeLimit))}`,
      {
        next: { revalidate: 0 },
        signal: AbortSignal.timeout(5_000),
      }
    );

    if (!resp.ok) {
      return NextResponse.json(
        { error: `alert-bridge returned HTTP ${resp.status}`, incidents: [] },
        { status: 502 }
      );
    }

    // alert-bridge wraps the list: { status, incidents: [...], count, total }.
    const data = await resp.json();
    const list: unknown[] = Array.isArray(data)
      ? data
      : Array.isArray(data?.incidents)
        ? (data.incidents as unknown[])
        : [];
    return NextResponse.json({ incidents: list.map(fromAlertBridge) });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: `alert-bridge unreachable: ${msg}`, incidents: [] },
      { status: 503 }
    );
  }
}

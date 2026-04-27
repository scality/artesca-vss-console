import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { CLUSTER } from "@/lib/cluster-refs";

export const dynamic = "force-dynamic";

// alert-worker exposes :9100 via hostPort (k8s/vss/alerts/20-alert-worker.yaml).
// The console uses the ClusterIP service name.  If no ClusterIP Service exists
// for alert-worker, operators must override ALERT_WORKER_URL with the node IP.
// Flag: ASSUMED — confirm that a ClusterIP Service for alert-worker exists at deploy.
const ALERT_WORKER_URL = CLUSTER.alertWorker.url;

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const limit = req.nextUrl.searchParams.get("limit") ?? "50";

  try {
    const resp = await fetch(
      `${ALERT_WORKER_URL}/api/incidents/recent?limit=${encodeURIComponent(limit)}`,
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

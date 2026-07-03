// GET /api/incidents/live
// SSE: stream realtime incidents to connected operators.
//
// The realtime alert-bridge (vss-alert-bridge) writes incidents to
// Elasticsearch and serves them at /api/v1/realtime/incidents — it does NOT
// publish them to any Kafka topic, so this SSE POLLS the bridge and pushes
// newly-seen incidents (rather than consuming Kafka). The first poll primes the
// seen-set without emitting (latest-only semantics — the page's initial
// GET /api/incidents already rendered the backlog).
// Auth required.

import { type NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { CLUSTER } from "@/lib/cluster-refs";
import { createSseResponse } from "@/lib/streams/sse";
import { IncidentSchema } from "@/lib/schemas";
import { fromAlertBridge, alertBridgeIncidentKey } from "@/lib/helpers/incident-wire";
import type { Incident } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ALERT_BRIDGE_URL = CLUSTER.alertBridge.url;
const POLL_MS = 4_000;
const SEEN_CAP = 2_000;

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return createSseResponse<Incident>(req.signal, async (write) => {
    const seen = new Set<string>();
    let primed = false;

    const poll = async () => {
      try {
        const resp = await fetch(
          `${ALERT_BRIDGE_URL}/api/v1/realtime/incidents?limit=50`,
          {
            // Bound each poll so a slow/unreachable bridge can't stall the
            // stream open (the initial poll is awaited before the interval).
            signal: AbortSignal.any([req.signal, AbortSignal.timeout(POLL_MS)]),
            next: { revalidate: 0 },
          }
        );
        if (!resp.ok) return;
        const data = await resp.json();
        const list: unknown[] = Array.isArray(data)
          ? data
          : Array.isArray(data?.incidents)
            ? (data.incidents as unknown[])
            : [];
        // Oldest-first so events arrive in chronological order.
        for (const raw of [...list].reverse()) {
          const key = alertBridgeIncidentKey(raw);
          if (seen.has(key)) continue;
          seen.add(key);
          if (!primed) continue; // first pass: record only, don't replay the backlog
          const result = IncidentSchema.safeParse(fromAlertBridge(raw));
          if (result.success) write(result.data as Incident);
        }
        primed = true;
        // Bound memory on long-lived connections (oldest keys first; the live
        // window of incidents is always re-added so it's never pruned).
        if (seen.size > SEEN_CAP) {
          for (const k of [...seen].slice(0, seen.size - SEEN_CAP)) seen.delete(k);
        }
      } catch {
        // Transient (bridge blip / request abort) — the next tick retries.
      }
    };

    await poll();
    const interval = setInterval(poll, POLL_MS);
    return () => clearInterval(interval);
  });
}

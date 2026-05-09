import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// Liveness probe — no auth required. Used by K8s readinessProbe and the
// Scality menubar health-check.
export function GET() {
  return NextResponse.json({
    ok: true,
    ts: new Date().toISOString(),
    version: process.env.NEXT_PUBLIC_VERSION ?? "dev",
  });
}

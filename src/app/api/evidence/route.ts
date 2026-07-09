/**
 * GET  /api/evidence          → list sealed immutable-evidence clips.
 * POST /api/evidence          → seal a clip: { sensor, ts, incidentId?, scenarioName?, retentionDays?, mode? }.
 *
 * Backs the /evidence page. Auth-gated. Sealing writes the incident's clip to
 * an ARTESCA Object-Lock bucket with retention (WORM).
 */
import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { z } from "zod";
import { withRequestContext } from "@/lib/with-request-context";
import { listEvidence, sealClip } from "@/lib/evidence";

export const dynamic = "force-dynamic";

const SealSchema = z.object({
  sensor: z.string().min(1).max(120),
  ts: z.string().min(1).max(40),
  incidentId: z.string().max(200).optional(),
  scenarioName: z.string().max(120).optional(),
  retentionDays: z.number().int().min(1).max(3650).optional(),
  mode: z.enum(["GOVERNANCE", "COMPLIANCE"]).optional(),
});

export const GET = withRequestContext(async function (_req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    return NextResponse.json({ items: await listEvidence() });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ items: [], error: msg }, { status: 502 });
  }
});

export const POST = withRequestContext(async function (req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const parsed = SealSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.message }, { status: 400 });
  try {
    return NextResponse.json({ ok: true, ...(await sealClip(parsed.data)) });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 502 });
  }
});

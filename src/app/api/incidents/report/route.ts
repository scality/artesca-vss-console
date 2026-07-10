/**
 * POST /api/incidents/report — generate (or reuse a cached) synthesized
 * markdown incident report for a single incident: Overview / Location /
 * Involved parties & vehicles / Timeline / Evidence, produced by the
 * currently-wired LLM (same LLM_BASE_URL/LLM_NAME/LLM_MODEL_TYPE the /agent
 * page configures) from the incident's VLM reasoning text + metadata, with a
 * deterministic fallback if the LLM is unreachable. Persists to SQLite so a
 * repeat view of the same incident doesn't re-call the LLM.
 *
 * GET /api/incidents/report — read back a previously generated report
 * without generating one, for a plain "has this incident already been
 * reported on" check (used before showing a "Generate" vs "View" affordance).
 *
 * Thin auth + JSON wrapper around src/lib/incident-report.ts, same split as
 * the other write routes (see api/evidence, api/agent-config).
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { withRequestContext } from "@/lib/with-request-context";
import { rejectIfKiosk } from "@/lib/kiosk-server";
import { auditLog } from "@/lib/helpers/audit";
import { generateIncidentReport } from "@/lib/incident-report";
import { loadIncidentReport } from "@/lib/db";

export const dynamic = "force-dynamic";

const ReportRequestSchema = z.object({
  sensorId: z.string().min(1).max(200),
  ts: z.string().min(1).max(40),
  raw: z.unknown().optional(),
  force: z.boolean().optional(),
});

export const POST = withRequestContext(async function (req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const blocked = await rejectIfKiosk();
  if (blocked) return blocked;

  const parsed = ReportRequestSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.message }, { status: 400 });
  }
  const { sensorId, ts, raw, force } = parsed.data;

  try {
    const result = await generateIncidentReport({ sensorId, ts, raw, force });
    if (!result.cached) {
      await auditLog("incident-report-generate", `incident/${sensorId}/${ts}`, {
        frameCount: result.frames.length,
        hasClip: !!result.clipUrl,
        warningCount: result.warnings?.length ?? 0,
      });
    }
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: `report generation failed: ${msg}` }, { status: 502 });
  }
});

export const GET = withRequestContext(async function (req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const sp = req.nextUrl.searchParams;
  const sensorId = sp.get("sensorId");
  const ts = sp.get("ts");
  if (!sensorId || !ts) {
    return NextResponse.json(
      { error: "sensorId and ts query params are required" },
      { status: 400 },
    );
  }

  try {
    const row = loadIncidentReport(sensorId, ts);
    if (!row) return NextResponse.json({ ok: false });
    return NextResponse.json({
      ok: true,
      markdown: row.markdown,
      frames: row.frames,
      ...(row.clipUrl ? { clipUrl: row.clipUrl } : {}),
      cached: true,
      generatedAt: row.generatedAt,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 502 });
  }
});

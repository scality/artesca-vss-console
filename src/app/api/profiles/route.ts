import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { z } from "zod";
import { rejectIfKiosk } from "@/lib/kiosk-server";
import { listProfiles, saveProfile } from "@/lib/db";
import { DemoProfileSchema } from "@/lib/schemas";
import { auditLog } from "@/lib/helpers/audit";
import { withRequestContext } from "@/lib/with-request-context";

export const dynamic = "force-dynamic";

// ─── GET — list profiles ───────────────────────────────────────────────────────

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const profiles = listProfiles();
  return NextResponse.json({ profiles });
}

// ─── POST — save current config as new profile ─────────────────────────────────

const SaveProfileSchema = DemoProfileSchema.omit({ savedAt: true, savedBy: true });

export const POST = withRequestContext(async function (req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const blocked = await rejectIfKiosk();
  if (blocked) return blocked;

  const body = await req.json().catch(() => null);
  const parsed = SaveProfileSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Validation failed", issues: parsed.error.issues }, { status: 400 });
  }

  const operator = session.user?.name ?? session.user?.email ?? "console-operator";
  const savedAt = new Date().toISOString();

  const profile = DemoProfileSchema.parse({
    ...parsed.data,
    savedAt,
    savedBy: operator,
  });

  try {
    saveProfile(profile, operator);
  } catch (err) {
    return NextResponse.json({ error: `Failed to save profile: ${String(err)}` }, { status: 500 });
  }

  await auditLog("profile-save", `profile/${profile.name}`, { name: profile.name });

  return NextResponse.json({ ok: true, name: profile.name, savedAt });
});

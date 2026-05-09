import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { z } from "zod";
import { randomUUID } from "crypto";
import { rejectIfKiosk } from "@/lib/kiosk-server";
import { listSgEntries, upsertSgEntry } from "@/lib/db";
import { authorizeSgIngress } from "@/lib/aws";
import { auditLog } from "@/lib/helpers/audit";

export const dynamic = "force-dynamic";

function isValidCidr(cidr: string): boolean {
  const m = cidr.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\/(\d{1,2}))?$/);
  if (!m) return false;
  const [, a, b, c, d, prefix] = m;
  for (const o of [a, b, c, d]) if (Number(o) > 255) return false;
  if (prefix !== undefined && Number(prefix) > 32) return false;
  return true;
}

// ─── GET — list whitelist entries ──────────────────────────────────────────────

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const entries = listSgEntries();
  return NextResponse.json({ entries });
}

// ─── POST — add a new CIDR entry ───────────────────────────────────────────────

const AddSgEntrySchema = z.object({
  cidr: z
    .string()
    .min(1)
    .refine(isValidCidr, "Must be a valid IPv4 CIDR (e.g., 1.2.3.4/32)"),
  label: z.string().min(1).max(100),
});

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const blocked = await rejectIfKiosk();
  if (blocked) return blocked;

  const body = await req.json().catch(() => null);
  const parsed = AddSgEntrySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Validation failed", issues: parsed.error.issues }, { status: 400 });
  }

  const { cidr, label } = parsed.data;
  const operator = session.user?.name ?? session.user?.email ?? "unknown";

  const sgId = process.env.CONSOLE_SG_ID;
  if (!sgId) {
    return NextResponse.json({ error: "CONSOLE_SG_ID env var not configured" }, { status: 500 });
  }

  // Authorize in AWS SG
  try {
    await authorizeSgIngress(sgId, cidr, 8800);
  } catch (err: unknown) {
    const awsErr = err as { name?: string; message?: string };
    // Ignore "already exists" errors
    if (awsErr.name !== "InvalidPermission.Duplicate") {
      console.error("[sg-write] aws error", err);
      return NextResponse.json(
        { error: "AWS rejected the rule (check IAM and SG state)" },
        { status: 502 }
      );
    }
  }

  // Persist in SQLite
  const entry = {
    id: randomUUID(),
    cidr,
    label,
    addedBy: operator,
    addedAt: new Date().toISOString(),
    port: 8800 as const,
  };

  upsertSgEntry(entry);

  await auditLog("sg-add", `sg/${sgId}/ingress`, { cidr, label, port: 8800 });

  return NextResponse.json({ ok: true, entry });
}

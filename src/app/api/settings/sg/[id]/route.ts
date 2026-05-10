import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { listSgEntries, deleteSgEntry } from "@/lib/db";
import { rejectIfKiosk } from "@/lib/kiosk-server";
import { revokeSgIngress } from "@/lib/aws";
import { auditLog } from "@/lib/helpers/audit";
import { createLogger } from "@/lib/logger";

const log = createLogger("api/settings/sg/[id]");

export const dynamic = "force-dynamic";

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const blocked = await rejectIfKiosk();
  if (blocked) return blocked;

  const { id } = await params;

  // Look up the entry in SQLite
  const entries = listSgEntries();
  const entry = entries.find((e) => e.id === id);

  if (!entry) {
    return NextResponse.json({ error: `SG entry ${id} not found` }, { status: 404 });
  }

  const sgId = process.env.CONSOLE_SG_ID;
  if (!sgId) {
    return NextResponse.json({ error: "CONSOLE_SG_ID env var not configured" }, { status: 500 });
  }

  // Revoke in AWS SG
  try {
    await revokeSgIngress(sgId, entry.cidr, entry.port);
  } catch (err: unknown) {
    const awsErr = err as { name?: string; message?: string };
    // Ignore "not found" errors — rule may already be gone
    if (awsErr.name !== "InvalidPermission.NotFound") {
      log.error("sg-write aws error", { err });
      return NextResponse.json(
        { error: "AWS rejected the rule (check IAM and SG state)" },
        { status: 502 }
      );
    }
  }

  // Remove from SQLite
  deleteSgEntry(id);

  await auditLog("sg-remove", `sg/${sgId}/ingress`, {
    cidr: entry.cidr,
    label: entry.label,
    port: entry.port,
  });

  return NextResponse.json({ ok: true, id });
}

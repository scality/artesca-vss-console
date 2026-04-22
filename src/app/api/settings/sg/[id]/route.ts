import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { listSgEntries, deleteSgEntry } from "@/lib/db";
import { revokeSgIngress } from "@/lib/aws";
import { auditLog } from "@/lib/helpers/audit";

export const dynamic = "force-dynamic";

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

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
      return NextResponse.json(
        { error: `AWS SG revoke failed: ${awsErr.message ?? String(err)}` },
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
